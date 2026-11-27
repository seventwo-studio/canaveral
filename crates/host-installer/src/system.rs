use crate::installer::{
    Enablement, Failure, Host, LinkIdentity, Result, Unit, BINARIES, ENABLEMENT, INSTALLER_STATE,
    SOCKET, UNIT, UNIT_NAME,
};
use crate::pins::Pin;
use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{
    symlink, DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt,
};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) struct Linux;
const TEMP_PREFIX: &str = ".canaveral-write-";

fn fs_error(path: &Path, error: io::Error) -> Failure {
    Failure::new("filesystem_error", format!("{}: {error}", path.display()))
}

fn unsafe_path(path: &Path) -> Failure {
    Failure::new(
        "unsafe_path",
        format!("Unsafe ownership, mode or file type: {}", path.display()),
    )
}

fn trusted(meta: &Metadata) -> bool {
    meta.uid() == 0 && trusted_mode(meta.mode())
}

fn trusted_mode(mode: u32) -> bool {
    mode & 0o7022 == 0
}

fn directory_mode(mode: u32, world_traversable: bool) -> bool {
    trusted_mode(mode) && (!world_traversable || mode & 0o001 != 0)
}

fn metadata(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(fs_error(path, error)),
    }
}

fn open_directory(path: &Path) -> Result<File> {
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| fs_error(path, e))?;
    if !trusted(&dir.metadata().map_err(|e| fs_error(path, e))?) {
        return Err(unsafe_path(path));
    }
    Ok(dir)
}

// Every ancestor has to be trusted before descending into it. The
// validated tree cannot be renamed or traversed via links by other users.
fn directory(path: &Path, create: bool) -> Result<bool> {
    directory_with_access(path, create, false)
}

fn directory_with_access(path: &Path, create: bool, world_traversable: bool) -> Result<bool> {
    let ancestors: Vec<_> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        match metadata(ancestor)? {
            Some(meta)
                if meta.is_dir()
                    && meta.uid() == 0
                    && directory_mode(meta.mode(), world_traversable) => {}
            Some(_) => return Err(unsafe_path(ancestor)),
            None if !create => return Ok(false),
            None => {
                let parent = ancestor.parent().expect("system root exists");
                let parent_fd = open_directory(parent)?;
                let created = match DirBuilder::new().mode(0o755).create(ancestor) {
                    Ok(()) => true,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
                    Err(error) => return Err(fs_error(ancestor, error)),
                };
                let fd = open_directory(ancestor)?;
                if created {
                    fd.set_permissions(fs::Permissions::from_mode(0o755))
                        .and_then(|()| fd.sync_all())
                        .and_then(|()| parent_fd.sync_all())
                        .map_err(|e| fs_error(ancestor, e))?;
                } else if !directory_mode(
                    fd.metadata().map_err(|e| fs_error(ancestor, e))?.mode(),
                    world_traversable,
                ) {
                    return Err(unsafe_path(ancestor));
                }
            }
        }
    }
    Ok(true)
}

fn private_directory(path: &Path) -> Result<()> {
    let parent = path.parent().expect("absolute private directory path");
    directory(parent, true)?;
    let parent_fd = open_directory(parent)?;
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => parent_fd.sync_all().map_err(|e| fs_error(parent, e))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(fs_error(path, error)),
    }
    let dir = open_directory(path)?;
    let meta = dir.metadata().map_err(|e| fs_error(path, e))?;
    if meta.gid() != 0 || meta.mode() & 0o7777 != 0o700 {
        return Err(unsafe_path(path));
    }
    Ok(())
}

// The caller validates the private parent. The owner arguments also allow
// unprivileged tests to check the same file and descriptor rules.
fn lock_file(path: &Path, uid: u32, gid: u32) -> Result<File> {
    let safe = |meta: &Metadata| {
        meta.is_file()
            && meta.uid() == uid
            && meta.gid() == gid
            && meta.nlink() == 1
            && meta.mode() & 0o7777 == 0o600
    };
    if metadata(path)?.is_some_and(|entry| !safe(&entry)) {
        return Err(unsafe_path(path));
    }
    let fd = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| fs_error(path, e))?;
    let opened = fd.metadata().map_err(|e| fs_error(path, e))?;
    if !safe(&opened)
        || !metadata(path)?.is_some_and(|entry| {
            safe(&entry) && (entry.dev(), entry.ino()) == (opened.dev(), opened.ino())
        })
    {
        return Err(unsafe_path(path));
    }
    if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
        return Err(Failure::new(
            "installer_busy",
            format!(
                "Could not lock {}: {}",
                path.display(),
                io::Error::last_os_error()
            ),
        ));
    }
    Ok(fd)
}

