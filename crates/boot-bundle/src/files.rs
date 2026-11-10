use canaveral_guest_protocol::Result;
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path},
};
fn at(dir: &File, name: &str, flags: i32, mode: u32) -> Result<File> {
    let name = CString::new(name)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            mode,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub fn directory(path: &Path) -> Result<File> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut d = File::open("/")?;
    trusted_directory(&d)?;
    for c in absolute.components() {
        match c {
            Component::RootDir => (),
            Component::Normal(n) => {
                d = at(
                    &d,
                    n.to_str().ok_or("non-UTF8 path")?,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                    0,
                )?
            }
            _ => return Err("unsafe directory ancestry".into()),
        }
        trusted_directory(&d)?;
    }
    Ok(d)
}
fn trusted_directory(d: &File) -> Result<()> {
    let m = d.metadata()?;
    let uid = unsafe { libc::geteuid() };
    if (m.uid() != 0 && m.uid() != uid)
        || (m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
    {
        return Err("unsafe directory ownership/permissions".into());
    }
    Ok(())
}
pub fn relative(root: &File, path: &str) -> Result<File> {
    let mut d = root.try_clone()?;
    let parts: Vec<_> = path.split('/').collect();
    for (i, c) in parts.iter().enumerate() {
        if c.is_empty() || *c == "." || *c == ".." {
            return Err("unsafe artifact path".into());
        }
        d = at(
            &d,
            c,
            libc::O_RDONLY
                | if i + 1 < parts.len() {
                    libc::O_DIRECTORY
                } else {
                    0
                },
            0,
        )?;
        if i + 1 < parts.len() {
            trusted_directory(&d)?;
        }
    }
    Ok(d)
}
pub fn regular(m: &Metadata, size: u64) -> Result<()> {
    if !m.is_file() || m.nlink() != 1 || m.len() != size {
        return Err("single-link regular artifact of exact size required".into());
    }
    Ok(())
}
pub fn unchanged(a: &Metadata, b: &Metadata) -> Result<()> {
    if (
        a.dev(),
        a.ino(),
        a.len(),
        a.nlink(),
        a.mtime(),
        a.mtime_nsec(),
        a.ctime(),
        a.ctime_nsec(),
    ) != (
        b.dev(),
        b.ino(),
        b.len(),
        b.nlink(),
        b.mtime(),
        b.mtime_nsec(),
        b.ctime(),
        b.ctime_nsec(),
    ) {
        return Err("input changed".into());
    }
    Ok(())
}
pub struct Stage {
    parent: File,
    dir: File,
    name: CString,
    output: CString,
    files: Vec<String>,
    published: bool,
}
impl Stage {
    pub fn new(output: &Path) -> Result<Self> {
        let parent = directory(
            output
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
        let output = CString::new(
            output
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("invalid output")?,
        )?;
        // mkdirat exclusively creates this name. Never adopt leftover/interrupted staging.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let name = CString::new(format!(".canaveral-stage-{}-{nonce}", std::process::id()))?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let dir = at(
            &parent,
            name.to_str()?,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        dir.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            parent,
            dir,
            name,
            output,
            files: Vec::new(),
            published: false,
        })
    }
    pub fn create(&mut self, name: &str) -> Result<File> {
        let f = at(
            &self.dir,
            name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        self.files.push(name.into());
        f.set_permissions(std::fs::Permissions::from_mode(0o400))?;
        Ok(f)
    }
    pub fn open(&self, name: &str) -> Result<File> {
        at(&self.dir, name, libc::O_RDONLY, 0)
    }
    pub fn write(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut f = self.create(name)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    }
    pub fn remove(&self, name: &str) -> Result<()> {
        let n = CString::new(name)?;
        if unsafe { libc::unlinkat(self.dir.as_raw_fd(), n.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    pub fn publish(&mut self) -> Result<()> {
        let current = at(
            &self.parent,
            self.name.to_str()?,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        let a = current.metadata()?;
        let b = self.dir.metadata()?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err("staging entry changed".into());
        }
        self.dir.sync_all()?;
        #[cfg(target_os = "linux")]
        let rc = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                self.parent.as_raw_fd(),
                self.output.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let rc = unsafe {
            libc::renameatx_np(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                self.parent.as_raw_fd(),
                self.output.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let rc = -1;
        if rc != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        self.published = true;
        self.parent.sync_all()?;
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if self.published {
            return;
        } // Remove only known files through our original directory descriptor.
        for f in &self.files {
            let _ = self.remove(f);
        }
        let current = at(
            &self.parent,
            self.name.to_str().unwrap_or(""),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        );
        if let Ok(d) = current {
            if let (Ok(a), Ok(b)) = (d.metadata(), self.dir.metadata()) {
                if a.dev() == b.dev() && a.ino() == b.ino() {
                    unsafe {
                        libc::unlinkat(
                            self.parent.as_raw_fd(),
                            self.name.as_ptr(),
                            libc::AT_REMOVEDIR,
                        );
                    }
                }
            }
        }
        let _ = self.parent.sync_all();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutation_metadata_rejected() {
        let path = std::env::temp_dir().join(format!("boot-mutation-{}", std::process::id()));
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        let before = f.metadata().unwrap();
        f.write_all(b"changed").unwrap();
        assert!(unchanged(&before, &f.metadata().unwrap()).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
