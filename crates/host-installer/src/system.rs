use crate::installer::{Failure, Host, Result, Unit, BINARIES, SOCKET, UNIT_NAME};
use crate::pins::Pin;
use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
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
    meta.uid() == 0 && meta.mode() & 0o7022 == 0
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
    let ancestors: Vec<_> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        match metadata(ancestor)? {
            Some(meta) if meta.is_dir() && trusted(&meta) => {}
            Some(_) => return Err(unsafe_path(ancestor)),
            None if !create => return Ok(false),
            None => {
                let parent = ancestor.parent().expect("system root exists");
                let parent_fd = open_directory(parent)?;
                DirBuilder::new()
                    .mode(0o700)
                    .create(ancestor)
                    .map_err(|e| fs_error(ancestor, e))?;
                let fd = open_directory(ancestor)?;
                fd.set_permissions(fs::Permissions::from_mode(0o755))
                    .and_then(|()| fd.sync_all())
                    .and_then(|()| parent_fd.sync_all())
                    .map_err(|e| fs_error(ancestor, e))?;
            }
        }
    }
    Ok(true)
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
        let path = Path::new("/var/lib");
        directory(path, false)?;
        let fd = open_directory(path)?;
        if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
            return Err(Failure::new(
                "installer_busy",
                format!("Could not lock /var/lib: {}", io::Error::last_os_error()),
            ));
        }
        Ok(fd)
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

    fn now(&self) -> Result<u64> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .map_err(|error| Failure::new("clock_error", error.to_string()))
    }
}