fn executable(path: &Path) -> Result<()> {
    let parent = path.parent().ok_or_else(|| unsafe_path(path))?;
    if !directory(parent, false)?
        || !metadata(path)?
            .is_some_and(|meta| meta.is_file() && trusted(&meta) && meta.mode() & 0o100 != 0)
    {
        return Err(unsafe_path(path));
    }
    Ok(())
}

fn program(path: &Path, args: &[&str]) -> Result<Output> {
    executable(path)?;
    Command::new(path)
        .args(args)
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| Failure::new("command_failed", format!("{}: {error}", path.display())))
}

fn systemctl(args: &[&str]) -> Result<Output> {
    for path in ["/usr/bin/systemctl", "/bin/systemctl"] {
        match fs::canonicalize(path) {
            Ok(path) => {
                let mut argv = vec!["--system", "--no-pager", "--no-ask-password"];
                argv.extend_from_slice(args);
                return program(&path, &argv);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(fs_error(Path::new(path), error)),
        }
    }
    Err(Failure::new(
        "systemd_unavailable",
        "systemctl was not found in the system binary directories",
    ))
}

fn command_error(args: &[&str], output: &Output) -> Failure {
    let detail = String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(1024)]);
    Failure::new(
        "command_failed",
        format!(
            "{} exited {}: {}",
            args.join(" "),
            output.status,
            detail.trim()
        ),
    )
}

fn net_error(error: impl std::fmt::Display) -> Failure {
    Failure::new("asset_download_failed", error.to_string())
}

fn fetch(pins: &[Pin; 2]) -> Result<[Vec<u8>; 2]> {
    let parent = Path::new("/var/lib");
    directory(parent, false)?;
    let stage = tempfile::Builder::new()
        .prefix(".canaveral-download-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(parent)
        .map_err(|error| fs_error(parent, error))?;
    let stage_meta = fs::symlink_metadata(stage.path()).map_err(|e| fs_error(stage.path(), e))?;
    if !stage_meta.is_dir() || stage_meta.uid() != 0 || stage_meta.mode() & 0o7777 != 0o700 {
        return Err(unsafe_path(stage.path()));
    }

    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4
                || attempt.url().scheme() != "https"
                || attempt.url().host_str() != Some("release-assets.githubusercontent.com")
            {
                attempt.error("unexpected release download redirect")
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(net_error)?;

    let download = |pin: &Pin| -> Result<Vec<u8>> {
        let path = stage.path().join(pin.name);
        let response = client
            .get(pin.url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|error| net_error(error.without_url()))?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n != pin.bytes as u64)
        {
            return Err(Failure::new(
                "asset_digest_mismatch",
                format!("Unexpected response size or status for {}", pin.name),
            ));
        }
        let mut fd = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| fs_error(&path, error))?;
        let count =
            io::copy(&mut response.take(pin.bytes as u64 + 1), &mut fd).map_err(net_error)?;
        if count != pin.bytes as u64 {
            return Err(Failure::new(
                "asset_digest_mismatch",
                format!("Downloaded size does not match {}", pin.name),
            ));
        }
        fd.rewind().map_err(|error| fs_error(&path, error))?;
        let mut bytes = Vec::with_capacity(pin.bytes);
        fd.take(pin.bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| fs_error(&path, error))?;
        Ok(bytes)
    };

    Ok([download(&pins[0])?, download(&pins[1])?])
}

impl Host for Linux {
    type Lock = File;

