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

/* Resolve one A record. Returns 0 on success. */
static int dns_lookup(const char *host, struct in_addr *out) {
    unsigned char q[512], r[1024];

    // Build a minimal DNS query header + one A/IN question.
    memset(q, 0, sizeof(q));
    unsigned short id = (unsigned short)(getpid() ^ time(NULL));
    q[0] = id >> 8; q[1] = id & 0xff;
    q[2] = 0x01;                    // recursion desired
    q[5] = 0x01;                    // qdcount = 1
    int qn_len = encode_qname(host, q + 12, sizeof(q) - 18);
    if (qn_len < 0) return -1;
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

    // Walk the answer section, returning the first A record.
    int ancount = (r[6] << 8) | r[7];
    int pos = 12;
    int skipped = skip_name(r, (int)n, pos);
    if (skipped < 0) return -1;
    pos += skipped + 4;                       // skip the question's QTYPE/QCLASS
    for (int i = 0; i < ancount && pos < n; i++) {
        skipped = skip_name(r, (int)n, pos);
        if (skipped < 0) return -1;
        pos += skipped;
        if (pos + 10 > n) return -1;
        int type = (r[pos] << 8) | r[pos + 1];
        int rdlen = (r[pos + 8] << 8) | r[pos + 9];
        pos += 10;
        if (type == 1 && rdlen == 4 && pos + 4 <= n) {
            memcpy(out, r + pos, 4);
            return 0;
        }
        pos += rdlen;                          // CNAME etc.; keep going
    }
    return -1;
}

// The main override the SDK relies on. Deliberately minimal: A records only.
int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    struct in_addr addr;
    struct in6_addr addr6;
    int want = hints ? hints->ai_family : AF_UNSPEC;
    int is_v6 = 0;

    if (!node) return EAI_FAIL;

    if (inet_pton(AF_INET, node, &addr) == 1) {
        // already a numeric IPv4 literal
    } else if (inet_pton(AF_INET6, node, &addr6) == 1) {
        // The SDK uses ::ffff:a.b.c.d literals; unwrap the embedded IPv4.
        if (!IN6_IS_ADDR_V4MAPPED(&addr6)) return EAI_FAMILY;
        memcpy(&addr, addr6.s6_addr + 12, 4);
        is_v6 = (want == AF_INET6);
    } else if (want == AF_INET6) {
        return EAI_NONAME;               // we only speak A records
    } else if (dns_lookup(node, &addr) != 0) {
        return EAI_NONAME;
    }

    int port = (service && *service) ? atoi(service) : 0;

    struct addrinfo *ai = calloc(1, sizeof(*ai));
    if (!ai) return EAI_MEMORY;

    if (is_v6) {
        // Caller asked for AF_INET6: hand back a v4-mapped sockaddr_in6.
        struct sockaddr_in6 *sa6 = calloc(1, sizeof(*sa6));
        if (!sa6) goto oom;
        sa6->sin6_family = AF_INET6;
        sa6->sin6_port = htons((unsigned short)port);
        sa6->sin6_addr.s6_addr[10] = 0xff;
        sa6->sin6_addr.s6_addr[11] = 0xff;
        memcpy(sa6->sin6_addr.s6_addr + 12, &addr, 4);
        ai->ai_family = AF_INET6;
        ai->ai_addrlen = sizeof(*sa6);
        ai->ai_addr = (struct sockaddr *)sa6;
    } else {
        // Normal case: a plain sockaddr_in.
        struct sockaddr_in *sa = calloc(1, sizeof(*sa));
        if (!sa) goto oom;
        sa->sin_family = AF_INET;
        sa->sin_port = htons((unsigned short)port);
        sa->sin_addr = addr;
        ai->ai_family = AF_INET;
        ai->ai_addrlen = sizeof(*sa);
        ai->ai_addr = (struct sockaddr *)sa;
    }

    ai->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    ai->ai_protocol = hints ? hints->ai_protocol : 0;
    *res = ai;
    return 0;

oom:
    free(ai);
    return EAI_MEMORY;
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
