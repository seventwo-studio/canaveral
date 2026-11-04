#include "GuestPTYSupport.h"
#include <sys/ioctl.h>
#include <sys/ttycom.h>

int canaveral_pty_signal(int descriptor, int signal_number) {
    return ioctl(descriptor, TIOCSIG, signal_number);
}
