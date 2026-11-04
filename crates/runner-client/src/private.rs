//! Descriptor-relative private state. No symlink traversal, including ancestors.
use super::{invalid, io, Error, Result};
use std::{
    ffi::CString,
    fs::File,
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
};
fn name(s: &std::ffi::OsStr) -> Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(s.as_bytes()).map_err(|_| invalid())
}
fn openat(parent: &File, n: &CString, flags: i32) -> Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            n.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err(invalid());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn walk(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    let mut dir = io(File::open("/"))?;
    for c in path.components() {
        match c {
            Component::RootDir => {}
            Component::Normal(n) => {
                dir = openat(&dir, &name(n)?, libc::O_RDONLY | libc::O_DIRECTORY)?
            }
            _ => return Err(invalid()),
        }
    }
    Ok(dir)
}
fn private(file: &File, directory: bool) -> Result<()> {
    let m = io(file.metadata())?;
    let kind = if directory {
        m.is_dir()
    } else {
        m.is_file() && m.nlink() == 1
    };
    if !kind
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) struct Directory {
    path: PathBuf,
    dir: File,
    lock: File,
}
impl Directory {
    pub fn create(path: &Path) -> Result<Self> {
        let parent = walk(path.parent().ok_or_else(invalid)?)?;
        let n = name(path.file_name().ok_or_else(invalid)?)?;
        // Existing directories (even empty ones) are not initialization authority.
        if unsafe { libc::mkdirat(parent.as_raw_fd(), n.as_ptr(), 0o700) } != 0 {
            return Err(invalid());
        }
        io(parent.sync_all())?;
        let dir = openat(&parent, &n, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let lock = openat(
            &dir,
            &name("owner.lock".as_ref())?,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        )?;
        io(lock.sync_all())?;
        io(dir.sync_all())?;
        Self::finish(path, dir, lock)
    }
    pub fn open(path: &Path) -> Result<Self> {
        let dir = walk(path)?;
        private(&dir, true)?;
        let lock = openat(&dir, &name("owner.lock".as_ref())?, libc::O_RDWR)?;
        Self::finish(path, dir, lock)
    }
    fn finish(path: &Path, dir: File, lock: File) -> Result<Self> {
        private(&dir, true)?;
        private(&lock, false)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error("identity is already owned or locking unavailable"));
        }
        let result = Self {
            path: path.to_owned(),
            dir,
            lock,
        };
        result.check()?;
        // The exclusive owner can discard only an unpublished journal candidate.
        // Network requests are sent only after publication and directory fsync.
        result.clear_pending()?;
        result.check()?;
        Ok(result)
    }
    pub fn check(&self) -> Result<()> {
        private(&self.dir, true)?;
        private(&self.lock, false)?;
        let current = walk(&self.path)?;
        let a = io(current.metadata())?;
        let b = io(self.dir.metadata())?;
        let lock = openat(&self.dir, &name("owner.lock".as_ref())?, libc::O_RDONLY)?;
        let x = io(lock.metadata())?;
        let y = io(self.lock.metadata())?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) || (x.dev(), x.ino()) != (y.dev(), y.ino()) {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn read(&self, n: &str) -> Result<Vec<u8>> {
        self.check()?;
        let file = openat(&self.dir, &name(n.as_ref())?, libc::O_RDONLY)?;
        private(&file, false)?;
        super::bounded(file)
    }
    fn clear_pending(&self) -> Result<()> {
        let n = name("identity.pending".as_ref())?;
        if unsafe { libc::unlinkat(self.dir.as_raw_fd(), n.as_ptr(), 0) } != 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                return Ok(());
            }
            return Err(invalid());
        }
        io(self.dir.sync_all())
    }
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        self.check()?;
        let temp = name("identity.pending".as_ref())?;
        let mut file = openat(
            &self.dir,
            &temp,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        let result = (|| {
            private(&file, false)?;
            io(file.write_all(bytes))?;
            io(file.sync_all())?;
            self.check()?;
            if unsafe {
                libc::renameat(
                    self.dir.as_raw_fd(),
                    temp.as_ptr(),
                    self.dir.as_raw_fd(),
                    name("identity.json".as_ref())?.as_ptr(),
                )
            } != 0
            {
                return Err(invalid());
            }
            io(self.dir.sync_all())?;
            self.check()
        })();
        if result.is_err() {
            // Leave the open identity poisoned; reopening retains the committed record.
            let _ = self.clear_pending();
        }
        result
    }
}
