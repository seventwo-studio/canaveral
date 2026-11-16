//! Prospective worker ownership. A detached worker retains the original flock descriptor.
use std::{
    cell::RefCell,
    fs::File,
    sync::Arc,
    thread::{self, JoinHandle},
};

/// Opaque shared ownership of the *same* open file description, never a reopened lock.
#[derive(Clone)]
pub struct Guard(Arc<File>);
impl Guard {
    pub(crate) fn new(file: File) -> Self {
        Self(Arc::new(file))
    }
    pub(crate) fn file(&self) -> &File {
        &self.0
    }
}
thread_local! { static OWNER: RefCell<Option<Guard>> = const { RefCell::new(None) }; }

pub(crate) fn with_guard<T>(guard: Option<Guard>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<Guard>);
    impl Drop for Restore {
        fn drop(&mut self) {
            OWNER.with(|owner| *owner.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(OWNER.with(|owner| owner.replace(guard)));
    work()
}

/// Providers must use this for nested workers too, including bounded DNS queries.
/// The thread-local guard survives unwinding; children copy it before their parent can exit.
pub fn spawn<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> JoinHandle<T> {
    try_spawn(thread::Builder::new(), work).expect("worker thread unavailable")
}

pub(crate) fn try_spawn<T: Send + 'static>(
    builder: thread::Builder,
    work: impl FnOnce() -> T + Send + 'static,
) -> std::io::Result<JoinHandle<T>> {
    let guard = OWNER.with(|owner| owner.borrow().clone());
    builder.spawn(move || with_guard(guard, work))
}

/// Inherit a duplicate of the original flock into an effect-owning subprocess.
/// Only the duplicate loses CLOEXEC, in the forked child, before exec. The pinned
/// helper and bootstrap builder must retain inherited descriptors until exit.
pub(crate) fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    let mut command = std::process::Command::new(program);
    if let Some(guard) = OWNER.with(|owner| owner.borrow().clone()) {
        unsafe {
            command.pre_exec(move || {
                // F_DUPFD creates a descriptor with FD_CLOEXEC clear, without
                // altering the parent's descriptor flags or unlocking the flock.
                if libc::fcntl(guard.file().as_raw_fd(), libc::F_DUPFD, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::Directory;
    use std::{sync::mpsc, time::Duration};
    fn state() -> (tempfile::TempDir, std::path::PathBuf, Directory) {
        let temp =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let path = temp.path().join("state");
        let dir = Directory::open(&path).unwrap();
        (temp, path, dir)
    }
    #[test]
    fn detached_nested_worker_survives_parent_panic_and_managed_return() {
        let (_temp, path, dir) = state();
        let (ready, wait) = mpsc::channel();
        let (end, blocked) = mpsc::channel();
        let parent = with_guard(Some(dir.worker_guard()), || {
            spawn(move || {
                let nested = spawn(move || {
                    ready.send(()).unwrap();
                    blocked.recv().unwrap();
                });
                drop(nested);
                panic!("fixture reactor panic");
            })
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(parent.join().is_err());
        drop(dir);
        assert!(Directory::open(&path).is_err());
        end.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if Directory::open(&path).is_ok() {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
    }
    #[test]
    fn orphan_prepare_keeps_same_flock_until_subprocess_exits() {
        let (_temp, path, dir) = state();
        let mut child = with_guard(Some(dir.worker_guard()), || {
            command("/bin/sh")
                .args(["-c", "read value"])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        });
        drop(dir);
        assert!(Directory::open(&path).is_err());
        drop(child.stdin.take());
        assert!(child.wait().unwrap().code().is_some());
        assert!(Directory::open(&path).is_ok());
    }
}
