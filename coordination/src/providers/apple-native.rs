//! Descriptor-relative storage removal and birth-bound legacy process fencing.
//! No VM is started. A signal is sent only by the explicit terminate command.
//! Build for installation beside apple.js: rustc --edition=2024 -O apple-native.rs -o apple-native-helper
//! The controller retains the removal journal; this helper never invents ownership or stop evidence.
#![deny(unsafe_op_in_unsafe_fn)]
use std::{
    env,
    ffi::{CStr, CString, OsStr},
    fs::{File, OpenOptions},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Component, Path},
};

#[cfg(target_os = "macos")]
const DIRECTORY: i32 = 0x100000;
#[cfg(target_os = "macos")]
const NOFOLLOW: i32 = 0x100;
#[cfg(target_os = "macos")]
const CLOEXEC: i32 = 0x1000000;
#[cfg(target_os = "macos")]
const REMOVEDIR: i32 = 0x80;
#[cfg(target_os = "macos")]
const NONBLOCK: i32 = 4;
#[cfg(target_os = "linux")]
const DIRECTORY: i32 = 0x10000;
#[cfg(target_os = "linux")]
const NOFOLLOW: i32 = 0x20000;
#[cfg(target_os = "linux")]
const CLOEXEC: i32 = 0x80000;
#[cfg(target_os = "linux")]
const REMOVEDIR: i32 = 0x200;
#[cfg(target_os = "linux")]
const NONBLOCK: i32 = 0x800;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("Native provider storage helper supports Darwin and Linux only.");

