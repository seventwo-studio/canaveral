//! Fresh per-launch bootstrap medium: a tiny EROFS image holding only `launch.json`.
//!
//! The operator-installed, digest-pinned builder is invoked with a fixed argv, a cleared
//! environment, no shell, no stdio, a file-size rlimit and a wall-clock bound. The staging
//! root is one 0700 directory containing one 0400 regular file; `--all-root` records both
//! as uid/gid 0 as the guest agent requires. The filesystem UUID is the boot attempt, which
//! also derives the virtio serial. This module never mounts, formats or downloads anything.
use crate::{bundle, io, Result};
use canaveral_guest_protocol::bundle::Launch;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
/// Upper bound for the produced image; a launch.json medium is a few KiB.
pub const MEDIUM_MAX: u64 = 1 << 20;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Exact erofs-utils `mkfs.erofs [OPTIONS] DESTINATION SOURCE` invocation.
/// Pin 4 KiB blocks: macOS may default to its 16 KiB host page size, which
/// a guest kernel with 4 KiB pages cannot mount.
pub fn argv(filesystem: uuid::Uuid, destination: &Path, source: &Path) -> Vec<OsString> {
    let mut out: Vec<OsString> = ["--quiet", "--all-root", "-b4096", "-T", "0", "-U"]
        .into_iter()
        .map(Into::into)
        .collect();
    out.push(filesystem.hyphenated().to_string().into());
    out.push(destination.into());
    out.push(source.into());
    out
}
fn run(builder: &bundle::Builder, args: &[OsString], cwd: &Path) -> Result<()> {
    let mut command = Command::new(&builder.path);
    command
        .args(args)
        .env_clear()
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setrlimit is async-signal-safe and touches no parent state.
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: MEDIUM_MAX as libc::rlim_t,
                rlim_max: MEDIUM_MAX as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| "bootstrap builder could not start")?;
    let start = crate::clock::Clock::now();
    loop {
        if let Some(status) = io(child.try_wait())? {
            return if status.success() {
                Ok(())
            } else {
                Err("bootstrap builder failed")
            };
        }
        if start.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("bootstrap builder timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
/// Builds `dir/launch.erofs` for exactly this launch and returns its admission pin.
pub fn build(builder: &bundle::Builder, dir: &Path, launch: &Launch) -> Result<bundle::Pinned> {
    if !bundle::SUPPORTED {
        return Err("bootstrap medium requires macOS immutable files");
    }
    bundle::verify_builder(builder)?;
    let bytes = launch.to_bytes().map_err(|_| "invalid launch binding")?;
    let mkdir = |path: &Path| {
        io(std::fs::DirBuilder::new().mode(0o700).create(path))?;
        io(std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(0o700),
        ))
    };
    mkdir(dir)?;
    let stage = dir.join("stage");
    mkdir(&stage)?;
    let config = stage.join("launch.json");
    let mut f = io(std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&config))?;
    io(f.write_all(&bytes))?;
    io(f.set_permissions(std::fs::Permissions::from_mode(0o400)))?;
    io(f.sync_all())?;
    drop(f);
    // Strict staging inventory: one regular file, no links, nothing else.
    let entries: Vec<_> = io(std::fs::read_dir(&stage))?
        .collect::<std::io::Result<_>>()
        .map_err(|_| "staging unreadable")?;
    if entries.len() != 1
        || entries[0].file_name() != "launch.json"
        || !io(std::fs::symlink_metadata(&config))?.is_file()
    {
        return Err("unexpected bootstrap staging content");
    }
    let medium = dir.join("launch.erofs");
    let built = run(
        builder,
        &argv(launch.binding.boot_attempt, &medium, &stage),
        dir,
    );
    io(std::fs::remove_file(&config))?;
    io(std::fs::remove_dir(&stage))?;
    built?;
    seal(&medium)
}
/// Verifies the produced image, then fixes mode, flushes media and sets user-immutable.
fn seal(medium: &Path) -> Result<bundle::Pinned> {
    let mut file = io(std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(medium))?;
    let m = io(file.metadata())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.len() < 1028
        || m.len() > MEDIUM_MAX
    {
        return Err("bootstrap medium output rejected");
    }
    let mut bytes = Vec::new();
    io((&mut file).take(MEDIUM_MAX + 1).read_to_end(&mut bytes))?;
    if bytes.len() as u64 != m.len() || bytes[1024..1028] != bundle::EROFS_MAGIC {
        return Err("bootstrap medium is not EROFS");
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    io(file.set_permissions(std::fs::Permissions::from_mode(0o400)))?;
    io(file.sync_all())?;
    durable(&file)?;
    io(File::open(medium.parent().ok_or("invalid medium path")?).and_then(|d| d.sync_all()))?;
    bundle::hash("launchMedium", medium, m.len(), &sha256)
}
#[cfg(target_os = "macos")]
fn durable(file: &File) -> Result<()> {
    use std::os::fd::AsRawFd;
    // Darwin F_FULLFSYNC flushes the drive cache, as the helper requires before start.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } != 0
        || unsafe { libc::fchflags(file.as_raw_fd(), libc::UF_IMMUTABLE) } != 0
    {
        return Err("cannot seal bootstrap medium");
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn durable(_: &File) -> Result<()> {
    Err("bootstrap medium requires macOS")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_mkfs_erofs_argv() {
        let id = uuid::Uuid::from_u128(0xabc);
        let args = argv(id, Path::new("/w/launch.erofs"), Path::new("/w/stage"));
        assert_eq!(
            args,
            [
                "--quiet",
                "--all-root",
                "-b4096",
                "-T",
                "0",
                "-U",
                "00000000-0000-0000-0000-000000000abc",
                "/w/launch.erofs",
                "/w/stage"
            ]
            .map(OsString::from)
        );
    }
}
