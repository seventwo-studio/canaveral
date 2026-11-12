//! Owned writable media. Journal callbacks must durably publish before returning.
//! A failed callback or uncertain syscall never authorizes another create attempt.
use crate::{io, private, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Disk {
    pub serial: String,
    pub bytes: u64,
    pub identity: Option<Identity>,
    pub allocated: bool,
    pub deleting: bool,
    pub removed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    device: u64,
    inode: u64,
}
impl Disk {
    pub fn intent(serial: String, bytes: u64, launch_serial: &str) -> Result<Self> {
        if !canaveral_guest_protocol::data::lower_hex(&serial, 20)
            || serial == launch_serial
            || bytes < 16777216
            || !bytes.is_multiple_of(4096)
            || bytes > canaveral_guest_protocol::MAX_SAFE
        {
            return Err("invalid workspace disk intent");
        }
        Ok(Self {
            serial,
            bytes,
            identity: None,
            allocated: false,
            deleting: false,
            removed: false,
        })
    }
}
fn parent(path: &Path) -> Result<File> {
    let dir = private::walk(path)?;
    let m = io(dir.metadata())?;
    if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7777 != 0o700 {
        return Err("unsafe workspace disk directory");
    }
    Ok(dir)
}
fn identity(file: &File) -> Result<Identity> {
    let m = io(file.metadata())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o7777 != 0o600
    {
        return Err("unsafe workspace disk");
    }
    Ok(Identity {
        device: m.dev(),
        inode: m.ino(),
    })
}
fn open(dir: &File, flags: i32) -> Result<File> {
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c"workspace.raw".as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("workspace disk open failed; retain state");
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
/// Persist intent before exclusive creation, then inode identity before allocation.
/// Only Darwin's all-or-nothing physical reservation is a production provider.
pub fn create(
    path: &Path,
    disk: &mut Disk,
    mut save: impl FnMut(&Disk) -> Result<()>,
) -> Result<()> {
    create_with(path, disk, &mut save, reserve)
}
fn create_with(
    path: &Path,
    disk: &mut Disk,
    save: &mut impl FnMut(&Disk) -> Result<()>,
    allocate: impl FnOnce(&File, u64) -> Result<()>,
) -> Result<()> {
    if disk.identity.is_some() || disk.allocated || disk.deleting || disk.removed {
        return Err("workspace create attempt consumed");
    }
    save(disk)?;
    let dir = parent(path)?;
    let file = open(&dir, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
    // A restrictive umask may remove owner bits; set the exact private mode.
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
        return Err("workspace chmod failed");
    }
    disk.identity = Some(identity(&file)?);
    io(dir.sync_all())?;
    save(disk)?;
    allocate(&file, disk.bytes)?;
    io(file.set_len(disk.bytes))?;
    io(file.sync_all())?;
    if identity(&file)? != *disk.identity.as_ref().ok_or("missing disk identity")?
        || io(file.metadata())?.len() != disk.bytes
    {
        return Err("workspace disk changed during allocation");
    }
    io(dir.sync_all())?;
    disk.allocated = true;
    save(disk)
}
#[cfg(target_os = "macos")]
fn reserve(file: &File, bytes: u64) -> Result<()> {
    let mut store = libc::fstore_t {
        fst_flags: libc::F_ALLOCATEALL,
        fst_posmode: libc::F_PEOFPOSMODE,
        fst_offset: 0,
        fst_length: bytes
            .try_into()
            .map_err(|_| "workspace allocation overflow")?,
        fst_bytesalloc: 0,
    };
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_PREALLOCATE, &mut store) } != 0
        || store.fst_bytesalloc < store.fst_length
    {
        return Err("physical workspace reservation unavailable");
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn reserve(_: &File, _: u64) -> Result<()> {
    Err("physical workspace reservation requires Darwin")
}
/// Recheck the writable medium immediately before helper prepare. Unlike immutable
/// artifacts, contents may change after attachment; identity and length may not.
pub fn verify(path: &Path, disk: &Disk) -> Result<()> {
    if !disk.allocated || disk.deleting || disk.removed {
        return Err("workspace disk is not allocated for launch");
    }
    let dir = parent(path)?;
    let file = open(&dir, libc::O_RDWR)?;
    if Some(identity(&file)?) != disk.identity || io(file.metadata())?.len() != disk.bytes {
        return Err("workspace disk changed before prepare");
    }
    Ok(())
}
/// Caller must first prove helper exit, lock release and no outstanding handles.
/// Missing identity is an uncertain creation, never positive removal evidence.
pub fn remove(
    path: &Path,
    disk: &mut Disk,
    mut save: impl FnMut(&Disk) -> Result<()>,
) -> Result<()> {
    let expected = disk
        .identity
        .as_ref()
        .ok_or("unidentified workspace disk; retain state")?
        .clone();
    let dir = parent(path)?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            c"workspace.raw".as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) || !disk.deleting {
            return Err("workspace disk missing without deletion intent");
        }
    } else {
        let file = open(&dir, libc::O_RDONLY)?;
        if identity(&file)? != expected {
            return Err("workspace disk identity changed; retain state");
        }
        disk.deleting = true;
        save(disk)?;
        // The directory is exclusively owned by this executor. Recheck after journal I/O.
        let current = open(&dir, libc::O_RDONLY)?;
        if identity(&current)? != expected {
            return Err("workspace disk changed before unlink");
        }
        if unsafe { libc::unlinkat(dir.as_raw_fd(), c"workspace.raw".as_ptr(), 0) } != 0 {
            return Err("workspace disk unlink uncertain");
        }
    }
    io(dir.sync_all())?;
    disk.removed = true;
    save(disk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn setup() -> (tempfile::TempDir, Disk) {
        let t = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        (
            t,
            Disk::intent("b".repeat(20), 16777216, &"a".repeat(20)).unwrap(),
        )
    }
    // Fixture allocator proves lifecycle ordering only, not physical reservation.
    fn fixture(_: &File, _: u64) -> Result<()> {
        Ok(())
    }
    #[test]
    fn durable_order_and_exclusive_creation() {
        let (t, mut d) = setup();
        let mut states = Vec::new();
        create_with(
            t.path(),
            &mut d,
            &mut |d| {
                states.push(d.clone());
                Ok(())
            },
            fixture,
        )
        .unwrap();
        assert!(states[0].identity.is_none());
        assert!(states[1].identity.is_some() && !states[1].allocated);
        assert!(states[2].allocated);
        verify(t.path(), &d).unwrap();
        assert_eq!(
            std::fs::metadata(t.path().join("workspace.raw"))
                .unwrap()
                .len(),
            d.bytes
        );
        assert!(create_with(t.path(), &mut d, &mut |_| Ok(()), fixture).is_err());
        remove(t.path(), &mut d, |_| Ok(())).unwrap();
        assert!(d.removed && !t.path().join("workspace.raw").exists());
        remove(t.path(), &mut d, |_| Ok(())).unwrap();
    }
    #[test]
    fn changed_length_links_and_failed_deletion_journal_are_retained() {
        let (t, mut d) = setup();
        create_with(t.path(), &mut d, &mut |_| Ok(()), fixture).unwrap();
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(t.path().join("workspace.raw"))
            .unwrap();
        f.set_len(4096).unwrap();
        assert!(verify(t.path(), &d).is_err());
        f.set_len(d.bytes).unwrap();
        std::fs::hard_link(t.path().join("workspace.raw"), t.path().join("alias")).unwrap();
        assert!(verify(t.path(), &d).is_err());
        assert!(remove(t.path(), &mut d, |_| Ok(())).is_err());
        std::fs::remove_file(t.path().join("alias")).unwrap();
        assert!(remove(t.path(), &mut d, |_| Err("journal")).is_err());
        assert!(t.path().join("workspace.raw").exists());
    }
    #[test]
    fn failed_allocation_is_owned_and_removable() {
        let (t, mut d) = setup();
        assert!(create_with(t.path(), &mut d, &mut |_| Ok(()), |_, _| Err("no space")).is_err());
        assert!(d.identity.is_some() && !d.allocated);
        remove(t.path(), &mut d, |_| Ok(())).unwrap();
    }
    #[test]
    fn journal_failure_prevents_effect_and_replacement_is_retained() {
        let (t, mut d) = setup();
        assert!(create_with(t.path(), &mut d, &mut |_| Err("journal"), fixture).is_err());
        assert!(!t.path().join("workspace.raw").exists());
        create_with(t.path(), &mut d, &mut |_| Ok(()), fixture).unwrap();
        std::fs::rename(t.path().join("workspace.raw"), t.path().join("original")).unwrap();
        std::fs::write(t.path().join("workspace.raw"), b"other").unwrap();
        assert!(remove(t.path(), &mut d, |_| Ok(())).is_err());
        std::fs::remove_file(t.path().join("workspace.raw")).unwrap();
        symlink(t.path().join("original"), t.path().join("workspace.raw")).unwrap();
        assert!(remove(t.path(), &mut d, |_| Ok(())).is_err());
        assert!(t.path().join("original").exists());
    }
    #[test]
    fn missing_without_intent_and_duplicate_serial_fail() {
        let (t, mut d) = setup();
        create_with(t.path(), &mut d, &mut |_| Ok(()), fixture).unwrap();
        std::fs::remove_file(t.path().join("workspace.raw")).unwrap();
        assert!(remove(t.path(), &mut d, |_| Ok(())).is_err());
        assert!(Disk::intent("a".repeat(20), 16777216, &"a".repeat(20)).is_err());
    }
}
