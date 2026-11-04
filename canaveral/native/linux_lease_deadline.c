/* Dedicated Linux helper process only. Expiry kills this process, closing its
 * auto-destroy libvirt connection even if an RPC or Python is blocked.
 * Build as a private shared object; no installation is performed here. */
#ifdef __linux__
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

static timer_t lease_timer;
static pid_t installed_pid;
static struct timespec previous_deadline;

int canaveral_lease_deadline_install(int64_t expected_parent) {
    if (installed_pid || expected_parent <= 1 || getpid() == expected_parent ||
        getppid() != expected_parent) { errno = EPERM; return -1; }
    /* Close the parent-death race after installing the kernel relationship. */
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != expected_parent) {
        errno = EPERM; return -1;
    }
    struct sigevent event = {0};
    event.sigev_notify = SIGEV_SIGNAL;
    event.sigev_signo = SIGKILL;
    if (timer_create(CLOCK_BOOTTIME, &event, &lease_timer)) return -1;
    installed_pid = getpid();
    return 0;
}

int canaveral_lease_deadline_arm(int64_t seconds, int32_t nanoseconds) {
    if (getpid() != installed_pid || seconds < 0 || nanoseconds < 0 ||
        nanoseconds >= 1000000000 || (!seconds && !nanoseconds)) {
        errno = EINVAL; return -1;
    }
    struct itimerspec value = {0};
    struct timespec now;
    if (clock_gettime(CLOCK_BOOTTIME, &now)) return -1;
    if ((previous_deadline.tv_sec || previous_deadline.tv_nsec) &&
        (now.tv_sec > previous_deadline.tv_sec ||
         (now.tv_sec == previous_deadline.tv_sec && now.tv_nsec >= previous_deadline.tv_nsec))) {
        kill(getpid(), SIGKILL);
        errno = ETIMEDOUT; return -1;
    }
    value.it_value.tv_sec = (time_t)seconds;
    if ((int64_t)value.it_value.tv_sec != seconds) { errno = ERANGE; return -1; }
    value.it_value.tv_nsec = nanoseconds;
    /* There is deliberately no disarm/exported timer-delete operation. */
    if (timer_settime(lease_timer, TIMER_ABSTIME, &value, 0)) return -1;
    previous_deadline = value.it_value;
    return 0;
}
#else
/* Unsupported platforms fail closed; this does not emulate CLOCK_BOOTTIME. */
#include <stdint.h>
int canaveral_lease_deadline_install(int64_t expected_parent) { (void)expected_parent; return -1; }
int canaveral_lease_deadline_arm(int64_t seconds, int32_t nanoseconds) { (void)seconds; (void)nanoseconds; return -1; }
#endif