unsafe extern "C" {
    fn openat(fd: i32, name: *const i8, flags: i32, ...) -> i32;
    fn unlinkat(fd: i32, name: *const i8, flags: i32) -> i32;
    fn dup(fd: i32) -> i32;
    fn close(fd: i32) -> i32;
    fn fdopendir(fd: i32) -> *mut std::ffi::c_void;
    fn readdir(dir: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn closedir(dir: *mut std::ffi::c_void) -> i32;
    fn geteuid() -> u32;
    #[cfg(target_os = "macos")]
    fn __error() -> *mut i32;
    #[cfg(target_os = "linux")]
    fn __errno_location() -> *mut i32;
    #[cfg(target_os = "macos")]
    fn renameatx_np(from: i32, source: *const i8, to: i32, target: *const i8, flags: u32) -> i32;
    #[cfg(target_os = "linux")]
    fn renameat2(from: i32, source: *const i8, to: i32, target: *const i8, flags: u32) -> i32;
}
fn refused() -> io::Error {
    io::Error::other("native storage identity, ownership, or removal is unconfirmed")
}
fn name(value: &OsStr) -> io::Result<CString> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(refused());
    }
    CString::new(bytes).map_err(|_| refused())
}
fn child(parent: &File, value: &CStr, directory: bool) -> io::Result<File> {
    let fd = unsafe {
        openat(
            parent.as_raw_fd(),
            value.as_ptr(),
            NOFOLLOW | CLOEXEC | NONBLOCK | if directory { DIRECTORY } else { 0 },
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn directory(path: &Path) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(refused());
    }
    let mut fd = OpenOptions::new()
        .read(true)
        .custom_flags(DIRECTORY | NOFOLLOW | CLOEXEC)
        .open("/")?;
    for part in path.components() {
        match part {
            Component::RootDir => (),
            Component::Normal(part) => {
                fd = child(&fd, &name(part)?, true)?;
            }
            _ => return Err(refused()),
        }
    }
    Ok(fd)
}
fn pinned(file: &File, dev: u64, ino: u64) -> io::Result<()> {
    let m = file.metadata()?;
    if !m.is_dir() || m.dev() != dev || m.ino() != ino || m.uid() != unsafe { geteuid() } {
        return Err(refused());
    }
    Ok(())
}
fn owner(file: &File, expected: &[u8]) -> io::Result<()> {
    let mut marker = child(file, c"canaveral-owner.json", false)?;
    let m = marker.metadata()?;
    if !m.is_file() || m.nlink() != 1 || m.size() > 65536 || m.uid() != unsafe { geteuid() } {
        return Err(refused());
    }
    let mut actual = Vec::new();
    Read::by_ref(&mut marker)
        .take(65537)
        .read_to_end(&mut actual)?;
    if actual != expected {
        return Err(refused());
    }
    Ok(())
}
struct Stream(*mut std::ffi::c_void);
impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            closedir(self.0);
        }
    }
}
fn errno() -> *mut i32 {
    #[cfg(target_os = "macos")]
    {
        unsafe { __error() }
    }
    #[cfg(target_os = "linux")]
    {
        unsafe { __errno_location() }
    }
}
fn names(file: &File) -> io::Result<Vec<CString>> {
    let copy = unsafe { dup(file.as_raw_fd()) };
    if copy < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { fdopendir(copy) };
    if stream.is_null() {
        unsafe {
            close(copy);
        }
        return Err(io::Error::last_os_error());
    }
    let stream = Stream(stream);
    let mut result = Vec::new();
    loop {
        unsafe {
            *errno() = 0;
        }
        let entry = unsafe { readdir(stream.0) };
        if entry.is_null() {
            if unsafe { *errno() } != 0 {
                return Err(io::Error::last_os_error());
            }
            break;
        }
        // Darwin dirent: ino64, seekoff64, reclen16, namlen16, type8, name.
        // Linux dirent64: ino64, off64, reclen16, type8, name.
        #[cfg(target_os = "macos")]
        let offset = 21;
        #[cfg(target_os = "linux")]
        let offset = 19;
        let value = unsafe { CStr::from_ptr(entry.cast::<u8>().add(offset).cast()) };
        if value.to_bytes() == b"." || value.to_bytes() == b".." {
            continue;
        }
        result.push(value.to_owned());
        if result.len() > 100000 {
            return Err(refused());
        }
    }
    Ok(result)
}
fn remove_tree(parent: &File, value: &CStr, dev: u64, ino: u64, depth: usize) -> io::Result<()> {
    if depth > 128 {
        return Err(refused());
    }
    let dir = child(parent, value, true)?;
    pinned(&dir, dev, ino)?;
    for n in names(&dir)? {
        match child(&dir, &n, true) {
            Ok(sub) => {
                let m = sub.metadata()?;
                if m.dev() != dev {
                    return Err(refused());
                }
                remove_tree(&dir, &n, dev, m.ino(), depth + 1)?;
            }
            Err(e) if matches!(e.raw_os_error(), Some(20) | Some(40) | Some(62)) => {
                // ENOTDIR or platform ELOOP: unlink the entry, never its referent.
                if unsafe { unlinkat(dir.as_raw_fd(), n.as_ptr(), 0) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Err(e) => return Err(e),
        }
    }
    dir.sync_all()?;
    let current = child(parent, value, true)?;
    pinned(&current, dev, ino)?;
    if unsafe { unlinkat(parent.as_raw_fd(), value.as_ptr(), REMOVEDIR) } != 0 {
        return Err(io::Error::last_os_error());
    }
    parent.sync_all()
}
fn hex(value: &str) -> io::Result<Vec<u8>> {
    if value.len() > 131072 || !value.len().is_multiple_of(2) || !value.is_ascii() {
        return Err(refused());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| refused()))
        .collect()
}
fn number(value: &OsStr) -> io::Result<u64> {
    value
        .to_str()
        .ok_or_else(refused)?
        .parse()
        .map_err(|_| refused())
}
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
struct BsdInfo {
    flags: u32,
    status: u32,
    xstatus: u32,
    pid: u32,
    ppid: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    reserved: u32,
    comm: [u8; 16],
    name: [u8; 32],
    nfiles: u32,
    pgid: u32,
    jobc: u32,
    tdev: u32,
    tpgid: u32,
    nice: i32,
    seconds: u64,
    micros: u64,
}
#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut std::ffi::c_void,
        size: i32,
    ) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut std::ffi::c_void) -> i32;
}
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn sysctl(
        name: *mut i32,
        namelen: u32,
        old: *mut std::ffi::c_void,
        oldlen: *mut usize,
        new: *mut std::ffi::c_void,
        newlen: usize,
    ) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}
