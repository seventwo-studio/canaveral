//! Explicit recovery, with no claim or launch lane. Tombstones live outside state.json.
use super::*;
use std::os::{
    fd::AsRawFd,
    unix::fs::{MetadataExt, OpenOptionsExt},
};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    version: u32,
    #[serde(rename = "mutationUUID")]
    mutation_uuid: uuid::Uuid,
    binding: Value,
    claim_id: uuid::Uuid,
    assignment_id: uuid::Uuid,
    lease_id: uuid::Uuid,
    member_id: uuid::Uuid,
    domain_id: uuid::Uuid,
    image_digest: String,
    boot_attempt: Option<uuid::Uuid>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    request: Request,
    outcome: Option<Value>,
}

/// Authentication precedes mutation replay as well as a new recovery attempt.
pub fn reconcile(config: Config, request_path: &Path) -> Result<Value> {
    let request: Request = decode(&private::trust_file(request_path, true)?)?;
    let mut satellite = Satellite::open(config.clone())?;
    let ca = config.ca.as_ref().map(|p| read_ca(p)).transpose()?;
    let transport =
        Transport::new(&config.origin, ca.as_deref()).map_err(|_| "invalid HTTPS transport")?;
    let mut identity = Identity::open(&config.identity, &config.origin, &config.binding)
        .map_err(|_| "identity binding rejected")?;
    identity
        .authenticate(&transport)
        .map_err(|_| "current identity authentication failed")?;
    satellite.reconcile(
        &mut Authenticated {
            identity: &identity,
            transport: &transport,
        },
        request,
    )
}
impl Satellite {
    pub(crate) fn reconcile(
        &mut self,
        controller: &mut impl Controller,
        request: Request,
    ) -> Result<Value> {
        if request.version != 1
            || request.mutation_uuid.is_nil()
            || request.binding
                != serde_json::to_value(&self.config.binding).map_err(|_| "invalid binding")?
        {
            return Err("invalid reconciliation version or binding");
        }
        let target = format!("reconciliation-{}.json", request.mutation_uuid);
        let pending = "state.next";
        if let Some(bytes) = self.dir.read_optional(&target)? {
            let record: Record = decode(&bytes)?;
            if record.request != request {
                return Err("reconciliation mutation conflicts");
            }
            if let Some(outcome) = record.outcome {
                return Ok(outcome);
            }
        }
        let a = self.assignment()?;
        self.check_identity(a)?;
        if request.claim_id != self.state.claim_id
            || request.assignment_id != a.id
            || request.lease_id != a.lease_id
            || request.member_id != a.member_id
            || request.domain_id != a.domain_id
            || request.image_digest != a.image.digest
            || request.boot_attempt != self.state.direct.as_ref().map(|d| d.boot_attempt)
        {
            return Err("reconciliation assignment identity mismatch");
        }
        if !self.state.launch_intent || self.state.worker_ownership_protocol != Some(1) {
            return Err("legacy or missing worker/helper ownership proof; reservation held");
        }
        if self
            .state
            .reconciliation
            .as_ref()
            .is_some_and(|old| old != &request)
        {
            return Err("another reconciliation mutation owns this claim");
        }
        // Publication precedes fencing, controller calls and deletion. No journal
        // reset can discard this identity, including a lost final publication.
        self.dir.write(
            &target,
            pending,
            &serde_json::to_vec(&Record {
                request: request.clone(),
                outcome: None,
            })
            .map_err(|_| "reconciliation encode failed")?,
        )?;
        self.state.reconciliation = Some(request.clone());
        self.save()?;
        if self.state.released {
            return self
                .seal_reconciliation()?
                .ok_or("missing reconciliation outcome");
        }
        self.state.transfers.recover();
        if let Some(op) = self.state.operations.current.as_mut() {
            op.unknown();
        }
        self.fence_for(StopCause::Reconciliation)?;
        // Preserve and replay exact pending receipts before obtaining a fresh
        // sequenced report. Local expiry alone never authorizes deletion.
        self.sync(controller)?;
        if !self.state.terminal {
            return Err("reconciliation requires terminal controller intent");
        }
        if !self.state.cleaned {
            let absent = self.dir.absent("workspace")?;
            if absent && !self.state.cleaning {
                return Err("workspace missing before deletion intent");
            }
            let guard = if absent {
                None
            } else {
                Some(RuntimeGuard::acquire(&self.machine()?)?)
            };
            if let Some(guard) = &guard {
                guard.check()?;
                let output = scan_handles(&self.workspace())?;
                if !handles_closed(&output, guard)? {
                    return Err("workspace handles unproven; reservation held");
                }
                guard.check()?;
            }
            self.state.stopped = true;
            if let Some(d) = self.state.direct.as_mut() {
                d.data_closed = Some(true);
            }
            self.save()?;
            // Keep runtime.lock open and flocked through relay/disk/workspace
            // removal and ordinary cleanup report. Never call helper inspect.
            self.finish(controller)?;
            drop(guard);
        } else {
            self.finish(controller)?;
        }
        self.seal_reconciliation()?
            .ok_or("missing reconciliation outcome")
    }
    pub(super) fn seal_reconciliation(&self) -> Result<Option<Value>> {
        let Some(request) = self.state.reconciliation.clone() else {
            return Ok(None);
        };
        if !self.state.released {
            return Err("reconciliation release unproven");
        }
        let outcome = json!({"version":1,"mutationUUID":request.mutation_uuid,"assignmentId":request.assignment_id,"released":true});
        let target = format!("reconciliation-{}.json", request.mutation_uuid);
        self.dir.write(
            &target,
            "state.next",
            &serde_json::to_vec(&Record {
                request,
                outcome: Some(outcome.clone()),
            })
            .map_err(|_| "reconciliation encode failed")?,
        )?;
        Ok(Some(outcome))
    }
}
struct RuntimeGuard {
    file: File,
    path: PathBuf,
    dev: u64,
    ino: u64,
    directory_identity: (u64, u64),
}
impl RuntimeGuard {
    fn acquire(machine: &Path) -> Result<Self> {
        let directory = private::walk(machine)?;
        let dm = io(directory.metadata())?;
        if dm.uid() != unsafe { libc::geteuid() } || dm.mode() & 0o022 != 0 {
            return Err("unsafe machine directory");
        }
        let path = machine.join("runtime.lock");
        let open = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&path)
        };
        let file = match open() {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let file = io(std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
                    .open(&path))?;
                io(file.sync_all())?;
                io(directory.sync_all())?;
                file
            }
            Err(_) => return Err("runtime lock unavailable"),
        };
        let m = io(file.metadata())?;
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o7777 != 0o600
        {
            return Err("unsafe runtime lock");
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("native runtime still owns workspace");
        }
        let result = Self {
            file,
            path,
            dev: m.dev(),
            ino: m.ino(),
            directory_identity: (dm.dev(), dm.ino()),
        };
        result.check()?;
        Ok(result)
    }
    fn check(&self) -> Result<()> {
        let parent = private::walk(self.path.parent().ok_or("invalid runtime path")?)?;
        let dm = io(parent.metadata())?;
        if (dm.dev(), dm.ino()) != self.directory_identity {
            return Err("machine directory replaced");
        }
        let m = io(std::fs::symlink_metadata(&self.path))?;
        if !m.is_file() || m.nlink() != 1 || (m.dev(), m.ino()) != (self.dev, self.ino) {
            return Err("runtime lock replaced");
        }
        Ok(())
    }
}
fn handles_closed(output: &std::process::Output, guard: &RuntimeGuard) -> Result<bool> {
    if !output.stderr.is_empty() {
        return Ok(false);
    }
    if output.stdout.is_empty() {
        return Ok(false);
    }
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Ok(false);
    }
    let mut pid = None;
    let mut fd = None;
    let mut dev = None;
    let mut ino = None;
    let mut files = 0;
    let valid = |pid, fd, dev, ino| {
        pid == Some(std::process::id() as u64)
            && fd == Some(guard.file.as_raw_fd() as u64)
            && dev == Some(guard.dev)
            && ino == Some(guard.ino)
    };
    for field in output.stdout.split(|b| *b == 0) {
        let field = field.strip_prefix(b"\n").unwrap_or(field);
        if field.is_empty() {
            continue;
        }
        let value = std::str::from_utf8(&field[1..]).map_err(|_| "invalid lsof evidence")?;
        match field[0] {
            b'p' => {
                if fd.is_some() && !valid(pid, fd, dev, ino) {
                    return Ok(false);
                }
                fd = None;
                dev = None;
                ino = None;
                pid = value.parse().ok();
            }
            b'f' => {
                if fd.is_some() && !valid(pid, fd, dev, ino) {
                    return Ok(false);
                }
                files += 1;
                fd = value.parse().ok();
                dev = None;
                ino = None;
                if fd.is_none() {
                    return Ok(false);
                }
            }
            b'D' => dev = u64::from_str_radix(value.strip_prefix("0x").unwrap_or(value), 16).ok(),
            b'i' => ino = value.parse().ok(),
            _ => return Ok(false),
        }
    }
    Ok(files == 1 && valid(pid, fd, dev, ino))
}

