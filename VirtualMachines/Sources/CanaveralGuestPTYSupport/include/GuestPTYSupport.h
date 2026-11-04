#ifndef CANAVERAL_GUEST_PTY_SUPPORT_H
#define CANAVERAL_GUEST_PTY_SUPPORT_H
/* TIOCSIG takes an integer vararg, unavailable through Swift's typed ioctl overlay. */
int canaveral_pty_signal(int descriptor, int signal_number);
#endif
