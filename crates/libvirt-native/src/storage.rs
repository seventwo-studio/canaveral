//! Erasure of quarantined lease storage. Every file is held under a Linux write lease, which
//! the kernel grants only when no other process has the file open; QEMU's handles must be gone.
use crate::native::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{CString, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub cleanup_id: String,
    pub root: PathBuf,
    pub quarantine: PathBuf,
    pub fingerprint: String,
    pub storage_identity: Identity,
    pub disk_identity: Identity,
    pub storage_gid: u32,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Identity {
    device: u64,
    inode: u64,
}

impl Identity {
    fn same(&self, stat: &fs::Metadata) -> bool {
        self.device == stat.dev() && self.inode == stat.ino()
    }
}

/// Ownership checked while both files are held, before the marker can be truncated.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VerifiedOwnership {
    intent: Intent,
    marker_identity: Identity,
}

/// Durable erasure progress: verified ownership, cleared contents, then removed entries.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Erased {
    pub cleanup_id: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ownership: Option<VerifiedOwnership>,
}

/// Linux UAPI fcntl.h: the signal for lease-break notification.
const F_SETSIG: libc::c_int = 10;
const MARKER: &[u8] = b"canaveral-owner.json";
const DISK: &[u8] = b"disk.qcow2";

fn proc_path(fd: i32) -> PathBuf {
    format!("/proc/self/fd/{fd}").into()
}

fn directory(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}

/// Opens each component relative to its parent descriptor without following links. Ancestors
/// need only search permission (O_PATH); the storage parent itself is the daemon's and is read.
fn safe_directory(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err("storage parent is not absolute".into());
    }
    let parts: Vec<_> = path.components().skip(1).collect();
    let search = |path: &Path| -> Result<File> {
        Ok(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?)
    };
    let mut current = search(Path::new("/"))?;
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err("invalid storage parent".into());
        };
        let next = proc_path(current.as_raw_fd()).join(name);
        current = if index + 1 == parts.len() {
            directory(&next)?
        } else {
            search(&next)?
        };
    }
    Ok(current)
}

fn entry_stat(parent: &File, name: &OsStr) -> io::Result<fs::Metadata> {
    fs::symlink_metadata(proc_path(parent.as_raw_fd()).join(name))
}

struct Held {
    name: CString,
    file: File,
    metadata: fs::Metadata,
}

impl Held {
    /// Opens one owned file and takes a write lease on it.
    fn take(dir: &File, name: &OsStr, intent: &Intent) -> Result<Self> {
        let stat = entry_stat(dir, name)?;
        let euid = unsafe { libc::geteuid() };
        let expected = match name.as_bytes() {
            MARKER => Some((0o600, None)),
            DISK => Some((0o660, Some(intent.storage_gid))),
            _ => None,
        };
        let Some((mode, gid)) = expected else {
            return Err("unexpected entry in lease storage".into());
        };
        if !stat.is_file()
            || stat.uid() != euid
            || stat.nlink() != 1
            || stat.mode() & 0o7777 != mode
            || gid.is_some_and(|gid| stat.gid() != gid)
        {
            return Err("unsafe owned storage entry".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(proc_path(dir.as_raw_fd()).join(name))?;
        let fd = file.as_raw_fd();
        // SIGURG is ignored by default: a lease break is detected, never fatal.
        let failed = unsafe {
            libc::fcntl(fd, libc::F_SETOWN, libc::getpid()) == -1
                || libc::fcntl(fd, F_SETSIG, libc::SIGURG) == -1
                || libc::fcntl(fd, libc::F_SETLEASE, libc::F_WRLCK) == -1
        };
        if failed {
            return Err(io::Error::last_os_error().into());
        }
        let held = Self {
            name: CString::new(name.as_bytes())?,
            file,
            metadata: stat,
        };
        held.verify(dir)?;
        Ok(held)
    }

    fn verify(&self, dir: &File) -> Result<()> {
        let open = self.file.metadata()?;
        let path = entry_stat(dir, OsStr::from_bytes(self.name.as_bytes()))?;
        let original = &self.metadata;
        if [&open, &path].iter().any(|stat| {
            stat.ino() != original.ino()
                || stat.dev() != original.dev()
                || stat.uid() != original.uid()
                || stat.gid() != original.gid()
                || stat.mode() != original.mode()
                || stat.nlink() != 1
        }) || unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_GETLEASE) } != libc::F_WRLCK
        {
            return Err("owned storage identity or lease changed".into());
        }
        Ok(())
    }
}

