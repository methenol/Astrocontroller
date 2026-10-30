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
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
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

// Every known device service, each forwarded to the same local port. Two tunnel
// sessions mirror the app's control/bulk split. Add a line to forward more.
struct portmap {
    unsigned short port;
    int channel;       // 0 = control, 1 = bulk
    int mapped;        // what PortMapping returned (>= 0 is success); StopPortMapping takes the session
};
static struct portmap PORTS[] = {
    { 4700,  0, -1 },   // JSON-RPC control
    { 4350,  0, -1 },   // firmware control
    { 80,    1, -1 },   // nginx file/image server
    { 4801,  1, -1 },   // file-management API
    { 4800,  1, -1 },   // image stream
    { 4804,  1, -1 },   // wide-lens image stream
    { 4554,  1, -1 },   // telephoto RTSP video
    { 4555,  1, -1 },   // wide-lens RTSP video
    { 4361,  1, -1 },   // firmware upload
    { 445,   1, -1 },   // Samba (images share)
    { 22,    1, -1 },   // OpenSSH
    { 32323, 1, -1 },   // ASCOM Alpaca
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

// A signal ends the hold loop so teardown runs before the process exits.
static volatile sig_atomic_t g_stop;
static void on_signal(int signo) { (void)signo; g_stop = 1; }

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
    if (!set_license || !alive || !tun_init2 || !tun_connect_ex || !port_mapping)
        return 1;

    // Init order mirrors the app's TutkConnectionEngine (license -> keepalive
    // -> tunnel agent); doing it differently makes the tunnel layer fail.
    if (set_license(lic) != 0) { fprintf(stderr, "[!] license rejected\n"); return 1; }
    alive(30);
    if (tun_init2(4, 1) != 0) { fprintf(stderr, "[!] tunnel init failed\n"); return 1; }

    int nchan = 1;   // one session: every port on it
    int chan_sid[2] = { -1, -1 };

    // Open the session every port rides on. The first Connect_Ex after a session ended routinely
    // fails (-42, -60) while the rendezvous server and the scope sort out who holds it, and the
    // same call a few seconds later comes straight up in seconds. Asking again here keeps the
    // session we were given; handing it back and allocating a new one is what keeps the -42s coming.
    printf("[*] opening tunnel to %.4s... (%d sessions)\n", uid, nchan);
    int tries = env_int("TUTK_CONNECT_TRIES", 3, 1, 6);
    int pause_s = env_int("TUTK_CONNECT_PAUSE_S", 3, 0, 60);
    for (int i = 0; i < nchan; i++) {
        for (int try_ = 1; try_ <= tries && !g_stop; try_++) {
            chan_sid[i] = tun_connect_ex(uid, tunnel_auth_cb, NULL);
            if (chan_sid[i] >= 0) break;
            fprintf(stderr, "[!] Connect_Ex failed: %d%s\n", chan_sid[i],
                    try_ < tries && !g_stop ? " (retrying)" : "");
            for (int s = 0; s < pause_s && !g_stop; s++) sleep(1);
        }
        if (chan_sid[i] < 0) {
            if (i == 0) return 1;
            nchan = 1;
            break;
        }
        if (check_ex) print_mode(check_ex, chan_sid[i]);
    }

    // Map each port onto its channel; a single failure is reported, not fatal.
    printf("[*] forwarding %d ports:\n", NPORTS);
    int mapped = 0;
    for (int i = 0; i < NPORTS; i++) {
        int ci = PORTS[i].channel >= nchan ? nchan - 1 : PORTS[i].channel;
        PORTS[i].mapped = port_mapping(chan_sid[ci], PORTS[i].port, PORTS[i].port);
        int ok = PORTS[i].mapped >= 0;
        if (ok) mapped++;
        printf("    127.0.0.1:%-5u -> device:%-5u  %s\n",
               PORTS[i].port, PORTS[i].port, ok ? "ok" : "FAILED");
    }
    if (mapped == 0) { fprintf(stderr, "[!] no port mappings succeeded\n"); return 1; }

    sleep(1);   // the mapping accept loops run on SDK threads
    for (int i = 0; i < NPORTS; i++) {
        if (PORTS[i].port == 4700 && PORTS[i].mapped >= 0) {
            control_selftest(PORTS[i].port);
            break;
        }
    }

    printf("[*] tunnel ready - press Ctrl-C to disconnect\n");

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
    }

    // Teardown in the app's order: stop mappings, then abort/disconnect sessions.
    printf("[*] releasing tunnel\n");
    // StopPortMapping takes the SESSION, not a per-port handle: the SDK walks off the end of its
    // own table with anything else, which is the SIGSEGV this used to take on teardown.
    for (int i = 0; i < nchan; i++) {
        if (chan_sid[i] >= 0 && stop_mapping) stop_mapping(chan_sid[i]);
    }
    for (int i = 0; i < nchan; i++) {
        if (chan_sid[i] < 0) continue;
        if (tun_abort) tun_abort(chan_sid[i], 0);
        if (tun_disconnect) tun_disconnect(chan_sid[i]);
    }
    if (tun_deinit) tun_deinit();
    // 3 = the P2P session went away (see EXIT_SESSION_LOST in src/supervisor.py); 0 = asked to stop.
    return lost ? 3 : 0;
}
