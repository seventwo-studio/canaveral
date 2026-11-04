//! Descriptor-relative private state. No symlink traversal, including ancestors.
use super::Result;
fn invalid() -> &'static str {
    "unsafe executor state"
}
fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|_| invalid())
}
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
pub(super) fn walk(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    let mut dir = io(File::open("/"))?;
    for c in path.components() {
        match c {
            Component::RootDir => {}
            Component::Normal(n) => {
                dir = openat(&dir, &name(n)?, libc::O_RDONLY | libc::O_DIRECTORY)?;
                let m = io(dir.metadata())?;
                if !(m.uid() == 0 || m.uid() == unsafe { libc::geteuid() })
                    || (m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
                {
                    return Err(invalid());
                }
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
    pub fn open(path: &Path) -> Result<Self> {
        let parent = walk(path.parent().ok_or_else(invalid)?)?;
        let n = name(path.file_name().ok_or_else(invalid)?)?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), n.as_ptr(), 0o700) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(invalid());
        }
        let dir = openat(&parent, &n, libc::O_RDONLY | libc::O_DIRECTORY)?;
        private(&dir, true)?;
        let lock = openat(&dir, &name("lock".as_ref())?, libc::O_RDWR | libc::O_CREAT)?;
        Self::finish(path, dir, lock)
    }
    fn finish(path: &Path, dir: File, lock: File) -> Result<Self> {
        private(&dir, true)?;
        private(&lock, false)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("executor already owned");
        }
        let result = Self {
            path: path.to_owned(),
            dir,
            lock,
        };
        result.check()?;
        // The exclusive owner can discard only an unpublished journal candidate.
        // Network requests are sent only after publication and directory fsync.
        result.clear_pending("receipt.next")?;
        result.clear_pending("claim.next")?;
        result.check()?;
        Ok(result)
    }
    pub fn check(&self) -> Result<()> {
        private(&self.dir, true)?;
        private(&self.lock, false)?;
        let current = walk(&self.path)?;
        let a = io(current.metadata())?;
        let b = io(self.dir.metadata())?;
        let lock = openat(&self.dir, &name("lock".as_ref())?, libc::O_RDONLY)?;
        let x = io(lock.metadata())?;
        let y = io(self.lock.metadata())?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) || (x.dev(), x.ino()) != (y.dev(), y.ino()) {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn workspace(&self) -> Result<()> {
        self.check()?;
        if unsafe {
            libc::mkdirat(
                self.dir.as_raw_fd(),
                name("workspace".as_ref())?.as_ptr(),
                0o700,
            )
        } != 0
        {
            return Err("unreconciled workspace");
        }
        io(self.dir.sync_all())?;
        self.check()
    }
    pub fn runtime_output(&self) -> Result<File> {
        self.check()?;
        let n = name("runtime".as_ref())?;
        if unsafe { libc::unlinkat(self.dir.as_raw_fd(), n.as_ptr(), 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT)
        {
            return Err(invalid());
        }
        let file = openat(&self.dir, &n, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o500) } != 0 {
            return Err(invalid());
        }
        self.check()?;
        Ok(file)
    }
    pub fn cleanup_workspace(&self) -> Result<()> {
        self.check()?;
        remove_tree(&self.dir, &name("workspace".as_ref())?)?;
        io(self.dir.sync_all())?;
        self.check()
    }
    pub fn read_optional(&self, n: &str) -> Result<Option<Vec<u8>>> {
        self.check()?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                self.dir.as_raw_fd(),
                name(n.as_ref())?.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                return Ok(None);
            }
            return Err(invalid());
        }
        self.read(n).map(Some)
    }
    pub fn read(&self, n: &str) -> Result<Vec<u8>> {
        self.check()?;
        let file = openat(&self.dir, &name(n.as_ref())?, libc::O_RDONLY)?;
        private(&file, false)?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(file, 16 * 1024 * 1024 + 1),
            &mut bytes,
        )
        .map_err(|_| invalid())?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(invalid());
        }
        self.check()?;
        Ok(bytes)
    }
    fn clear_pending(&self, pending: &str) -> Result<()> {
        let n = name(pending.as_ref())?;
        if unsafe { libc::unlinkat(self.dir.as_raw_fd(), n.as_ptr(), 0) } != 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                return Ok(());
            }
            return Err(invalid());
        }
        io(self.dir.sync_all())
    }
    pub fn write(&self, target: &str, pending: &str, bytes: &[u8]) -> Result<()> {
        self.check()?;
        let temp = name(pending.as_ref())?;
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
                    name(target.as_ref())?.as_ptr(),
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
            let _ = self.clear_pending(pending);
        }
        result
    }
}

pub(super) fn trust_file(path: &Path, secret: bool) -> Result<Vec<u8>> {
    let parent = walk(path.parent().ok_or_else(invalid)?)?;
    let file = openat(
        &parent,
        &name(path.file_name().ok_or_else(invalid)?)?,
        libc::O_RDONLY,
    )?;
    let m = io(file.metadata())?;
    if !m.is_file()
        || m.nlink() != 1
        || !(m.uid() == unsafe { libc::geteuid() } || (!secret && m.uid() == 0))
        || m.mode() & if secret { 0o177 } else { 0o022 } != 0
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, 1024 * 1024 + 1), &mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid());
    }
    Ok(bytes)
}

// Every removal stays relative to the owned directory. Symlinks are unlinked,
// never traversed, and a substituted namespace cannot redirect cleanup.
fn remove_tree(parent: &File, n: &CString) -> Result<()> {
    let dir = openat(parent, n, libc::O_RDONLY | libc::O_DIRECTORY)?;
    let duplicate = unsafe { libc::dup(dir.as_raw_fd()) };
    if duplicate < 0 {
        return Err(invalid());
    }
    let entries = unsafe { libc::fdopendir(duplicate) };
    if entries.is_null() {
        unsafe {
            libc::close(duplicate);
        }
        return Err(invalid());
    }
    let result = (|| {
        loop {
            let entry = unsafe { libc::readdir(entries) };
            if entry.is_null() {
                break;
            }
            let child = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if child.to_bytes() == b"." || child.to_bytes() == b".." {
                continue;
            }
            let child = child.to_owned();
            let mut m: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    dir.as_raw_fd(),
                    child.as_ptr(),
                    &mut m,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(invalid());
            }
            if m.st_mode & libc::S_IFMT == libc::S_IFDIR {
                remove_tree(&dir, &child)?;
            } else if unsafe { libc::unlinkat(dir.as_raw_fd(), child.as_ptr(), 0) } != 0 {
                return Err(invalid());
            }
        }
        io(dir.sync_all())?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), n.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(invalid());
        }
        Ok(())
    })();
    unsafe {
        libc::closedir(entries);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_and_ca_reject_links_and_unsafe_modes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = root.join("credential");
        std::fs::write(&file, b"fixture credential").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(trust_file(&file, true).is_ok());
        let link = root.join("link");
        symlink(&file, &link).unwrap();
        assert!(trust_file(&link, true).is_err());
        assert!(trust_file(&link, false).is_err());
        std::fs::hard_link(&file, root.join("hardlink")).unwrap();
        assert!(trust_file(&file, true).is_err());
        std::fs::remove_file(root.join("hardlink")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(trust_file(&file, true).is_err());
        assert!(trust_file(&file, false).is_err());
    }
}