    fn authorize(&self) -> Result<()> {
        if unsafe { libc::geteuid() } != 0 {
            return Err(Failure::new(
                "root_required",
                "Install and remove require effective UID 0",
            ));
        }
        let proc_exe = Path::new("/proc/self/exe");
        let path = std::env::current_exe().map_err(|e| fs_error(proc_exe, e))?;
        let resolved = fs::canonicalize(&path).map_err(|e| fs_error(&path, e))?;
        executable(&resolved)?;
        let running = fs::metadata(proc_exe).map_err(|e| fs_error(proc_exe, e))?;
        let on_disk = fs::metadata(&resolved).map_err(|e| fs_error(&resolved, e))?;
        if !trusted(&running) || (running.dev(), running.ino()) != (on_disk.dev(), on_disk.ino()) {
            return Err(unsafe_path(&resolved));
        }
        // Setting the process mask makes newly made staging files private
        // even if the operator invoked the installer with a permissive mask.
        unsafe { libc::umask(0o022) };
        Ok(())
    }

    fn lock(&self) -> Result<File> {
        let directory = Path::new(INSTALLER_STATE)
            .parent()
            .expect("absolute installer state path");
        private_directory(directory)?;
        lock_file(&directory.join(".lock"), 0, 0)
    }

    fn exists(&self, path: &str) -> Result<bool> {
        Ok(metadata(Path::new(path))?.is_some())
    }

    fn check_directory(&self, path: &str, private: bool) -> Result<()> {
        let path = Path::new(path);
        if directory(path, false)? && private {
            let meta = open_directory(path)?
                .metadata()
                .map_err(|e| fs_error(path, e))?;
            if meta.gid() != 0 || meta.mode() & 0o7777 != 0o700 {
                return Err(unsafe_path(path));
            }
        }
        Ok(())
    }

    fn check_receipt_directory(&self, path: &str, create: bool) -> Result<()> {
        let parent = Path::new(path).parent().expect("absolute receipt path");
        directory_with_access(parent, create, true)?;
        Ok(())
    }

    fn check_bin(&self, path: &str) -> Result<()> {
        let path = Path::new(path);
        if directory(path, false)? {
            for entry in fs::read_dir(path).map_err(|error| fs_error(path, error))? {
                let entry = entry.map_err(|error| fs_error(path, error))?;
                let name = entry.file_name();
                if name.to_str().is_some_and(|name| BINARIES.contains(&name)) {
                    continue;
                }
                // An interrupted atomic write can leave its private temporary
                // file behind. It is never used as an executable or read back.
                if name
                    .to_str()
                    .is_some_and(|name| name.starts_with(TEMP_PREFIX))
                    && metadata(&entry.path())?
                        .is_some_and(|meta| meta.is_file() && trusted(&meta) && meta.nlink() == 1)
                {
                    continue;
                }
                return Err(unsafe_path(&entry.path()));
            }
        }
        Ok(())
    }

    fn read(&self, path: &str, mode: u32, limit: usize) -> Result<Option<Vec<u8>>> {
        let path = Path::new(path);
        if !directory(path.parent().expect("absolute file path"), false)? {
            return Ok(None);
        }
        let Some(entry) = metadata(path)? else {
            return Ok(None);
        };
        if !entry.is_file()
            || !trusted(&entry)
            || entry.nlink() != 1
            || entry.mode() & 0o7777 != mode
            || entry.len() > limit as u64
        {
            return Err(unsafe_path(path));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| fs_error(path, e))?;
        let meta = file.metadata().map_err(|e| fs_error(path, e))?;
        if (meta.dev(), meta.ino()) != (entry.dev(), entry.ino()) {
            return Err(unsafe_path(path));
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| fs_error(path, e))?;
        if bytes.len() as u64 != entry.len() {
            return Err(unsafe_path(path));
        }
        Ok(Some(bytes))
    }

    fn write(&self, path: &str, mode: u32, bytes: &[u8]) -> Result<()> {
        let path = Path::new(path);
        let parent = path.parent().expect("absolute file path");
        directory(parent, true)?;
        let parent_fd = open_directory(parent)?;
        let mut file = tempfile::Builder::new()
            .prefix(TEMP_PREFIX)
            .tempfile_in(parent)
            .map_err(|e| fs_error(path, e))?;
        file.write_all(bytes)
            .and_then(|()| {
                file.as_file()
                    .set_permissions(fs::Permissions::from_mode(mode))
            })
            .and_then(|()| file.as_file().sync_all())
            .map_err(|e| fs_error(path, e))?;
        file.persist(path).map_err(|e| fs_error(path, e.error))?;
        parent_fd.sync_all().map_err(|e| fs_error(parent, e))
    }