/// No unbounded output buffer or blocked pipe can extend a recovery attempt.
fn scan_handles(workspace: &Path) -> Result<std::process::Output> {
    let mut child = io(Command::new(LSOF)
        .args(["-nP", "-F0pfDi", "+D"])
        .arg(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn())?;
    let result = (|| {
        let mut stdout = child.stdout.take().ok_or("missing lsof output")?;
        let mut stderr = child.stderr.take().ok_or("missing lsof diagnostics")?;
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
                return Err("lsof pipe unavailable");
            }
        }
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let start = std::time::Instant::now();
        loop {
            let status = io(child.try_wait())?;
            let drain = |reader: &mut dyn Read, bytes: &mut Vec<u8>| -> Result<bool> {
                let mut buf = [0; 4096];
                for _ in 0..16 {
                    match reader.read(&mut buf) {
                        Ok(0) => return Ok(true),
                        Ok(n) => {
                            bytes.extend_from_slice(&buf[..n]);
                            if bytes.len() > 65536 {
                                return Err("lsof evidence exceeds bound");
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
                        Err(_) => return Err("lsof evidence unavailable"),
                    }
                }
                Ok(false)
            };
            let out_done = drain(&mut stdout, &mut out)?;
            let err_done = drain(&mut stderr, &mut err)?;
            if let Some(status) = status {
                if out_done && err_done {
                    return Ok(std::process::Output {
                        status,
                        stdout: out,
                        stderr: err,
                    });
                }
            }
            if start.elapsed() >= QUICK {
                return Err("lsof evidence timeout");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::{
        fd::AsRawFd,
        unix::{fs::PermissionsExt, process::ExitStatusExt},
    };
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let machine = temp.path().join("machine");
        std::fs::create_dir(&machine).unwrap();
        std::fs::set_permissions(&machine, std::fs::Permissions::from_mode(0o700)).unwrap();
        (temp, machine)
    }
    #[test]
    fn missing_contested_replaced_and_linked_runtime_locks() {
        let (_temp, machine) = fixture();
        let guard = RuntimeGuard::acquire(&machine).unwrap();
        assert!(RuntimeGuard::acquire(&machine).is_err());
        let path = machine.join("runtime.lock");
        std::fs::rename(&path, machine.join("original")).unwrap();
        let replacement = RuntimeGuard::acquire(&machine).unwrap();
        assert!(guard.check().is_err());
        drop(replacement);
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(machine.join("original"), &path).unwrap();
        assert!(RuntimeGuard::acquire(&machine).is_err());
    }
    #[test]
    fn only_exact_guard_descriptor_is_excluded_never_all_same_pid_handles() {
        let (_temp, machine) = fixture();
        let guard = RuntimeGuard::acquire(&machine).unwrap();
        let record = |fd, ino| {
            format!(
                "p{}\0\nf{fd}\0D0x{:x}\0i{ino}\0\n",
                std::process::id(),
                guard.dev
            )
            .into_bytes()
        };
        let mut output = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: record(guard.file.as_raw_fd(), guard.ino),
            stderr: Vec::new(),
        };
        assert!(handles_closed(&output, &guard).unwrap());
        output
            .stdout
            .extend(record(guard.file.as_raw_fd() + 1, guard.ino));
        assert!(!handles_closed(&output, &guard).unwrap());
        output.stdout = record(guard.file.as_raw_fd(), guard.ino + 1);
        assert!(!handles_closed(&output, &guard).unwrap());
        output.stdout.clear();
        output.status = std::process::ExitStatus::from_raw(256);
        assert!(!handles_closed(&output, &guard).unwrap());
        output.stderr = b"permission denied".to_vec();
        assert!(!handles_closed(&output, &guard).unwrap());
    }
}
