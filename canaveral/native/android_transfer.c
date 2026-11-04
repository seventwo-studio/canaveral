/* Private guest upload primitive. It does not enforce a consumer lease deadline. */
#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef CANAVERAL_TRANSFER_TIMEOUT_MS
#define CANAVERAL_TRANSFER_TIMEOUT_MS 30000
#endif

static int fault(const char *stage) {
#ifdef CANAVERAL_TRANSFER_TESTING
    const char *value = getenv("CANAVERAL_TRANSFER_TEST_FAIL");
    if (value && !strcmp(value, stage)) { errno = EIO; return 1; }
#else
    (void)stage;
#endif
    return 0;
}

static int64_t milliseconds(void) {
    struct timespec value;
#ifdef CLOCK_BOOTTIME
    if (clock_gettime(CLOCK_BOOTTIME, &value)) return -1;
#else
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return -1;
#endif
    return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static ssize_t receive(void *buffer, size_t size) {
    int64_t now = milliseconds();
    if (now < 0) return -1;
    int64_t deadline = now + CANAVERAL_TRANSFER_TIMEOUT_MS;
    for (;;) {
        now = milliseconds();
        if (now < 0 || now >= deadline) { errno = ETIMEDOUT; return -1; }
        struct pollfd input = { STDIN_FILENO, POLLIN, 0 };
        int result = poll(&input, 1, (int)(deadline - now));
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) { if (!result) errno = ETIMEDOUT; return -1; }
        ssize_t count = read(STDIN_FILENO, buffer, size);
        if (count < 0 && errno == EINTR) continue;
        return count;
    }
}

static int send_all(int fd, const void *buffer, size_t size) {
    const char *cursor = buffer;
    while (size) {
        ssize_t count = write(fd, cursor, size);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        cursor += count; size -= (size_t)count;
    }
    return 0;
}

static int uuid_valid(const char *value) {
    if (strlen(value) != 36) return 0;
    for (int i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return 0; }
        else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return 0;
    }
    return 1;
}

static int same_file(const struct stat *first, const struct stat *second) {
#ifdef __APPLE__
    struct timespec fm = first->st_mtimespec, sm = second->st_mtimespec;
    struct timespec fc = first->st_ctimespec, sc = second->st_ctimespec;
#else
    struct timespec fm = first->st_mtim, sm = second->st_mtim;
    struct timespec fc = first->st_ctim, sc = second->st_ctim;
#endif
    return S_ISREG(second->st_mode) && first->st_dev == second->st_dev && first->st_ino == second->st_ino &&
        first->st_mode == second->st_mode && first->st_size == second->st_size &&
        fm.tv_sec == sm.tv_sec && fm.tv_nsec == sm.tv_nsec && fc.tv_sec == sc.tv_sec && fc.tv_nsec == sc.tv_nsec;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    if (argc != 5 || strcmp(argv[1], "upload") || argv[2][0] != '/' || !uuid_valid(argv[4])) return 2;
    if (!argv[3][0]) return 2;
    for (const char *p = argv[3]; *p; ++p) if (*p < '0' || *p > '9') return 2;
    errno = 0; char *end;
    uint64_t size = strtoull(argv[3], &end, 10);
    if (errno || *end || size > UINT64_C(9007199254740991)) return 2;
    size_t length = strlen(argv[2]);
    if (!length || length >= PATH_MAX) return 2;
    char parent[PATH_MAX]; memcpy(parent, argv[2], length + 1);
    char *name = strrchr(parent, '/');
    if (!name || !name[1] || !strcmp(name + 1, ".") || !strcmp(name + 1, "..")) return 2;
    char target[PATH_MAX]; strcpy(target, name + 1);
    if (name == parent) name[1] = 0; else *name = 0;

    int directory = -1, file = -1, owned = 0, result = 3;
    const char *stage = "open-directory";
    char temporary[80], message[128], commit[80];
    snprintf(temporary, sizeof temporary, ".canaveral-upload-%s", argv[4]);
    directory = open(parent, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0) goto cleanup;
    stage = "create-temporary";
    file = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file < 0) goto cleanup;
    owned = 1;
    stage = "receive";
    uint64_t remaining = size;
    char buffer[65536];
    while (remaining) {
        size_t wanted = remaining < sizeof buffer ? (size_t)remaining : sizeof buffer;
        ssize_t count = receive(buffer, wanted);
        if (count <= 0 || send_all(file, buffer, (size_t)count)) goto cleanup;
        remaining -= (uint64_t)count;
    }
    stage = "file-sync";
    if (fault(stage) || fsync(file)) goto cleanup;
    struct stat staged, current, entry;
    if (fstat(file, &staged) || !S_ISREG(staged.st_mode) || (uint64_t)staged.st_size != size) goto cleanup;
    stage = "stage-ack";
    int bytes = snprintf(message, sizeof message, "CANAVERAL_TRANSFER_V1 STAGED %s %" PRIu64 "\n", argv[4], size);
    if (bytes <= 0 || (size_t)bytes >= sizeof message || fault(stage) || send_all(STDOUT_FILENO, message, (size_t)bytes)) goto cleanup;

    stage = "commit"; result = 4;
    int commit_length = snprintf(commit, sizeof commit, "COMMIT %s\n", argv[4]);
    size_t received = 0;
    while (received < (size_t)commit_length) {
        ssize_t count = receive(buffer + received, (size_t)commit_length - received);
        if (count <= 0) goto cleanup;
        received += (size_t)count;
    }
    if (memcmp(buffer, commit, received)) goto cleanup;
    /* An exact commit plus stdin EOF excludes trailing protocol payload. */
    if (receive(buffer, 1) != 0) goto cleanup;
    stage = "staged-identity";
    if (fstat(file, &current) || !same_file(&staged, &current) ||
        fstatat(directory, temporary, &entry, AT_SYMLINK_NOFOLLOW) || !same_file(&staged, &entry)) goto cleanup;
    stage = "publish"; result = 5;
    if (fault(stage) || renameat(directory, temporary, directory, target)) goto cleanup;
    owned = 0;  /* Never remove the destination after a dispatched publication. */
    stage = "file-close"; result = 6;
    int closing = file; file = -1;
    if (fault(stage) || close(closing)) goto cleanup;
    stage = "directory-sync"; result = 6;
    if (fault(stage) || fsync(directory)) goto cleanup;
    stage = "commit-ack";
    bytes = snprintf(message, sizeof message, "CANAVERAL_TRANSFER_V1 COMMITTED %s %" PRIu64 "\n", argv[4], size);
    if (bytes <= 0 || (size_t)bytes >= sizeof message || fault(stage) || send_all(STDOUT_FILENO, message, (size_t)bytes)) goto cleanup;
    result = 0;
cleanup:
    if (owned) {
        /* Only unlink an entry still belonging to this exclusive creation. */
        struct stat original, candidate;
        if (!fstat(file, &original) && !fstatat(directory, temporary, &candidate, AT_SYMLINK_NOFOLLOW) &&
            S_ISREG(candidate.st_mode) && original.st_dev == candidate.st_dev && original.st_ino == candidate.st_ino)
            unlinkat(directory, temporary, 0);
    }
    if (file >= 0) close(file);
    if (directory >= 0) close(directory);
    if (result) dprintf(STDERR_FILENO, "canaveral-transfer: %s\n", stage);
    return result;
}
