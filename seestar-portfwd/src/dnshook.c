/*
 * LD_PRELOAD DNS shim for the TUTK SDK under qemu-arm.
 *
 * bionic can't find a nameserver in a container (no Android property service),
 * so its resolver fails. We override getaddrinfo/gethostbyname to answer A
 * records ourselves over UDP.
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

// Nameserver to query, cached: $DNS_SERVER, else first in resolv.conf, else 1.1.1.1.
static const char *nameserver(void) {
    static char ns[64];
    if (ns[0]) return ns;                                   // cached from a prior call

    const char *env = getenv("DNS_SERVER");
    if (env && *env) { snprintf(ns, sizeof(ns), "%s", env); return ns; }

    FILE *f = fopen("/etc/resolv.conf", "r");               // first `nameserver` line
    if (f) {
        char line[256];
        while (fgets(line, sizeof(line), f))
            if (sscanf(line, "nameserver %63s", ns) == 1) break;
        fclose(f);
    }
    if (!ns[0]) snprintf(ns, sizeof(ns), "1.1.1.1");        // last-resort default
    return ns;
}

/* Encode "a.b.c" as \1a\1b\1c\0 */
static int encode_qname(const char *host, unsigned char *out, size_t outlen) {
    size_t pos = 0;
    const char *p = host;
    while (*p) {
        const char *dot = strchr(p, '.');
        size_t len = dot ? (size_t)(dot - p) : strlen(p);
        if (len == 0 || len > 63 || pos + len + 1 >= outlen) return -1;
        out[pos++] = (unsigned char)len;
        memcpy(out + pos, p, len);
        pos += len;
        if (!dot) break;
        p = dot + 1;
    }
    if (pos + 1 >= outlen) return -1;
    out[pos++] = 0;
    return (int)pos;
}

/* Skip a (possibly compressed) name; returns bytes consumed at `pos`. */
static int skip_name(const unsigned char *msg, int len, int pos) {
    int start = pos;
    while (pos < len) {
        unsigned char c = msg[pos];
        if ((c & 0xC0) == 0xC0) return (pos + 2) - start;
        if (c == 0) return (pos + 1) - start;
        pos += c + 1;
    }
    return -1;
}

#define MAX_ADDRS 8

void freeaddrinfo(struct addrinfo *res);

// DNSHOOK_DEBUG=1 prints every lookup and its answer on stderr (the tunnel's log).
// DNSHOOK_ALL_ADDRS=1 hands the SDK every A record chained on ai_next; by default only the
// first one, the way the shim always did: with the full master list the T SDK answered -42
// (IOTC_ER_FAIL_SETUP_RELAY) for half an hour straight (2026-10-30), with one address it
// connects within minutes.
static int all_addrs_on(void) {
    static int on = -1;
    if (on < 0) { const char *e = getenv("DNSHOOK_ALL_ADDRS"); on = e && *e && *e != '0'; }
    return on;
}

static int debug_on(void) {
    static int on = -1;
    if (on < 0) { const char *e = getenv("DNSHOOK_DEBUG"); on = e && *e && *e != '0'; }
    return on;
}

// The TUTK master name resolves to several servers in round-robin order and the SDK talks to
// whichever one it is handed first. One of them (47.107.189.8, 2026-10-30) does not answer from
// here at all, so every dial that drew it was a guaranteed -60 after 77 s. The shim therefore
// probes the candidates in parallel with a TCP connect to DNSHOOK_PROBE_PORT (80, the port the
// SDK's own _TcpConnectMaster uses) and puts the ones that answer first, fastest first.
// DNSHOOK_PROBE_MS caps the wait (default 1500); DNSHOOK_PROBE=0 turns the probing off.
// DNSHOOK_PREFER="a.b.c.d,..." moves those addresses to the front among the ones that answered.
static int env_num(const char *name, int dflt) {
    const char *e = getenv(name);
    return e && *e ? atoi(e) : dflt;
}

static int probe_on(void) {
    static int on = -1;
    if (on < 0) { const char *e = getenv("DNSHOOK_PROBE"); on = !(e && *e == '0'); }
    return on;
}

static int prefer_rank(struct in_addr a) {
    const char *list = getenv("DNSHOOK_PREFER");
    if (!list || !*list) return 1000;
    const char *want = inet_ntoa(a);
    size_t wl = strlen(want);
    int rank = 0;
    for (const char *p = list; *p; rank++) {
        while (*p == ' ' || *p == ',') p++;
        const char *end = p;
        while (*end && *end != ',' && *end != ' ') end++;
        if ((size_t)(end - p) == wl && strncmp(p, want, wl) == 0) return rank;
        p = end;
    }
    return 1000;
}

