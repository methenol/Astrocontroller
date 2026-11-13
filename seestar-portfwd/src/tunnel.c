/*
 * Seestar Kalay tunnel.
 *
 * Drives the ZWO app's own ARM TUTK/Kalay libraries (under qemu-arm) to open a
 * P2P session to the telescope and forward its ports to matching local ports.
 * Credentials come from the environment; the entrypoint fetches them from the
 * user's ZWO account: TUTK_UID, TUTK_SDK_LICENSE, TUTK_USERNAME, TUTK_PASSWORD.
 */

#include <arpa/inet.h>
#include <dlfcn.h>

#ifndef TUTK_SUFFIX
#define TUTK_SUFFIX ""
#endif
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static void *h_global, *h_iotc, *h_tunnel;

// dlsym with a warning on miss, so a missing export degrades to a clear message.
static void *sym(void *h, const char *name) {
    void *p = dlsym(h, name);
    if (!p) fprintf(stderr, "  [!] symbol not found: %s\n", name);
    return p;
}

// The credentials the auth callback hands to the SDK (set from the env in main).
static const char *g_user, *g_pass;

// strncpy that never overflows and always NUL-terminates when there is room.
static void copy_bounded(char *out, size_t bufsize, const char *src) {
    size_t n = strlen(src);
    if (n > bufsize) n = bufsize;
    memcpy(out, src, n);
    if (n < bufsize) out[n] = '\0';
}

// The SDK calls this to obtain the tunnel username/password during Connect_Ex.
// Arg types are `unsigned` to match the recovered SDK callback ABI.
static void tunnel_auth_cb(char *user_out, unsigned user_bufsize,
                           char *pass_out, unsigned pass_bufsize, void *arg) {
    (void)arg;
    copy_bounded(user_out, user_bufsize, g_user);
    copy_bounded(pass_out, pass_bufsize, g_pass);
}

// We read only two fields out of the SDK's 160-byte St_SInfoEx by offset (Mode
// at 4, RemoteIP at 27), rather than mirroring the whole packed struct.
#define SINFO_SIZE 160

static const char *mode_name(unsigned char m) {
    switch (m) {
    case 0:  return "P2P (direct)";
    case 1:  return "RELAY (via ThroughTek relay)";
    case 2:  return "LAN";
    default: return "connecting";
    }
}

// Log whether a session is direct P2P, relayed, or LAN, plus the remote IP.
static void print_mode(int (*check_ex)(int, void *), int sid) {
    unsigned char info[SINFO_SIZE];
    memset(info, 0, sizeof(info));
    *(unsigned int *)info = SINFO_SIZE;
    if (check_ex(sid, info) == 0)
        printf("    mode %s, remote %.47s\n", mode_name(info[4]), (char *)info + 27);
}

// One JSON-RPC round trip over a forwarded port, to confirm control reaches it.
static int control_selftest(unsigned short port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_port = htons(port);
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) < 0) { close(fd); return -1; }
    const char *req = "{\"id\":1,\"method\":\"test_connection\"}\r\n";
    if (send(fd, req, strlen(req), 0) < 0) { close(fd); return -1; }

    char buf[1024];
    ssize_t got = recv(fd, buf, sizeof(buf) - 1, 0);
    close(fd);
    if (got <= 0) return -1;
    buf[got] = '\0';
    while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == '\r'))
        buf[--got] = '\0';
    printf("[*] control self-test OK: %s\n", buf);
    return 0;
}