#[cfg(target_os = "macos")]
#[derive(PartialEq)]
struct Process {
    pid: i32,
    uid: u32,
    seconds: u64,
    micros: u64,
    executable: Vec<u8>,
    argv: Vec<Vec<u8>>,
}
#[cfg(target_os = "macos")]
fn process(pid: i32) -> io::Result<Process> {
    if pid <= 1 {
        return Err(refused());
    }
    let mut info = BsdInfo::default();
    let size = std::mem::size_of::<BsdInfo>() as i32;
    if unsafe { proc_pidinfo(pid, 3, 0, (&raw mut info).cast(), size) } != size {
        return Err(refused());
    }
    let mut executable = vec![0u8; 4096];
    let count =
        unsafe { proc_pidpath(pid, executable.as_mut_ptr().cast(), executable.len() as u32) };
    if count <= 0 {
        return Err(refused());
    }
    let end = executable
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(refused)?;
    executable.truncate(end);
    let mut mib = [1, 49, pid];
    let mut buffer = vec![0u8; 262144];
    let mut count = buffer.len();
    if unsafe {
        sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &raw mut count,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || count < 5
        || count > buffer.len()
    {
        return Err(refused());
    }
    buffer.truncate(count);
    let argc = i32::from_ne_bytes(buffer[..4].try_into().map_err(|_| refused())?);
    if !(1..=128).contains(&argc) {
        return Err(refused());
    }
    let mut offset = 4;
    while offset < count && buffer[offset] != 0 {
        offset += 1;
    }
    while offset < count && buffer[offset] == 0 {
        offset += 1;
    }
    let mut argv = Vec::new();
    for _ in 0..argc {
        let end = buffer[offset..]
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(refused)?
            + offset;
        argv.push(buffer[offset..end].to_vec());
        offset = end + 1;
        if offset > count {
            return Err(refused());
        }
    }
    let mut again = BsdInfo::default();
    if unsafe { proc_pidinfo(pid, 3, 0, (&raw mut again).cast(), size) } != size
        || info.pid != pid as u32
        || again.seconds != info.seconds
        || again.micros != info.micros
        || again.ruid != info.ruid
    {
        return Err(refused());
    }
    Ok(Process {
        pid,
        uid: info.ruid,
        seconds: info.seconds,
        micros: info.micros,
        executable,
        argv,
    })
}
#[cfg(target_os = "macos")]
fn encoded(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[cfg(target_os = "macos")]
fn usage(pid: i32) -> io::Result<[u64; 3]> {
    #[repr(C)]
    struct Rusage {
        uuid: [u8; 16],
        values: [u64; 18],
    }
    let mut value = Rusage {
        uuid: [0; 16],
        values: [0; 18],
    };
    if unsafe { proc_pid_rusage(pid, 2, (&raw mut value).cast()) } != 0 {
        return Err(refused());
    }
    Ok([value.values[0], value.values[1], value.values[6]])
}
#[cfg(target_os = "macos")]
fn process_command(args: &[std::ffi::OsString]) -> io::Result<()> {
    let pid: i32 = number(&args[2])?.try_into().map_err(|_| refused())?;
    let p = process(pid)?;
    if args[1] == "process" {
        if args.len() != 3 {
            return Err(refused());
        }
        let argv = p
            .argv
            .iter()
            .map(|v| format!("\"{}\"", encoded(v)))
            .collect::<Vec<_>>()
            .join(",");
        let metrics = match usage(pid) {
            Ok([u, s, r]) => {
                format!("\"userNanoseconds\":{u},\"systemNanoseconds\":{s},\"rssBytes\":{r}")
            }
            Err(_) => {
                "\"userNanoseconds\":null,\"systemNanoseconds\":null,\"rssBytes\":null".to_owned()
            }
        };
        if process(pid)? != p {
            return Err(refused());
        }
        println!(
            "{{\"pid\":{},\"uid\":{},\"seconds\":{},\"micros\":{},\"executableHex\":\"{}\",\"argvHex\":[{}],{}}}",
            p.pid,
            p.uid,
            p.seconds,
            p.micros,
            encoded(&p.executable),
            argv,
            metrics
        );
    } else {
        if args.len() != 7
            || p.uid != unsafe { geteuid() }
            || p.seconds != number(&args[3])?
            || p.micros != number(&args[4])?
            || p.executable != hex(args[5].to_str().ok_or_else(refused)?)?
            || p.argv.len() != 3
            || p.argv[1] != b"run"
            || p.argv[2] != hex(args[6].to_str().ok_or_else(refused)?)?
            || process(pid)? != p
        {
            return Err(refused());
        }
        // Match psutil's legacy rule: recheck birth immediately before signalling.
        // No replay is permitted; the controller persists intent before this call.
        if unsafe { kill(pid, 15) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().collect();
    #[cfg(target_os = "macos")]
    if args.len() >= 3 && (args[1] == "process" || args[1] == "terminate") {
        return process_command(&args);
    }
    // MODE ROOT ROOT_DEV ROOT_INO SOURCE SOURCE_DEV SOURCE_INO OWNER_HEX [DEST]
    if args.len() != 9 && args.len() != 10 {
        return Err(refused());
    }
    let mode = args[1].to_str().ok_or_else(refused)?;
    if (mode == "erase" && args.len() != 9)
        || (mode == "quarantine" && args.len() != 10)
        || !["erase", "quarantine"].contains(&mode)
    {
        return Err(refused());
    }
    let root = directory(Path::new(&args[2]))?;
    pinned(&root, number(&args[3])?, number(&args[4])?)?;
    let source = name(&args[5])?;
    let dev = number(&args[6])?;
    let ino = number(&args[7])?;
    let dir = child(&root, &source, true)?;
    pinned(&dir, dev, ino)?;
    let marker = hex(args[8].to_str().ok_or_else(refused)?)?;
    // On resumed erasure the marker may already have been removed. The controller
    // must supply the pinned quarantine inode from its durable 'removing' intent.
    if !marker.is_empty() {
        owner(&dir, &marker)?;
    }
    if mode == "quarantine" {
        if marker.is_empty() {
            return Err(refused());
        }
        let target = name(&args[9])?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            renameatx_np(
                root.as_raw_fd(),
                source.as_ptr(),
                root.as_raw_fd(),
                target.as_ptr(),
                4,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            renameat2(
                root.as_raw_fd(),
                source.as_ptr(),
                root.as_raw_fd(),
                target.as_ptr(),
                1,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        pinned(&child(&root, &target, true)?, dev, ino)?;
        root.sync_all()?;
    } else {
        remove_tree(&root, &source, dev, ino, 0)?;
    }
    Ok(())
}
pub fn main() {
    if run().is_err() {
        eprintln!("Native storage operation is unconfirmed; retain its journal and reservations.");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::symlink,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    struct Fixture(std::path::PathBuf);
    static NEXT: AtomicU64 = AtomicU64::new(0);
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().canonicalize().unwrap().join(format!(
                "canaveral-native-storage-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn erasure_is_descriptor_relative_and_does_not_follow_external_symlinks() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("keep"), b"source image").unwrap();
        let owned = fixture.0.join("quarantine");
        fs::create_dir(&owned).unwrap();
        fs::create_dir(owned.join("native")).unwrap();
        fs::write(owned.join("native/disk.img"), b"owned disk").unwrap();
        symlink(&outside.0, owned.join("source-link")).unwrap();
        let root = directory(&fixture.0).unwrap();
        let m = fs::metadata(&owned).unwrap();
        remove_tree(&root, c"quarantine", m.dev(), m.ino(), 0).unwrap();
        assert!(!owned.exists());
        assert_eq!(fs::read(outside.0.join("keep")).unwrap(), b"source image");
    }
    #[test]
    fn wrong_inode_or_symlink_ancestor_never_authorizes_removal() {
        let fixture = Fixture::new();
        let owned = fixture.0.join("quarantine");
        fs::create_dir(&owned).unwrap();
        fs::write(owned.join("keep"), b"owned").unwrap();
        let root = directory(&fixture.0).unwrap();
        let m = fs::metadata(&owned).unwrap();
        assert!(remove_tree(&root, c"quarantine", m.dev(), m.ino() + 1, 0).is_err());
        assert!(owned.join("keep").exists());
        symlink(&owned, fixture.0.join("alias")).unwrap();
        assert!(directory(&fixture.0.join("alias")).is_err());
    }
    #[test]
    fn owner_receipt_is_bounded_and_cannot_be_replaced_by_symlink() {
        let fixture = Fixture::new();
        let expected = b"{\"fingerprint\":\"owned\"}";
        fs::write(fixture.0.join("canaveral-owner.json"), expected).unwrap();
        let dir = directory(&fixture.0).unwrap();
        owner(&dir, expected).unwrap();
        assert!(owner(&dir, b"foreign").is_err());
        fs::rename(
            fixture.0.join("canaveral-owner.json"),
            fixture.0.join("saved.json"),
        )
        .unwrap();
        symlink(
            fixture.0.join("saved.json"),
            fixture.0.join("canaveral-owner.json"),
        )
        .unwrap();
        assert!(owner(&dir, expected).is_err());
    }
}