// Reorders `addrs` in place: answering servers first by (preference, connect time); the ones
// that did not answer within the cap keep their order at the back.
static void order_by_probe(struct in_addr *addrs, int n) {
    if (n < 2 || !probe_on()) return;
    int port = env_num("DNSHOOK_PROBE_PORT", 80);
    int cap_ms = env_num("DNSHOOK_PROBE_MS", 1500);
    if (cap_ms < 100) cap_ms = 100;
    int fd[MAX_ADDRS];
    long rtt[MAX_ADDRS];
    struct timeval t0;
    gettimeofday(&t0, NULL);
    for (int i = 0; i < n; i++) {
        rtt[i] = -1;
        fd[i] = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
        if (fd[i] < 0) continue;
        struct sockaddr_in sa;
        memset(&sa, 0, sizeof(sa));
        sa.sin_family = AF_INET;
        sa.sin_port = htons((unsigned short)port);
        sa.sin_addr = addrs[i];
        if (connect(fd[i], (struct sockaddr *)&sa, sizeof(sa)) < 0 && errno != EINPROGRESS) {
            close(fd[i]); fd[i] = -1;
        }
    }
    int pending = 1;
    while (pending) {
        struct pollfd pfd[MAX_ADDRS];
        int idx[MAX_ADDRS];
        int np = 0;
        for (int i = 0; i < n; i++)
            if (fd[i] >= 0 && rtt[i] < 0) { pfd[np].fd = fd[i]; pfd[np].events = POLLOUT; idx[np++] = i; }
        if (!np) break;
        struct timeval now;
        gettimeofday(&now, NULL);
        long elapsed = (now.tv_sec - t0.tv_sec) * 1000L + (now.tv_usec - t0.tv_usec) / 1000L;
        if (elapsed >= cap_ms) break;
        int r = poll(pfd, (nfds_t)np, (int)(cap_ms - elapsed));
        if (r <= 0) break;
        gettimeofday(&now, NULL);
        elapsed = (now.tv_sec - t0.tv_sec) * 1000L + (now.tv_usec - t0.tv_usec) / 1000L;
        for (int k = 0; k < np; k++) {
            if (!pfd[k].revents) continue;
            int i = idx[k];
            int err = 0;
            socklen_t el = sizeof(err);
            if (getsockopt(fd[i], SOL_SOCKET, SO_ERROR, &err, &el) == 0 && err == 0 &&
                !(pfd[k].revents & (POLLERR | POLLHUP)))
                rtt[i] = elapsed > 0 ? elapsed : 1;
            close(fd[i]); fd[i] = -1;
        }
        // The SDK is handed only the first address (unless DNSHOOK_ALL_ADDRS), so the first server
        // to answer settles it; waiting out the cap for one that never answers (47.107.189.8 here)
        // cost every dial the full 1.5 s. With DNSHOOK_PREFER the ranking needs every answer.
        if (!all_addrs_on() && !(getenv("DNSHOOK_PREFER") && *getenv("DNSHOOK_PREFER"))) {
            int answered = 0;
            for (int i = 0; i < n; i++) if (rtt[i] >= 0) answered = 1;
            if (answered) break;
        }
    }
    for (int i = 0; i < n; i++) if (fd[i] >= 0) close(fd[i]);

    // stable insertion sort: answered (rank, rtt) ahead of unanswered
    for (int i = 1; i < n; i++) {
        struct in_addr a = addrs[i];
        long ra = rtt[i];
        int pa = ra < 0 ? 1000000 : prefer_rank(a);
        int j = i - 1;
        while (j >= 0) {
            long rb = rtt[j];
            int pb = rb < 0 ? 1000000 : prefer_rank(addrs[j]);
            int before = pa < pb || (pa == pb && ra >= 0 && (rb < 0 || ra < rb));
            if (!before) break;
            addrs[j + 1] = addrs[j]; rtt[j + 1] = rtt[j];
            j--;
        }
        addrs[j + 1] = a; rtt[j + 1] = ra;
    }
    if (debug_on()) {
        char buf[MAX_ADDRS * 32 + 1] = "";
        for (int i = 0; i < n; i++) {
            char one[32];
            if (rtt[i] >= 0) snprintf(one, sizeof(one), "%s%s(%ldms)", i ? "," : "", inet_ntoa(addrs[i]), rtt[i]);
            else snprintf(one, sizeof(one), "%s%s(none)", i ? "," : "", inet_ntoa(addrs[i]));
            strncat(buf, one, sizeof(buf) - strlen(buf) - 1);
        }
        fprintf(stderr, "    dns probe :%d -> %s\n", port, buf);
    }
}