// Every known device service, each forwarded to the same local port (plus TUTK_PORT_OFFSET). Two tunnel
// sessions mirror the app's control/bulk split. Add a line to forward more.
struct portmap {
    unsigned short port;
    int channel;       // 0 = control, 1 = bulk (pictures, video), 2 = files (falls back to bulk), 3 = a second file route
    int mapped;        // what PortMapping returned (>= 0 is success); StopPortMapping takes the session
    unsigned short local;  // local port (before TUTK_PORT_OFFSET) when not the device port; 0 = the same
    int only;          // 1 = map only when its own session is open (no fallback onto another)
};
static struct portmap PORTS[] = {
    { 4700,  0, -1 },   // JSON-RPC control
    { 4350,  0, -1 },   // firmware control
    { 80,    2, -1 },   // nginx file/image server
    { 4801,  2, -1 },   // file-management API
    { 4800,  1, -1 },   // image stream
    { 4804,  1, -1 },   // wide-lens image stream
    { 4554,  1, -1 },   // telephoto RTSP video
    { 4555,  1, -1 },   // wide-lens RTSP video
    { 4361,  1, -1 },   // firmware upload
    { 445,   1, -1 },   // Samba (images share)
    { 22,    1, -1 },   // OpenSSH
    { 32323, 1, -1 },   // ASCOM Alpaca
    // The file server once more, on a fourth session, as local port 81: one session carried HTTP
    // at ~250-290 KB/s however many downloads shared it, while the link had room for three times
    // that (2026-11-12), so the library spreads its downloads over both routes.
    { 80,    3, -1, 81, 1 },
};
// Other ports seen listening on the device, investigated and not forwarded:
//   4701/4702  duplicate zwoair_imager JSON-RPC listeners (same as 4700)
//   4030/4500  zwoair_guider serial-bridge/binary-frame
//   4040       zwoair_guider, unidentified JSON-RPC method set
//   4400       zwoair_guider PHD2-style control API
//   3893       zwoair_imager, internal RTSP-pipeline
#define NPORTS ((int)(sizeof(PORTS) / sizeof(PORTS[0])))

// An integer env var with a floor and a ceiling, so a typo cannot make the tunnel useless.
static int env_int(const char *name, int dflt, int lo, int hi) {
    const char *e = getenv(name);
    if (!e || !*e) return dflt;
    int v = atoi(e);
    return v < lo ? lo : (v > hi ? hi : v);
}

static int hold_seconds(void) {
    return env_int("TUTK_HOLD_SECONDS", 86400, 1, 86400);
}

// The SDK's own log (TUTK_LOG_DIR, verbose) says which step of a connect failed: master login,
// hole punch or relay. It is dumped to stdout after a refused Connect_Ex (newest 300 lines that
// are not handshake chatter) and the full file of that try is kept next to it.
struct log_attr { int level; const char *path; int file_max_size; int file_max_count; };
static char g_log_dir[256];
// Lines the SDK repeats every 100-200 ms that say nothing about why a connect failed.
static int sdk_line_is_noise(const char *l) {
    static const char *noise[] = {
        "_IOTC_Send_Search", "SCHL", "MSG_P2P_REQUEST_RECORD", "UDPQueryDeviceInfoTaskCB",
        "iotcRecordSendMasterHandshake", "ReleaseTunnelInfo", "Send MSG_P2P_KNOCK",
        "MSG_P2P_KNOCK_RR", "Send broadcast", "PUBLIC KEY", "hwIDAQAB",
    };
    for (unsigned i = 0; i < sizeof(noise) / sizeof(noise[0]); i++)
        if (strstr(l, noise[i])) return 1;
    return 0;
}

static int g_dump_no;
static void dump_sdk_logs(void) {
    static const char *names[] = { "tutk_global.log", "tutk_iotc.log", "tutk_p2pTunnel.log" };
    enum { KEEP = 300 };
    g_dump_no++;
    for (unsigned n = 0; n < sizeof(names) / sizeof(names[0]); n++) {
        char path[512], kept[512];
        snprintf(path, sizeof(path), "%s/%s", g_log_dir, names[n]);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        // the whole file of this try is kept as <name>.<try> (docker cp it out for a full read);
        // the dump on stdout is the newest 300 lines that are not repeated handshake chatter
        snprintf(kept, sizeof(kept), "%s/%s.%d", g_log_dir, names[n], g_dump_no);
        FILE *k = fopen(kept, "w");
        char *lines[KEEP] = { 0 };
        int count = 0, total = 0;
        char buf[512];
        while (fgets(buf, sizeof(buf), f)) {
            total++;
            if (k) fputs(buf, k);
            if (sdk_line_is_noise(buf)) continue;
            free(lines[count % KEEP]);
            lines[count % KEEP] = strdup(buf);
            count++;
        }
        fclose(f);
        if (k) fclose(k);
        printf("[sdk] ---- %s (%d lines, %d shown; full copy %s)\n", names[n], total,
               count > KEEP ? KEEP : count, kept);
        for (int i = count > KEEP ? count - KEEP : 0; i < count; i++) {
            char *l = lines[i % KEEP];
            if (!l) continue;
            size_t len = strlen(l);
            while (len && (l[len - 1] == '\n' || l[len - 1] == '\r')) l[--len] = 0;
            printf("[sdk] %s\n", l);
        }
        for (int i = 0; i < KEEP; i++) free(lines[i]);
        // start the next attempt's log afresh so the dump stays about one attempt
        FILE *t = fopen(path, "w");
        if (t) fclose(t);
    }
}

