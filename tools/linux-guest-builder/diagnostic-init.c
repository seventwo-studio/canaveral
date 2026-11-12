/* Diagnostic PID1 only. Never put this initrd in a lease manifest. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <glob.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <unistd.h>
int main(void) {
    if (getpid() != 1) return 1;
    if (mount("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, "")) return 2;
    int fd = open("/dev/hvc0", O_WRONLY | O_NOCTTY);
    if (fd < 0) return 3;
    dup2(fd, 1); dup2(fd, 2); close(fd);
    puts("CANAVERAL-DIAGNOSTIC-ONLY-v1");
    if (mount("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NOEXEC | MS_NODEV, "")) return 4;
    glob_t paths = {0};
    if (!glob("/sys/block/*/serial", 0, NULL, &paths)) {
        for (size_t i = 0; i < paths.gl_pathc; i++) {
            char value[256]; FILE *f = fopen(paths.gl_pathv[i], "r");
            if (f && fgets(value, sizeof(value), f)) printf("%s: %s", paths.gl_pathv[i], value);
            if (f) fclose(f);
        }
    }
    globfree(&paths); fflush(NULL); sync(); reboot(RB_POWER_OFF);
    for (;;) pause();
}