pub fn erase(
    intent: &Intent,
    path: &Path,
    previous: Option<&Erased>,
    record: impl Fn(&Erased) -> Result<()>,
) -> Result<()> {
    if path != intent.quarantine || intent.root.parent() != intent.quarantine.parent() {
        return Err("quarantine path differs".into());
    }
    if previous.is_some_and(|state| {
        state.cleanup_id != intent.cleanup_id
            || !matches!(state.phase.as_str(), "verified" | "cleared" | "removed")
            || state
                .ownership
                .as_ref()
                .is_some_and(|ownership| ownership.intent != *intent)
            || state.phase == "verified" && state.ownership.is_none()
    }) {
        return Err("erasure receipt differs".into());
    }
    let cleared =
        previous.is_some_and(|state| matches!(state.phase.as_str(), "cleared" | "removed"));
    let mut ownership = previous.and_then(|state| state.ownership.clone());
    let state = |phase: &str, ownership: Option<VerifiedOwnership>| Erased {
        cleanup_id: intent.cleanup_id.clone(),
        phase: phase.into(),
        ownership,
    };
    let parent = safe_directory(path.parent().ok_or("missing storage parent")?)?;
    let parent_stat = parent.metadata()?;
    if parent_stat.uid() != unsafe { libc::geteuid() } || parent_stat.mode() & 0o022 != 0 {
        return Err("unsafe storage parent".into());
    }
    let name = path.file_name().ok_or("missing storage name")?;
    let root_stat = match entry_stat(&parent, name) {
        Ok(stat) => stat,
        // Missing storage counts only after durable cleared-content evidence.
        Err(error) if error.kind() == io::ErrorKind::NotFound && cleared => {
            parent.sync_all()?;
            return record(&state("removed", ownership));
        }
        Err(error) => return Err(error.into()),
    };
    if !root_stat.is_dir()
        || !intent.storage_identity.same(&root_stat)
        || root_stat.uid() != unsafe { libc::geteuid() }
        || root_stat.gid() != intent.storage_gid
        || root_stat.mode() & 0o7777 != 0o2750
    {
        return Err("quarantine directory changed".into());
    }
    let root = directory(&proc_path(parent.as_raw_fd()).join(name))?;
    let opened = root.metadata()?;
    if opened.ino() != root_stat.ino() || opened.dev() != root_stat.dev() {
        return Err("quarantine directory changed".into());
    }
    let mut held = Vec::new();
    for entry in fs::read_dir(proc_path(root.as_raw_fd()))? {
        held.push(Held::take(&root, &entry?.file_name(), intent)?);
    }
    let marker = held.iter().find(|entry| entry.name.as_bytes() == MARKER);
    let disk = held.iter().find(|entry| entry.name.as_bytes() == DISK);
    if disk.is_some_and(|entry| !intent.disk_identity.same(&entry.metadata)) {
        return Err("owned disk identity changed".into());
    }
    if let (Some(marker), Some(ownership)) = (marker, &ownership) {
        if !ownership.marker_identity.same(&marker.metadata) {
            return Err("owner marker identity changed".into());
        }
    }
    if !cleared {
        let marker = marker.ok_or("owner marker missing")?;
        disk.ok_or("owned disk missing")?;
        if ownership.is_none() || marker.metadata.len() != 0 {
            if marker.metadata.len() > 16384 {
                return Err("owner marker exceeds its envelope".into());
            }
            let mut bytes = Vec::new();
            (&marker.file).take(16385).read_to_end(&mut bytes)?;
            if serde_json::from_slice::<Value>(&bytes)?["fingerprint"]
                != intent.fingerprint.as_str()
            {
                return Err("storage owner differs".into());
            }
        }
        if ownership.is_none() {
            ownership = Some(VerifiedOwnership {
                intent: intent.clone(),
                marker_identity: Identity {
                    device: marker.metadata.dev(),
                    inode: marker.metadata.ino(),
                },
            });
            record(&state("verified", ownership.clone()))?;
        }
        // Logical erasure: contents are discarded while every lease is held.
        for entry in &held {
            entry.verify(&root)?;
            entry.file.set_len(0)?;
            entry.file.sync_all()?;
        }
        record(&state("cleared", ownership.clone()))?;
    }
    for entry in &held {
        entry.verify(&root)?;
        if entry.file.metadata()?.len() != 0 {
            return Err("owned storage holds uncleared contents".into());
        }
    }
    if fs::read_dir(proc_path(root.as_raw_fd()))?.count() != held.len() {
        return Err("owned storage membership changed".into());
    }
    for entry in &held {
        entry.verify(&root)?;
        if unsafe { libc::unlinkat(root.as_raw_fd(), entry.name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    root.sync_all()?;
    let name = CString::new(name.as_bytes())?;
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    parent.sync_all()?;
    record(&state("removed", ownership))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    struct Fixture {
        base: PathBuf,
        quarantine: PathBuf,
        intent: Intent,
    }

    fn fixture(name: &str) -> Fixture {
        let base =
            std::env::temp_dir().join(format!("libvirt-erase-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let quarantine = base.join(".removing-x");
        fs::DirBuilder::new()
            .mode(0o750)
            .create(&quarantine)
            .unwrap();
        fs::set_permissions(&quarantine, fs::Permissions::from_mode(0o2750)).unwrap();
        fs::write(
            quarantine.join("canaveral-owner.json"),
            br#"{"fingerprint":"abc"}"#,
        )
        .unwrap();
        fs::set_permissions(
            quarantine.join("canaveral-owner.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::write(quarantine.join("disk.qcow2"), b"guest data").unwrap();
        fs::set_permissions(
            quarantine.join("disk.qcow2"),
            fs::Permissions::from_mode(0o660),
        )
        .unwrap();
        let stat = |path: &Path| fs::symlink_metadata(path).unwrap();
        let identity = |path: &Path| Identity {
            device: stat(path).dev(),
            inode: stat(path).ino(),
        };
        let intent = Intent {
            cleanup_id: "c".into(),
            root: base.join("machine"),
            quarantine: quarantine.clone(),
            fingerprint: "abc".into(),
            storage_identity: identity(&quarantine),
            disk_identity: identity(&quarantine.join("disk.qcow2")),
            storage_gid: unsafe { libc::getegid() },
        };
        Fixture {
            base,
            quarantine,
            intent,
        }
    }

    #[test]
    fn erasure_clears_then_unlinks_and_resumes() {
        let f = fixture("complete");
        let states = RefCell::new(Vec::new());
        erase(&f.intent, &f.quarantine, None, |state| {
            states.borrow_mut().push(state.phase.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(*states.borrow(), ["verified", "cleared", "removed"]);
        assert!(!f.quarantine.exists());
        // A repeated call after removal needs the durable cleared evidence.
        let cleared = Erased {
            cleanup_id: "c".into(),
            phase: "cleared".into(),
            ownership: None,
        };
        erase(&f.intent, &f.quarantine, Some(&cleared), |_| Ok(())).unwrap();
        assert!(erase(&f.intent, &f.quarantine, None, |_| Ok(())).is_err());
        fs::remove_dir_all(f.base).unwrap();
    }

    #[test]
    fn crash_after_truncation_resumes_from_verified_inodes() {
        let f = fixture("after-truncate");
        let saved = RefCell::new(None);
        let marker = f.quarantine.join("canaveral-owner.json");
        assert!(erase(&f.intent, &f.quarantine, None, |state| {
            if state.phase == "cleared" {
                return Err("injected interruption before cleared receipt".into());
            }
            *saved.borrow_mut() = Some(state.clone());
            Ok(())
        })
        .is_err());
        let proof = saved.into_inner().unwrap();
        assert_eq!(proof.phase, "verified");
        assert_eq!(fs::metadata(&marker).unwrap().len(), 0);
        assert!(erase(&f.intent, &f.quarantine, None, |_| Ok(())).is_err());

        let original = f.quarantine.join("marker-original");
        fs::rename(&marker, &original).unwrap();
        File::create(&marker)
            .unwrap()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        fs::rename(&original, f.base.join("marker-original")).unwrap();
        assert!(erase(&f.intent, &f.quarantine, Some(&proof), |_| Ok(())).is_err());
        fs::rename(f.base.join("marker-original"), &marker).unwrap();
        erase(&f.intent, &f.quarantine, Some(&proof), |_| Ok(())).unwrap();
        assert!(!f.quarantine.exists());
        fs::remove_dir_all(f.base).unwrap();
    }

    #[test]
    fn erasure_refuses_open_files_foreign_entries_and_modes() {
        let f = fixture("open");
        // Another open descriptor prevents the write lease: handles are not proven closed.
        let open = File::open(f.quarantine.join("disk.qcow2")).unwrap();
        assert!(erase(&f.intent, &f.quarantine, None, |_| Ok(())).is_err());
        drop(open);
        assert_eq!(
            fs::read(f.quarantine.join("disk.qcow2")).unwrap(),
            b"guest data"
        );
        fs::write(f.quarantine.join("nvram.fd"), b"x").unwrap();
        assert!(erase(&f.intent, &f.quarantine, None, |_| Ok(())).is_err());
        fs::remove_file(f.quarantine.join("nvram.fd")).unwrap();
        fs::set_permissions(
            f.quarantine.join("disk.qcow2"),
            fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        assert!(erase(&f.intent, &f.quarantine, None, |_| Ok(())).is_err());
        fs::set_permissions(
            f.quarantine.join("disk.qcow2"),
            fs::Permissions::from_mode(0o660),
        )
        .unwrap();
        let mut foreign = f.intent.clone();
        foreign.fingerprint = "other".into();
        assert!(erase(&foreign, &f.quarantine, None, |_| Ok(())).is_err());
        assert_eq!(
            fs::read(f.quarantine.join("disk.qcow2")).unwrap(),
            b"guest data"
        );
        erase(&f.intent, &f.quarantine, None, |_| Ok(())).unwrap();
        fs::remove_dir_all(f.base).unwrap();
    }

    #[test]
    fn interrupted_erasure_accepts_only_emptied_files() {
        let f = fixture("partial");
        let cleared = Erased {
            cleanup_id: "c".into(),
            phase: "cleared".into(),
            ownership: None,
        };
        // Cleared evidence with nonempty contents is a contradiction.
        assert!(erase(&f.intent, &f.quarantine, Some(&cleared), |_| Ok(())).is_err());
        for name in ["canaveral-owner.json", "disk.qcow2"] {
            OpenOptions::new()
                .write(true)
                .open(f.quarantine.join(name))
                .unwrap()
                .set_len(0)
                .unwrap();
        }
        fs::remove_file(f.quarantine.join("canaveral-owner.json")).unwrap();
        erase(&f.intent, &f.quarantine, Some(&cleared), |_| Ok(())).unwrap();
        assert!(!f.quarantine.exists());
        fs::remove_dir_all(f.base).unwrap();
    }
}