// The dial watchdog. Whether a Connect_Ex will succeed is settled within ~2 s of the call, but
// one that will not blocks for 62-64 s before it answers -42 (6 of 36 dials connected, in 6-18 s;
// every other one took 62-64 s, 2026-11-13). The SDK's own log shows why:
//  * After PRECHECK it sends P2P_REQUEST only to the first P2P server in the list the master
//    handed out, and the master lists its three servers in random order. Two of them
//    (223.108.144.62, 119.45.181.137) do not answer from some networks at all, so two dials in
//    three asked a dead server and waited out the timeout. The one that answers sends PUNCH_TO
//    within 0.2 s.
//  * Sometimes the SDK sends its UDP master query to a garbage address (a negative index into its
//    server table). It then knows only one mapping of ours, reports MyNAT[0] instead of the
//    symmetric NAT it is behind, and does a plain hole punch, which gets nothing back.
// Each new process gets a fresh list order, so a lost dial is cut short here and the supervisor
// dials again at once, instead of after a minute. The watchdog only reads the log; it stops
// watching once the scope's knock is seen (the punch got through) or Connect_Ex returns.
// TUTK_DIAL_WATCH=0 turns it off.
#define EXIT_DIAL_LOST 4
static volatile int g_dial_done;

static double mono_s(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

// The integer after `key` in `l` ("MyNAT[" -> 3), or -1.
static int field_int(const char *l, const char *key) {
    const char *p = strstr(l, key);
    return p ? atoi(p + strlen(key)) : -1;
}

static void dial_lost(double t0, const char *why) {
    fprintf(stderr, "[!] Connect_Ex abandoned after %.1f s: %s\n", mono_s() - t0, why);
    // keep the log of the lost dial for a read (docker cp), then start the next one afresh
    char path[512], kept[512];
    snprintf(path, sizeof(path), "%s/tutk_iotc.log", g_log_dir);
    snprintf(kept, sizeof(kept), "%s/tutk_iotc.log.lost.%d", g_log_dir, (int)getpid());
    rename(path, kept);
    fflush(NULL);
    _exit(EXIT_DIAL_LOST);   // no session exists yet: nothing to tear down
}

static void *dial_watch(void *arg) {
    double t0 = *(double *)arg;
    double request_wait = env_int("TUTK_REQUEST_WAIT_S", 15, 2, 120);
    double punch_wait = env_int("TUTK_PUNCH_WAIT_S", 4, 1, 60);
    // the Type-3 (symmetric NAT) punch got its first knock back 9 s after PUNCH_TO; a plain punch
    // (MyNAT[0]) that has nothing back after 8 s never got anything
    double knock_wait = env_int("TUTK_KNOCK_WAIT_S", 25, 2, 120);
    double knock_wait_unknown = env_int("TUTK_KNOCK_WAIT_UNKNOWN_NAT_S", 8, 2, 120);
    char path[512];
    snprintf(path, sizeof(path), "%s/tutk_iotc.log", g_log_dir);
    double t_req = 0, t_punch = 0;
    int my_nat = -1;
    char server[80] = "?";
    long off = -1;
    char line[2048];
    while (!g_dial_done) {
        FILE *f = fopen(path, "r");
        if (f) {
            fseek(f, 0, SEEK_END);
            long size = ftell(f);
            if (off < 0 || size < off) off = off < 0 ? size : 0;   // start at EOF; restart if truncated
            fseek(f, off, SEEK_SET);
            while (fgets(line, sizeof(line), f)) {
                size_t n = strlen(line);
                if (n && line[n - 1] != '\n' && n < sizeof(line) - 1) break;   // half-written line
                off = ftell(f);
                if (strstr(line, "MSG = MSG_P2P_KNOCK") || strstr(line, "Send MSG_P2P_KNOCK_R") ||
                    strstr(line, "mode is established") || strstr(line, "MSG_CONNECT_RESULT_RECORD")) {
                    fclose(f);
                    return NULL;   // the punch got through (or the SDK is answering anyway)
                }
                if (!t_req && strstr(line, "MSG_P2P_REQUEST_RECORD to P2P[")) {
                    t_req = mono_s();
                    const char *p = strstr(line, "P2P[") + 4, *e = strchr(p, ']');
                    if (e && e - p < (long)sizeof(server)) {
                        memcpy(server, p, (size_t)(e - p));
                        server[e - p] = 0;
                    }
                }
                if (!t_punch && strstr(line, "MSG_P2P_PUNCH_TO_RECORD from")) t_punch = mono_s();
                if (t_punch && my_nat < 0 && strstr(line, "myNAT[")) my_nat = field_int(line, "myNAT[");
            }
            fclose(f);
        }
        double now = mono_s();
        char why[256];
        if (!t_req && now - t0 > request_wait) {
            dial_lost(t0, "no P2P server was asked for the scope (master or precheck never answered)");
        } else if (t_req && !t_punch && now - t_req > punch_wait) {
            snprintf(why, sizeof(why), "the P2P server the master listed first (%s) did not answer "
                     "the request in %.0f s", server, punch_wait);
            dial_lost(t0, why);
        } else if (t_punch && now - t_punch > (my_nat == 0 ? knock_wait_unknown : knock_wait)) {
            snprintf(why, sizeof(why), "the hole punch got nothing back from the scope in %.0f s "
                     "(our NAT as the SDK saw it: %d)", now - t_punch, my_nat);
            dial_lost(t0, why);
        }
        usleep(100 * 1000);
    }
    return NULL;
}

// A signal ends the hold loop so teardown runs before the process exits.
static volatile sig_atomic_t g_stop;
static void on_signal(int signo) { (void)signo; g_stop = 1; }

// A stop asked for on stdin ("q", or the supervisor's end of the pipe closing). A signal delivered
// into this qemu-arm process while the SDK's threads run crashed qemu itself ("QEMU internal
// SIGSEGV", 2026-11-12) before the sessions were closed, so the scope kept a dead session and
// refused the next connect (-42) for ten minutes; read from a pipe, the stop is ordinary code.
static int stop_requested_on_stdin(void) {
    struct pollfd p = { .fd = 0, .events = POLLIN };
    if (poll(&p, 1, 0) <= 0) return 0;
    if (p.revents & (POLLHUP | POLLERR | POLLNVAL)) return 1;
    char c[16];
    ssize_t n = read(0, c, sizeof(c));
    return n <= 0 || memchr(c, 'q', (size_t)n) != NULL;
}

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    const char *uid = getenv("TUTK_UID");
    const char *lic = getenv("TUTK_SDK_LICENSE");
    g_user = getenv("TUTK_USERNAME");
    g_pass = getenv("TUTK_PASSWORD");
    if (!uid || !lic || !g_user || !g_pass) {
        fprintf(stderr, "error: set TUTK_UID, TUTK_SDK_LICENSE, "
                        "TUTK_USERNAME and TUTK_PASSWORD\n");
        return 2;
    }

    // Load in dependency order: the tunnel lib NEEDs the other three.
    // TUTK_SUFFIX "T" selects the newer SDK set the current app loads (libIOTCAPIsT.so, ...).
    h_global = dlopen("libTUTKGlobalAPIs" TUTK_SUFFIX ".so", RTLD_NOW | RTLD_GLOBAL);
    if (!h_global) { fprintf(stderr, "dlopen global: %s\n", dlerror()); return 1; }
    h_iotc = dlopen("libIOTCAPIs" TUTK_SUFFIX ".so", RTLD_NOW | RTLD_GLOBAL);
    if (!h_iotc) { fprintf(stderr, "dlopen iotc: %s\n", dlerror()); return 1; }
    if (!dlopen("libRDTAPIs" TUTK_SUFFIX ".so", RTLD_NOW | RTLD_GLOBAL))
        { fprintf(stderr, "dlopen rdt: %s\n", dlerror()); return 1; }
    h_tunnel = dlopen("libP2PTunnelAPIs" TUTK_SUFFIX ".so", RTLD_NOW | RTLD_GLOBAL);
    if (!h_tunnel) { fprintf(stderr, "dlopen tunnel: %s\n", dlerror()); return 1; }

    // Resolve every SDK entry point we use up front.
    int (*set_license)(const char *) = sym(h_global, "TUTK_SDK_Set_License_Key");
    int (*alive)(unsigned int) = sym(h_iotc, "IOTC_Setup_Session_Alive_Timeout");
    int (*tun_init2)(int, int) = sym(h_tunnel, "P2PTunnelAgentInitialize2");
    int (*check_ex)(int, void *) = sym(h_iotc, "IOTC_Session_Check_Ex");
    int (*tun_connect_ex)(const char *,
                          void (*)(char *, unsigned, char *, unsigned, void *),
                          void *) = sym(h_tunnel, "P2PTunnelAgent_Connect_Ex");
    int (*port_mapping)(int, unsigned, unsigned) =
        sym(h_tunnel, "P2PTunnelAgent_PortMapping");
    int (*stop_mapping)(int) = sym(h_tunnel, "P2PTunnelAgent_StopPortMapping");
    int (*tun_abort)(int, int) = sym(h_tunnel, "P2PTunnelAgent_Abort");
    int (*tun_disconnect)(int) = sym(h_tunnel, "P2PTunnelAgent_Disconnect");
    int (*tun_deinit)(void) = sym(h_tunnel, "P2PTunnelAgentDeInitialize");
    // The app's sanitizeBeforeConnect: cancel a connect still in flight and reset the IOTC
    // socket before every Connect_Ex, including a retry after a refusal.
    int (*tun_connect_stop)(const char *) = sym(h_tunnel, "P2PTunnelAgent_Connect_Stop");
    int (*reinit_socket)(int) = sym(h_iotc, "IOTC_ReInitSocket");
    // Relay everything over TCP instead of punching UDP holes: the only mode that works from
    // behind a symmetric NAT (the hole punch fails with -42/-60 there). Must be set before IOTC
    // comes up, i.e. before the tunnel agent init.
    void (*tcp_relay_only)(void) = sym(h_iotc, "IOTC_TCPRelayOnly_TurnOn");   // returns nothing
    void (*connect_timeout)(unsigned) = sym(h_iotc, "IOTC_Setup_P2PConnection_Timeout");   // returns nothing
    int (*nat_type)(void) = sym(h_iotc, "IOTC_Get_Nat_Type");
    // The app sizes every tunnel session's buffer (P2PTunnel_SetBufSize(sid, 512000), its
    // RemotePortMappingConfig.tunnelBufferSize) before it maps a port; the SDK default is far
    // smaller and throttles the multi-MB live frames on 4800/4804 to well under 1 MB/s.
    int (*set_bufsize)(int, int) = sym(h_tunnel, "P2PTunnel_SetBufSize");
    if (!set_license || !alive || !tun_init2 || !tun_connect_ex || !port_mapping)
        return 1;

    const char *log_dir = getenv("TUTK_LOG_DIR");
    if (log_dir && *log_dir) {
        snprintf(g_log_dir, sizeof(g_log_dir), "%s", log_dir);
        mkdir(log_dir, 0755);
        int (*glog)(struct log_attr) = sym(h_global, "TUTK_Set_Log_Attr");
        int (*ilog)(struct log_attr) = sym(h_iotc, "IOTC_Set_Log_Attr");
        int (*tlog)(struct log_attr) = sym(h_tunnel, "P2PTunnel_Set_Log_Attr");
        static char p1[512], p2[512], p3[512];
        snprintf(p1, sizeof(p1), "%s/tutk_global.log", log_dir);
        snprintf(p2, sizeof(p2), "%s/tutk_iotc.log", log_dir);
        snprintf(p3, sizeof(p3), "%s/tutk_p2pTunnel.log", log_dir);
        struct log_attr a = { env_int("TUTK_LOG_LEVEL", 0, 0, 4), p1, 4 * 1024 * 1024, 1 };
        int rg = glog ? glog(a) : -999;
        a.path = p2; int ri = ilog ? ilog(a) : -999;
        a.path = p3; int rt = tlog ? tlog(a) : -999;
        // the older entry points, in case the attribute struct is not what this build expects
        int (*ipath)(const char *, int) = sym(h_iotc, "IOTC_Set_Log_Path");
        int (*tpath)(const char *, int) = sym(h_tunnel, "P2PTunnelAgent_Set_Log_Path");
        int rip = ipath ? ipath(p2, 4 * 1024 * 1024) : -999;
        int rtp = tpath ? tpath(p3, 4 * 1024 * 1024) : -999;
        printf("[*] SDK log in %s (level %d): attr global %d iotc %d tunnel %d; path iotc %d tunnel %d\n",
               log_dir, a.level, rg, ri, rt, rip, rtp);
    }

    // Init order mirrors the app's TutkConnectionEngine (license -> keepalive
    // -> tunnel agent); doing it differently makes the tunnel layer fail.
    if (set_license(lic) != 0) { fprintf(stderr, "[!] license rejected\n"); return 1; }
    alive(30);
    // A Connect_Ex that is going to work answers in 6-30 s; one the rendezvous cannot complete
    // (-42 IOTC_ER_FAIL_SETUP_RELAY, -60 IOTC_ER_MASTER_NOT_RESPONSE) otherwise blocks for
    // 60-80 s before the retry that usually succeeds. The app leaves the SDK default; 0 keeps it.
    // A refused rendezvous blocks 60-77 s per try: the SDK keeps asking a P2P server that does not
    // answer from here until its own timeout. IOTC_Setup_P2PConnection_Timeout(20) did not shorten
    // that (a refused try still took 62 s, 2026-10-30), so the default leaves it alone (0).
    int connect_s = env_int("TUTK_CONNECT_TIMEOUT_S", 0, 0, 120);
    if (connect_s && connect_timeout) {
        connect_timeout((unsigned)connect_s);
        printf("[*] P2P connect timeout asked: %d s\n", connect_s);
    }
    // IOTC_TCPRelayOnly_TurnOn makes the SDK mark its UDP punch "skip" as soon as the P2P server's
    // PUNCH_TO arrives: the scope's KNOCK_R2 then comes back within a second and is thrown away
    // ("SID status wrong", UDPP2PConnectState[-1]), and the TCP relay it waits for instead never
    // answers from here (-42 after 62 s). The connects that still worked were the ones where the
    // scope's own KNOCK got through first (KNOCK_RR2 path). Default off (2026-10-30 SDK logs).
    if (env_int("TUTK_TCP_RELAY_ONLY", 0, 0, 1) && tcp_relay_only) {
        tcp_relay_only();
        printf("[*] asked for TCP relay (IOTC_TCPRelayOnly_TurnOn)\n");
    }
    if (tun_init2(4, 1) != 0) { fprintf(stderr, "[!] tunnel init failed\n"); return 1; }
    // The app opens two sessions per connection (P2PTunnelAgent_Connect_Ex, then _Second): the
    // control ports on the first, every bulk port on the second, so image traffic never starves
    // the control link. TUTK_SESSIONS=1 puts every port on one session.
    // TUTK_SESSIONS=3 opens a third for the file server: on the bulk session a downloaded file
    // queued behind the live picture stream, which fills that session's window by itself (HTTP's
    // first byte 7-25 s, transfers at a trickle, 2026-11-12). A third session the scope refuses
    // leaves the files on the bulk session, as with 2.
    int nchan = env_int("TUTK_SESSIONS", 2, 1, 4);
    int chan_sid[4] = { -1, -1, -1, -1 };
    int early_ready = 0, early_offset = 0;

    // Open the session every port rides on. The first Connect_Ex after a session ended routinely
    // fails (-42, -60) while the rendezvous server and the scope sort out who holds it, and the
    // same call a few seconds later comes straight up in seconds. Asking again here keeps the
    // session we were given; handing it back and allocating a new one is what keeps the -42s coming.
    printf("[*] opening tunnel to %.4s... (%d sessions)\n", uid, nchan);
    // Every connect that worked today was a process's first Connect_Ex (12 of 12, 2026-10-30); a
    // retry inside the same process kept asking the same P2P server that had not answered. So one
    // try per process by default, and the supervisor dials again with a fresh one.
    int tries = env_int("TUTK_CONNECT_TRIES", 1, 1, 6);
    int pause_s = env_int("TUTK_CONNECT_PAUSE_S", 3, 0, 60);
    for (int i = 0; i < nchan; i++) {
        int busy_retry = 0;   // the app's one quick retry on -30002 (local port in use)
        for (int try_ = 1; try_ <= tries && !g_stop; try_++) {
            // the app sanitises before every Connect_Ex: stop a connect still in flight (a
            // retry's predecessor), then reset the IOTC socket
            if (try_ > 1 && tun_connect_stop) {
                int r = tun_connect_stop(uid);
                printf("    Connect_Stop before retry %d: %d\n", try_, r);
            }
            // ... but only before the FIRST session: the app sanitises once per connect and
            // then calls Connect_Ex twice back to back ("_Second" is just its log prefix). A
            // ReInitSocket between the two resets the socket session 0 lives on, and its port
            // mappings then fail (-55 on every write) while session 1 comes up fine.
            if (reinit_socket && (i == 0 || try_ > 1)) {
                int r = reinit_socket(0);
                if (r != 0) printf("    IOTC_ReInitSocket: %d\n", r);
            }
            // the first session is where the server-list lottery is drawn; the later ones reuse
            // the list that worked for it
            pthread_t watcher;
            int watching = 0;
            static double dial_t0;
            if (i == 0 && g_log_dir[0] && env_int("TUTK_DIAL_WATCH", 1, 0, 1)) {
                g_dial_done = 0;
                dial_t0 = mono_s();
                watching = pthread_create(&watcher, NULL, dial_watch, &dial_t0) == 0;
            }
            chan_sid[i] = tun_connect_ex(uid, tunnel_auth_cb, NULL);
            if (watching) {
                g_dial_done = 1;
                pthread_join(watcher, NULL);
            }
            if (chan_sid[i] >= 0) break;
            if (chan_sid[i] == -30002 && !busy_retry && !g_stop) {
                busy_retry = 1;
                fprintf(stderr, "[!] Connect_Ex failed: -30002 (local port busy, retrying)\n");
                usleep(250 * 1000);
                try_--;
                continue;
            }
            fprintf(stderr, "[!] Connect_Ex failed: %d%s\n", chan_sid[i],
                    try_ < tries && !g_stop ? " (retrying)" : "");
            if (g_log_dir[0]) dump_sdk_logs();
            for (int s = 0; s < pause_s && !g_stop; s++) sleep(1);
        }
        if (chan_sid[i] < 0) {
            if (i == 0) return 1;
            printf("    session %d refused: its ports ride on session %d\n", i, i - 1);
            nchan = i;
            break;
        }
        if (check_ex) print_mode(check_ex, chan_sid[i]);
        if (nat_type) printf("    our NAT type (SDK): %d\n", nat_type());
        int bufsz = env_int("TUTK_TUNNEL_BUFSIZE", 512000, 0, 8 * 1024 * 1024);
        if (bufsz > 0 && set_bufsize) {
            int r = set_bufsize(chan_sid[i], bufsz);
            printf("    P2PTunnel_SetBufSize(%d): %d\n", bufsz, r);
        }
        // TUTK_EARLY_READY=1: map the control ports (they ride on session 0) and say "ready" right
        // here, so the controller talks to the scope while the bulk sessions are still being
        // opened (each is a rendezvous of its own, 6-11 s, and every mapping takes ~1 s under
        // qemu: ~35 s in all). Off by default: with the controller already talking on session 0,
        // qemu died (SIGSEGV) inside the next session's Connect_Ex in one of two tries
        // (2026-11-13), and a crash costs the whole session.
        if (i == 0 && env_int("TUTK_EARLY_READY", 0, 0, 1)) {
            early_offset = env_int("TUTK_PORT_OFFSET", 0, 0, 33000);
            printf("[*] forwarding the control ports first%s:\n", early_offset ? " (offset)" : "");
            for (int p = 0; p < NPORTS; p++) {
                if (PORTS[p].channel != 0) continue;
                unsigned local = (PORTS[p].local ? PORTS[p].local : PORTS[p].port) + (unsigned)early_offset;
                PORTS[p].mapped = port_mapping(chan_sid[0], local, PORTS[p].port);
                if (PORTS[p].mapped >= 0) printf("    127.0.0.1:%-5u -> device:%-5u  ok (session 0)\n", local, PORTS[p].port);
                else printf("    127.0.0.1:%-5u -> device:%-5u  FAILED (%d, session 0)\n", local, PORTS[p].port, PORTS[p].mapped);
                if (PORTS[p].port == 4700 && PORTS[p].mapped >= 0) {
                    usleep(300 * 1000);   // the mapping's accept loop runs on an SDK thread
                    if (control_selftest((unsigned short)(PORTS[p].port + early_offset)) == 0) {
                        printf("[*] tunnel ready - press Ctrl-C to disconnect (bulk sessions still opening)\n");
                        early_ready = 1;
                    }
                }
            }
        }
    }

    // Map each port onto its channel; a single failure is reported, not fatal. TUTK_PORT_OFFSET
    // moves every local port up by that much (device port 4700 -> local 4700 + offset), so several
    // tunnels, one per telescope, can share one network namespace (the multi-tunnel manager in
    // src/supervisor.py gives slot n the offset n*1000). 0 = each port on its own number, as before.
    int offset = env_int("TUTK_PORT_OFFSET", 0, 0, 33000);
    printf("[*] forwarding %d ports%s:\n", NPORTS, offset ? " (offset)" : "");
    int mapped = 0;
    for (int i = 0; i < NPORTS; i++) {
        if (PORTS[i].only && PORTS[i].channel >= nchan) continue;
        if (PORTS[i].channel == 0 && PORTS[i].mapped >= 0) { mapped++; continue; }   // mapped early
        int ci = PORTS[i].channel >= nchan ? nchan - 1 : PORTS[i].channel;
        unsigned local = (PORTS[i].local ? PORTS[i].local : PORTS[i].port) + (unsigned)offset;
        PORTS[i].mapped = port_mapping(chan_sid[ci], local, PORTS[i].port);
        int ok = PORTS[i].mapped >= 0;
        if (ok) mapped++;
        if (ok) printf("    127.0.0.1:%-5u -> device:%-5u  ok (session %d)\n",
                       local, PORTS[i].port, ci);
        else printf("    127.0.0.1:%-5u -> device:%-5u  FAILED (%d, session %d)\n",
                    local, PORTS[i].port, PORTS[i].mapped, ci);
    }
    if (mapped == 0) { fprintf(stderr, "[!] no port mappings succeeded\n"); return 1; }

    if (early_ready) {
        printf("[*] all ports forwarded (%d sessions)\n", nchan);
    } else {
        sleep(1);   // the mapping accept loops run on SDK threads
        for (int i = 0; i < NPORTS; i++) {
            if (PORTS[i].port == 4700 && PORTS[i].mapped >= 0) {
                control_selftest((unsigned short)(PORTS[i].port + offset));
                break;
            }
        }
        printf("[*] tunnel ready - press Ctrl-C to disconnect\n");
    }

    // Hold the session open, polling state each second so a drop is noticed.
    int hold = hold_seconds();
    unsigned char info[SINFO_SIZE];
    // A lost session never comes back (its ports stay open and silent): end the tunnel and say so
    // with the exit code, so the supervisor releases it and opens a new one.
    int lost = 0;
    for (int elapsed = 0; elapsed < hold && !g_stop && !lost; elapsed++) {
        for (int i = 0; i < nchan && check_ex; i++) {
            memset(info, 0, sizeof(info));
            *(unsigned int *)info = SINFO_SIZE;
            if (check_ex(chan_sid[i], info) != 0) {
                printf("[!] session %d lost: ending the tunnel\n", i);
                lost = 1;
            }
        }
        if (!lost) sleep(1);
        if (stop_requested_on_stdin()) g_stop = 1;
    }

    // Teardown: the disconnect is what tells the scope we left, so it goes first. The app's order
    // (StopPortMapping, Abort, then Disconnect) died with a SIGSEGV inside StopPortMapping under
    // qemu on every release, whichever handle it was given (session or mapping index), before any
    // Disconnect was sent (2026-11-12): the scope then kept the dead session and refused the next
    // Connect_Ex (-42) for minutes. Disconnecting a session ends its mappings with it.
    // P2PTunnelAgent_Disconnect crashed the same way (19 s in, nothing printed after it), so the
    // sessions are closed one layer down: IOTC_Session_Close sends the scope the session-close
    // record (the tunnel's SIDs are IOTC SIDs: IOTC_Session_Check_Ex above takes them too), and the
    // process then leaves without the tunnel agent's teardown; the OS closes the sockets.
    (void)stop_mapping;
    (void)tun_abort;
    (void)tun_disconnect;
    (void)tun_deinit;
    int (*session_close)(int) = sym(h_iotc, "IOTC_Session_Close");
    printf("[*] releasing tunnel\n");
    fflush(stdout);
    for (int i = 0; i < nchan; i++) {
        if (chan_sid[i] < 0 || !session_close) continue;
        int r = session_close(chan_sid[i]);
        printf("    session %d closed: %d\n", i, r);
        fflush(stdout);
    }
    usleep(500 * 1000);   // the close records go out on the SDK's socket
    printf("[*] released\n");
    fflush(stdout);
    _exit(lost ? 3 : 0);
    // 3 = the P2P session went away (see EXIT_SESSION_LOST in src/supervisor.py); 0 = asked to stop.
    return lost ? 3 : 0;
}