// `name` as printable ASCII, anything else as \xNN, at most 64 bytes of it: the SDK has been
// seen handing the resolver a name that is not a NUL-terminated hostname, and a log line that
// is not valid UTF-8 must never reach the supervisor's pipe reader.
static const char *printable(const char *name, char *out, size_t outlen) {
    size_t o = 0;
    for (size_t i = 0; name[i] && i < 64 && o + 5 < outlen; i++) {
        unsigned char c = (unsigned char)name[i];
        if (c >= 0x20 && c < 0x7f) out[o++] = (char)c;
        else o += (size_t)snprintf(out + o, outlen - o, "\\x%02x", c);
    }
    out[o] = '\0';
    return out;
}

/* Resolve the A records of `host`, up to MAX_ADDRS of them in the order the nameserver gave
 * them. Returns how many, 0 when there are none, -1 on failure. The TUTK master and relay
 * hostnames resolve to several servers and the SDK walks the whole list; handing it only the
 * first one made every lookup a coin toss on that one server answering. */
static int dns_lookup_all(const char *host, struct in_addr *out, int max) {
    unsigned char q[512], r[1024];

    // Build a minimal DNS query header + one A/IN question.
    memset(q, 0, sizeof(q));
    unsigned short id = (unsigned short)(getpid() ^ time(NULL));
    q[0] = id >> 8; q[1] = id & 0xff;
    q[2] = 0x01;                    // recursion desired
    q[5] = 0x01;                    // qdcount = 1
    int qn_len = encode_qname(host, q + 12, sizeof(q) - 18);
    if (qn_len < 0) {
        if (debug_on()) {
            char shown[4 * 64 + 1];
            fprintf(stderr, "    dns %s -> (not a hostname)\n", printable(host, shown, sizeof(shown)));
        }
        return -1;
    }
    int qlen = 12 + qn_len;
    q[qlen++] = 0; q[qlen++] = 1;   // QTYPE  = A
    q[qlen++] = 0; q[qlen++] = 1;   // QCLASS = IN

    // Send it to the nameserver and read the reply (5s timeout).
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0) return -1;
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    struct sockaddr_in srv;
    memset(&srv, 0, sizeof(srv));
    srv.sin_family = AF_INET;
    srv.sin_port = htons(53);
    if (inet_pton(AF_INET, nameserver(), &srv.sin_addr) != 1) { close(s); return -1; }
    if (sendto(s, q, qlen, 0, (struct sockaddr *)&srv, sizeof(srv)) < 0) {
        close(s); return -1;
    }
    ssize_t n = recv(s, r, sizeof(r), 0);
    close(s);
    if (n < 12) return -1;

    // Walk the answer section, collecting the A records.
    int ancount = (r[6] << 8) | r[7];
    int pos = 12;
    int skipped = skip_name(r, (int)n, pos);
    if (skipped < 0) return -1;
    pos += skipped + 4;                       // skip the question's QTYPE/QCLASS
    int found = 0;
    for (int i = 0; i < ancount && pos < n && found < max; i++) {
        skipped = skip_name(r, (int)n, pos);
        if (skipped < 0) return -1;
        pos += skipped;
        if (pos + 10 > n) return -1;
        int type = (r[pos] << 8) | r[pos + 1];
        int rdlen = (r[pos + 8] << 8) | r[pos + 9];
        pos += 10;
        if (type == 1 && rdlen == 4 && pos + 4 <= n) {
            memcpy(&out[found++], r + pos, 4);
        }
        pos += rdlen;                          // CNAME etc.; keep going
    }
    if (debug_on()) {
        char buf[MAX_ADDRS * 17 + 1] = "";
        for (int i = 0; i < found; i++) {
            char one[17];
            snprintf(one, sizeof(one), "%s%s", i ? "," : "", inet_ntoa(out[i]));
            strncat(buf, one, sizeof(buf) - strlen(buf) - 1);
        }
        char shown[4 * 64 + 1];
        fprintf(stderr, "    dns %s -> %s\n", printable(host, shown, sizeof(shown)),
                found ? buf : "(no A record)");
    }
    return found;
}