    fn unlink(&self, path: &str) -> Result<()> {
        let path = Path::new(path);
        let parent = path.parent().expect("absolute file path");
        if !directory(parent, false)? {
            return Ok(());
        }
        let dir = open_directory(parent)?;
        match fs::remove_file(path) {
            Ok(()) => dir.sync_all().map_err(|e| fs_error(parent, e)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(fs_error(path, error)),
        }
    }

    fn enablement(&self) -> Result<Enablement> {
        let path = Path::new(ENABLEMENT);
        if !directory(path.parent().expect("absolute enablement path"), false)? {
            return Ok(Enablement::Missing);
        }
        let Some(meta) = metadata(path)? else {
            return Ok(Enablement::Missing);
        };
        if !meta.is_symlink() || meta.uid() != 0 {
            return Ok(Enablement::Other);
        }
        let target = fs::read_link(path).map_err(|e| fs_error(path, e))?;
        if target != Path::new(UNIT) && target != Path::new("../").join(UNIT_NAME) {
            return Ok(Enablement::Other);
        }
        Ok(Enablement::Matching(LinkIdentity {
            dev: meta.dev(),
            ino: meta.ino(),
            ctime: meta.ctime(),
            ctime_nsec: meta.ctime_nsec(),
        }))
    }

    fn create_enablement(&self) -> Result<LinkIdentity> {
        let path = Path::new(ENABLEMENT);
        let parent = path.parent().expect("absolute enablement path");
        directory(parent, true)?;
        let parent_fd = open_directory(parent)?;
        symlink(UNIT, path).map_err(|e| fs_error(path, e))?;
        parent_fd.sync_all().map_err(|e| fs_error(parent, e))?;
        match self.enablement()? {
            Enablement::Matching(identity) => Ok(identity),
            _ => Err(unsafe_path(path)),
        }
    }

    fn fetch(&self, pins: &[Pin; 2]) -> Result<[Vec<u8>; 2]> {
        fetch(pins)
    }

    fn unit(&self, name: &str) -> Result<Unit> {
        let args = [
            "show",
            "--property=LoadState,ActiveState,FragmentPath,DropInPaths,MainPID",
            name,
        ];
        let output = systemctl(&args)?;
        let values =
            std::str::from_utf8(&output.stdout).map_err(|_| command_error(&args, &output))?;
        let values: std::collections::BTreeMap<_, _> = values
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();
        let field = |key| values.get(key).copied().unwrap_or_default();
        let load = field("LoadState");
        if (!output.status.success()
            && !(load == "not-found" && matches!(output.status.code(), Some(1 | 4))))
            || load.is_empty()
        {
            return Err(command_error(&args, &output));
        }
        let state = field("ActiveState");
        Ok(Unit {
            loaded: load != "not-found",
            fragment: field("FragmentPath").into(),
            drop_ins: !field("DropInPaths").is_empty(),
            active: state == "active",
            settled: matches!(state, "active" | "inactive" | "failed"),
            pid: field("MainPID").parse().unwrap_or_default(),
        })
    }

    fn systemctl(&self, args: &[&str]) -> Result<()> {
        let output = systemctl(args)?;
        if !output.status.success() {
            return Err(command_error(args, &output));
        }
        Ok(())
    }

    fn is_active(&self) -> Result<bool> {
        let args = ["is-active", UNIT_NAME];
        let output = systemctl(&args)?;
        let state = std::str::from_utf8(&output.stdout)
            .unwrap_or_default()
            .trim();
        match (output.status.code(), state) {
            (Some(0), "active") => Ok(true),
            (Some(3 | 4), "inactive" | "failed" | "unknown") => Ok(false),
            _ => Err(command_error(&args, &output)),
        }
    }

    fn owns_socket(&self, pid: u32, executable_path: &str) -> Result<bool> {
        let path = Path::new(SOCKET);
        if pid == 0
            || !metadata(path)?.is_some_and(|meta| {
                meta.file_type().is_socket() && meta.uid() == 0 && meta.gid() == 0
            })
        {
            return Ok(false);
        }
        let process_exe: PathBuf = format!("/proc/{pid}/exe").into();
        if fs::read_link(&process_exe).map_err(|e| fs_error(&process_exe, e))?
            != Path::new(executable_path)
        {
            return Ok(false);
        }
        let socket = UnixStream::connect(path).map_err(|e| fs_error(path, e))?;
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 1,
            gid: 1,
        };
        let mut len = size_of::<libc::ucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut len,
            )
        };
        if result != 0 {
            return Err(fs_error(path, io::Error::last_os_error()));
        }
        Ok(len as usize == size_of::<libc::ucred>()
            && credentials.pid as u32 == pid
            && credentials.uid == 0
            && credentials.gid == 0)
    }

    fn ctr(&self, executable_path: &str, args: &[&str]) -> Result<String> {
        let mut argv = vec![
            "--address",
            SOCKET,
            "--timeout",
            "10s",
            "--connect-timeout",
            "5s",
        ];
        argv.extend_from_slice(args);
        let output = program(Path::new(executable_path), &argv)?;
        if !output.status.success()
            || output.stdout.len() > 1024 * 1024
            || !output.stderr.is_empty()
        {
            return Err(command_error(&argv, &output));
        }
        String::from_utf8(output.stdout)
            .map_err(|_| Failure::new("command_failed", "ctr did not return UTF-8"))
    }

    fn verify_stopped_tasks(&self, shim: &str) -> Result<()> {
        // The unit may remove its runtime directory at stop. Inspect any
        // retained task bundles, then independently check surviving shims.
        let tasks = Path::new("/run/canaveral-containerd/io.containerd.runtime.v2.task");
        if directory(tasks, false)? {
            for entry in fs::read_dir(tasks).map_err(|e| fs_error(tasks, e))? {
                let namespace = entry.map_err(|e| fs_error(tasks, e))?.path();
                open_directory(&namespace)?;
                if let Some(entry) = fs::read_dir(&namespace)
                    .map_err(|e| fs_error(&namespace, e))?
                    .next()
                {
                    let task = entry.map_err(|e| fs_error(&namespace, e))?.path();
                    return Err(Failure::new(
                        "runtime_in_use",
                        format!("Containerd task state remains at {}", task.display()),
                    ));
                }
            }
        }
        let proc = Path::new("/proc");
        let deleted = format!("{shim} (deleted)");
        for entry in fs::read_dir(proc).map_err(|e| fs_error(proc, e))? {
            let entry = entry.map_err(|e| fs_error(proc, e))?;
            if !entry.file_name().to_str().is_some_and(|name| {
                !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit())
            }) {
                continue;
            }
            let exe = entry.path().join("exe");
            match fs::read_link(&exe) {
                Ok(target) if target == Path::new(shim) || target == Path::new(&deleted) => {
                    return Err(Failure::new(
                        "runtime_in_use",
                        format!("A managed containerd shim remains at {}", exe.display()),
                    ));
                }
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    return Err(fs_error(&exe, error));
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn now(&self) -> Result<u64> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .map_err(|error| Failure::new("clock_error", error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_independent_of_its_parent_and_excludes_other_installers() {
        let dir = tempfile::tempdir().unwrap();
        let parent = File::open(dir.path()).unwrap();
        assert_eq!(
            unsafe { libc::flock(parent.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let path = dir.path().join(".lock");
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let held = lock_file(&path, uid, gid).unwrap();
        assert!(format!("{:?}", lock_file(&path, uid, gid).unwrap_err()).contains("installer_busy"));
        drop(held);
        lock_file(&path, uid, gid).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(lock_file(&path, uid, gid).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link");
        fs::hard_link(&path, &link).unwrap();
        assert!(lock_file(&path, uid, gid).is_err());
        fs::remove_file(&link).unwrap();
        symlink(&path, &link).unwrap();
        assert!(lock_file(&link, uid, gid).is_err());
    }

    #[test]
    fn receipt_ancestor_mode_requires_world_traversal_and_trusted_writes() {
        assert!(directory_mode(0o755, true));
        assert!(directory_mode(0o711, true));
        assert!(directory_mode(0o700, false));
        for mode in [0o700, 0o750, 0o775, 0o757, 0o2755] {
            assert!(!directory_mode(mode, true), "{mode:o}");
        }
    }
}
