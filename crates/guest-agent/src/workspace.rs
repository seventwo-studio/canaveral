//! Workspace discovery, bounded signature scanning and confinement primitives.
use canaveral_guest_protocol::Result;
/// Facts collected from kernel sysfs and a read-only signature scan, never /dev ordering.
pub struct Candidate {
    pub serial: String,
    pub bytes: u64,
    pub whole: bool,
    pub signature: bool,
    pub holders: bool,
    pub root_or_launch: bool,
}
/// Select only a unique serial match. A mismatched/unsafe matching device is fatal.
pub fn discover(candidates: &[Candidate], serial: &str, bytes: u64) -> Result<usize> {
    if !canaveral_guest_protocol::data::lower_hex(serial, 20)
        || bytes < 16777216
        || !bytes.is_multiple_of(4096)
    {
        return Err("invalid workspace identity".into());
    }
    let mut matches = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.serial == serial);
    let (index, c) = matches.next().ok_or("workspace device missing")?;
    if matches.next().is_some()
        || c.bytes != bytes
        || !c.whole
        || c.signature
        || c.holders
        || c.root_or_launch
    {
        return Err("workspace device is ambiguous or unsafe".into());
    }
    Ok(index)
}
/// Portable decision, used after fstat. Nonregular files must be rejected before I/O.
pub struct Identity {
    pub regular: bool,
    pub uid: u32,
    pub links: u64,
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
    pub mtime: (i64, i64),
    pub ctime: (i64, i64),
}
impl Identity {
    pub fn eligible(&self, device: u64) -> Result<()> {
        if !self.regular || self.uid != 1000 || self.links != 1 || self.device != device {
            return Err("ineligible workspace file".into());
        }
        Ok(())
    }
    pub fn unchanged(&self, other: &Self) -> bool {
        self.regular == other.regular
            && self.uid == other.uid
            && self.links == other.links
            && self.device == other.device
            && self.inode == other.inode
            && self.bytes == other.bytes
            && self.mtime == other.mtime
            && self.ctime == other.ctime
    }
}
/// No platform fallback: only Linux openat2 may resolve guest file paths.
#[cfg(target_os = "linux")]
pub mod confined {
    use super::*;
    use canaveral_guest_protocol::data::path;
    use std::{
        ffi::CString,
        fs::File,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
    };
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    const RESOLVE: u64 = 0x08 | 0x04 | 0x02 | 0x01; // BENEATH, NO_SYMLINKS, NO_MAGICLINKS, NO_XDEV
    pub struct Root {
        root: File,
        device: u64,
    }
    impl Root {
        /// Caller supplies the descriptor pinned immediately after mounting ext4.
        pub fn new(root: File) -> Result<Self> {
            let m = root.metadata()?;
            if !m.is_dir() || m.uid() != 1000 || m.gid() != 1000 || m.mode() & 0o7777 != 0o700 {
                return Err("unsafe workspace root".into());
            }
            // Probe syscall/resolve support before files readiness. No realpath fallback.
            let probe = lookup(&root, ".", libc::O_RDONLY | libc::O_DIRECTORY)?;
            drop(probe);
            Ok(Self {
                root,
                device: m.dev(),
            })
        }
        pub fn open_read(&self, name: &str) -> Result<File> {
            path(name)?;
            if unsafe { libc::geteuid() } != 1000 || unsafe { libc::getegid() } != 1000 {
                return Err("file worker must run as uid/gid 1000".into());
            }
            let groups = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
            if groups != 0 {
                return Err("file worker has supplementary groups".into());
            }
            let file = lookup(&self.root, name, libc::O_RDONLY)?;
            identity(&file)?.eligible(self.device)?;
            Ok(file)
        }
        /// Rewalk from the pinned root immediately before publication. A renamed,
        /// replaced or unreachable parent must not receive an upload.
        pub fn parent_reachable(&self, name: &str, parent: &File) -> Result<()> {
            path(name)?;
            let parent_name = name.rsplit_once('/').map_or(".", |(p, _)| p);
            let current = lookup(&self.root, parent_name, libc::O_RDONLY | libc::O_DIRECTORY)?;
            let (a, b) = (current.metadata()?, parent.metadata()?);
            if a.dev() != self.device || a.dev() != b.dev() || a.ino() != b.ino() {
                return Err("destination parent changed".into());
            }
            Ok(())
        }
    }
    fn lookup(root: &File, name: &str, flags: i32) -> Result<File> {
        let name = CString::new(name)?;
        let how = OpenHow {
            flags: (flags | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: RESOLVE,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root.as_raw_fd(),
                name.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd as i32) })
    }
    pub fn identity(file: &File) -> Result<Identity> {
        let m = file.metadata()?;
        Ok(Identity {
            regular: m.is_file(),
            uid: m.uid(),
            links: m.nlink(),
            device: m.dev(),
            inode: m.ino(),
            bytes: m.len(),
            mtime: (m.mtime(), m.mtime_nsec()),
            ctime: (m.ctime(), m.ctime_nsec()),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serial_size_and_signature_discovery() {
        let mut c = Candidate {
            serial: "a".repeat(20),
            bytes: 16777216,
            whole: true,
            signature: false,
            holders: false,
            root_or_launch: false,
        };
        assert_eq!(
            discover(std::slice::from_ref(&c), &c.serial, c.bytes).unwrap(),
            0
        );
        for field in 0..5 {
            match field {
                0 => c.signature = true,
                1 => {
                    c.signature = false;
                    c.holders = true
                }
                2 => {
                    c.holders = false;
                    c.root_or_launch = true
                }
                3 => {
                    c.root_or_launch = false;
                    c.whole = false
                }
                _ => {
                    c.whole = true;
                    c.bytes += 4096
                }
            }
            assert!(discover(std::slice::from_ref(&c), &c.serial, 16777216).is_err());
        }
        c.bytes = 16777216;
        assert!(discover(
            &[
                c,
                Candidate {
                    serial: "a".repeat(20),
                    bytes: 16777216,
                    whole: true,
                    signature: false,
                    holders: false,
                    root_or_launch: false
                }
            ],
            &"a".repeat(20),
            16777216
        )
        .is_err());
        assert!(discover(&[], &"a".repeat(20), 16777216).is_err());
    }
    #[test]
    fn nonregular_hardlink_cross_device_and_mutation_decisions() {
        let mut i = Identity {
            regular: true,
            uid: 1000,
            links: 1,
            device: 1,
            inode: 2,
            bytes: 3,
            mtime: (1, 0),
            ctime: (1, 0),
        };
        assert!(i.eligible(1).is_ok());
        assert!(i.eligible(2).is_err());
        // FIFOs, devices, symlinks, directories and sockets all fail regular-file check.
        i.regular = false;
        assert!(i.eligible(1).is_err());
        i.regular = true;
        i.links = 2;
        assert!(i.eligible(1).is_err());
        i.links = 1;
        i.uid = 0;
        assert!(i.eligible(1).is_err());
        i.uid = 1000;
        let mut j = Identity {
            regular: true,
            uid: 1000,
            links: 1,
            device: 1,
            inode: 2,
            bytes: 3,
            mtime: (1, 0),
            ctime: (1, 0),
        };
        assert!(i.unchanged(&j));
        j.ctime.1 = 1;
        assert!(!i.unchanged(&j));
    }
}

/// Defense-in-depth scan of signature regions on a fresh preallocated disk.
/// Reads at most 2 MiB plus two 4 KiB btrfs mirrors, independent of disk size.
/// Fresh creation by the satellite, rather than this scan, establishes blank media.
pub fn require_blank(
    reader: &mut (impl std::io::Read + std::io::Seek),
    expected_bytes: u64,
) -> Result<()> {
    use std::io::SeekFrom;
    const MIB: u64 = 1024 * 1024;
    if expected_bytes < 2 * MIB {
        return Err("workspace too small for signature scan".into());
    }
    // Primary/backup partition tables, ext/XFS/swap and primary btrfs live
    // in these windows. Include btrfs mirror superblocks when present.
    let mut regions = vec![(0, MIB), (expected_bytes - MIB, MIB)];
    for offset in [64 * MIB, 256 * 1024 * MIB] {
        if offset + 4096 <= expected_bytes {
            regions.push((offset, 4096));
        }
    }
    let mut buffer = [0; 65536];
    for (offset, length) in regions {
        reader.seek(SeekFrom::Start(offset))?;
        let mut remaining = length;
        while remaining != 0 {
            let n = remaining.min(buffer.len() as u64) as usize;
            reader.read_exact(&mut buffer[..n])?;
            if buffer[..n].iter().any(|b| *b != 0) {
                return Err("workspace contains existing signatures".into());
            }
            remaining -= n as u64;
        }
    }
    Ok(())
}

#[cfg(test)]
mod blank_tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn signature_windows_and_bounded_reads() {
        let size = 16 * 1024 * 1024;
        let mut bytes = vec![0; size];
        for offset in [0, 510, 512, 1080, 4095, 65536, size - 1, size - 1048576] {
            bytes[offset] = 1;
            assert!(require_blank(&mut Cursor::new(&bytes), size as u64).is_err());
            bytes[offset] = 0;
        }
        // Interior bytes are deliberately outside this defense-in-depth scan.
        bytes[size / 2] = 1;
        assert!(require_blank(&mut Cursor::new(&bytes), size as u64).is_ok());
        assert!(require_blank(&mut Cursor::new(&bytes[..1024]), size as u64).is_err());
        struct Huge {
            position: u64,
            read: u64,
        }
        impl std::io::Seek for Huge {
            fn seek(&mut self, p: std::io::SeekFrom) -> std::io::Result<u64> {
                let std::io::SeekFrom::Start(p) = p else {
                    panic!()
                };
                self.position = p;
                Ok(p)
            }
        }
        impl std::io::Read for Huge {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                b.fill(0);
                self.read += b.len() as u64;
                self.position += b.len() as u64;
                Ok(b.len())
            }
        }
        let mut disk = Huge {
            position: 0,
            read: 0,
        };
        require_blank(&mut disk, 1024 * 1024 * 1024 * 1024).unwrap();
        assert_eq!(disk.read, 2 * 1024 * 1024 + 8192);
    }
}