/* Resolve one A record (the first). Returns 0 on success. */
static int dns_lookup(const char *host, struct in_addr *out) {
    struct in_addr addrs[MAX_ADDRS];
    int n = dns_lookup_all(host, addrs, MAX_ADDRS);
    if (n <= 0) return -1;
    *out = addrs[0];
    return 0;
}

// One addrinfo node for `addr`, as AF_INET or (when asked for) v4-mapped AF_INET6.
static struct addrinfo *make_ai(struct in_addr addr, int is_v6, int port, const struct addrinfo *hints) {
    struct addrinfo *ai = calloc(1, sizeof(*ai));
    if (!ai) return NULL;
    if (is_v6) {
        struct sockaddr_in6 *sa6 = calloc(1, sizeof(*sa6));
        if (!sa6) { free(ai); return NULL; }
        sa6->sin6_family = AF_INET6;
        sa6->sin6_port = htons((unsigned short)port);
        sa6->sin6_addr.s6_addr[10] = 0xff;
        sa6->sin6_addr.s6_addr[11] = 0xff;
        memcpy(sa6->sin6_addr.s6_addr + 12, &addr, 4);
        ai->ai_family = AF_INET6;
        ai->ai_addrlen = sizeof(*sa6);
        ai->ai_addr = (struct sockaddr *)sa6;
    } else {
        struct sockaddr_in *sa = calloc(1, sizeof(*sa));
        if (!sa) { free(ai); return NULL; }
        sa->sin_family = AF_INET;
        sa->sin_port = htons((unsigned short)port);
        sa->sin_addr = addr;
        ai->ai_family = AF_INET;
        ai->ai_addrlen = sizeof(*sa);
        ai->ai_addr = (struct sockaddr *)sa;
    }
    ai->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    ai->ai_protocol = hints ? hints->ai_protocol : 0;
    return ai;
}

// The main override the SDK relies on. Deliberately minimal: A records only, every one of
// them chained on ai_next the way the real resolver does it.
int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    struct in_addr addrs[MAX_ADDRS];
    struct in6_addr addr6;
    int want = hints ? hints->ai_family : AF_UNSPEC;
    int is_v6 = 0;
    int count = 1;
    if (!node) return EAI_FAIL;
    if (inet_pton(AF_INET, node, &addrs[0]) == 1) {
        // already a numeric IPv4 literal
    } else if (inet_pton(AF_INET6, node, &addr6) == 1) {
        // The SDK uses ::ffff:a.b.c.d literals; unwrap the embedded IPv4.
        if (!IN6_IS_ADDR_V4MAPPED(&addr6)) return EAI_FAMILY;
        memcpy(&addrs[0], addr6.s6_addr + 12, 4);
        is_v6 = (want == AF_INET6);
    } else if (want == AF_INET6) {
        return EAI_NONAME;               // we only speak A records
    } else {
        count = dns_lookup_all(node, addrs, MAX_ADDRS);
        if (count <= 0) return EAI_NONAME;
        order_by_probe(addrs, count);
        if (!all_addrs_on()) count = 1;
    }
    int port = (service && *service) ? atoi(service) : 0;
    struct addrinfo *head = NULL, *tail = NULL;
    for (int i = 0; i < count; i++) {
        struct addrinfo *ai = make_ai(addrs[i], is_v6, port, hints);
        if (!ai) { freeaddrinfo(head); return EAI_MEMORY; }
        if (tail) tail->ai_next = ai; else head = ai;
        tail = ai;
    }
    *res = head;
    return 0;
}

void freeaddrinfo(struct addrinfo *res) {
    while (res) {
        struct addrinfo *next = res->ai_next;
        free(res->ai_addr);
        free(res);
        res = next;
    }
}

// The other resolver override some code paths use; also A-records only.
struct hostent *gethostbyname(const char *name) {
    static struct hostent he;
    static struct in_addr addr;
    static char *addr_list[2];
    static char namebuf[256];

    if (!name) return NULL;
    if (inet_pton(AF_INET, name, &addr) != 1 && dns_lookup(name, &addr) != 0)
        return NULL;

    snprintf(namebuf, sizeof(namebuf), "%s", name);
    addr_list[0] = (char *)&addr;
    addr_list[1] = NULL;
    he.h_name = namebuf;
    he.h_aliases = NULL;
    he.h_addrtype = AF_INET;
    he.h_length = 4;
    he.h_addr_list = addr_list;
    return &he;
}
