//! Private per-lease journal: the daemon's assignment folder, pinned by descriptor.
use crate::native::Result;
use serde::{de::DeserializeOwned, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const RECORD_LIMIT: u64 = 32768;
/// The lease lock. The guardian holds it for its lifetime; the daemon's fence and erase
/// commands act only after acquiring it, which proves the guardian is gone.
pub const LOCK: &str = "libvirt-native.lock";

fn private(metadata: &fs::Metadata) -> bool {
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

pub struct Journal {
    dir: File,
}

impl Journal {
    pub fn open(path: &Path) -> Result<Self> {
        let dir = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        if !private(&dir.metadata()?) {
            return Err("journal is not private".into());
        }
        Ok(Self { dir })
    }

    fn pinned(&self, name: &str) -> PathBuf {
        format!("/proc/self/fd/{}/{name}", self.dir.as_raw_fd()).into()
    }

    pub fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(self.pinned(name))
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let before = file.metadata()?;
        if !before.is_file()
            || !private(&before)
            || before.nlink() != 1
            || before.len() > RECORD_LIMIT
        {
            return Err("invalid journal record".into());
        }
        let mut bytes = Vec::new();
        (&file).take(RECORD_LIMIT + 1).read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 != before.len()
            || after.ctime() != before.ctime()
            || after.ctime_nsec() != before.ctime_nsec()
        {
            return Err("journal changed while reading".into());
        }
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    /// Synchronized atomic replacement through the pinned directory.
    pub fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let temp = self.pinned(&format!(".{name}.{}.tmp", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        let result = (|| -> Result<()> {
            serde_json::to_writer(&mut file, value)?;
            file.sync_all()?;
            fs::rename(&temp, self.pinned(name))?;
            self.dir.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    /// Takes the lease lock without waiting. `Ok(None)` means a live holder has it.
    pub fn lock(&self) -> Result<Option<File>> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(self.pinned(LOCK))?;
        let metadata = lock.metadata()?;
        if !metadata.is_file() || !private(&metadata) || metadata.nlink() != 1 {
            return Err("lease lock is not private".into());
        }
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                Ok(None)
            } else {
                Err(error.into())
            };
        }
        Ok(Some(lock))
    }
}
