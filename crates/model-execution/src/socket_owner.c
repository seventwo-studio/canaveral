// Query the kernel, never adopt an existing service at a recycled loopback port.
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <stdlib.h>
int canaveral_model_socket_owned(int pid, unsigned short port) {
    int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (size <= 0) return 0;
    struct proc_fdinfo *fds = malloc((size_t)size);
    if (!fds) return 0;
    int got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, size);
    int owned = 0;
    if (got > 0 && got <= size) for (int i=0; i<got/(int)sizeof(*fds); i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        struct socket_fdinfo info;
        if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) != sizeof(info)) continue;
        struct tcp_sockinfo *tcp = &info.psi.soi_proto.pri_tcp;
        if (info.psi.soi_family == AF_INET && info.psi.soi_kind == SOCKINFO_TCP &&
            tcp->tcpsi_state == TSI_S_LISTEN && ntohs((unsigned short)tcp->tcpsi_ini.insi_lport) == port &&
            tcp->tcpsi_ini.insi_laddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK)) owned = 1;
    }
    free(fds);
    return owned;
}
