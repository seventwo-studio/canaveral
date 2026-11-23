use super::*;
use flate2::{write::GzEncoder, Compression};
use std::cell::{Cell, RefCell};
use std::fs;
use std::path::PathBuf;

struct Fixture {
    root: tempfile::TempDir,
    assets: [Vec<u8>; 2],
    events: RefCell<Vec<String>>,
    active: Cell<bool>,
    root_user: Cell<bool>,
    foreign_socket: Cell<bool>,
    busy: Cell<bool>,
    stopped_tasks: Cell<bool>,
    unsafe_receipt_ancestor: Cell<bool>,
    foreign_unit: Cell<Option<&'static str>>,
    link: Cell<Option<LinkIdentity>>,
    link_serial: Cell<u64>,
    broken_ctr: Cell<bool>,
    fail_at: Cell<Option<&'static str>>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            assets: [archive(None), b"runc executable".to_vec()],
            events: RefCell::default(),
            active: Cell::default(),
            root_user: Cell::new(true),
            foreign_socket: Cell::default(),
            busy: Cell::default(),
            stopped_tasks: Cell::default(),
            unsafe_receipt_ancestor: Cell::default(),
            foreign_unit: Cell::default(),
            link: Cell::default(),
            link_serial: Cell::default(),
            broken_ctr: Cell::default(),
            fail_at: Cell::default(),
        }
    }

    fn path(&self, path: &str) -> PathBuf {
        self.root.path().join(path.strip_prefix('/').unwrap())
    }

    fn put(&self, path: &str, bytes: &[u8]) {
        let path = self.path(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn event(&self, event: &str) -> Result<()> {
        self.events.borrow_mut().push(event.into());
        if self.fail_at.get() == Some(event) {
            self.fail_at.set(None);
            return Err(Failure::new("interrupted", event));
        }
        Ok(())
    }

    fn pins(&self, version: &'static str) -> [Pin; 2] {
        let mut pins = pins::for_arch("aarch64").unwrap();
        pins[0].version = version;
        for (pin, bytes) in pins.iter_mut().zip(&self.assets) {
            pin.bytes = bytes.len();
            pin.sha256 = sha256(bytes).leak();
        }
        pins
    }

    fn link(&self) -> LinkIdentity {
        let ino = self.link_serial.get() + 1;
        self.link_serial.set(ino);
        let link = LinkIdentity {
            dev: 1,
            ino,
            ctime: 0,
            ctime_nsec: 0,
        };
        self.link.set(Some(link));
        link
    }
}

impl Host for Fixture {
    type Lock = ();

    fn authorize(&self) -> Result<()> {
        if self.root_user.get() {
            Ok(())
        } else {
            Err(Failure::new("root_required", "fixture"))
        }
    }

    fn lock(&self) -> Result<()> {
        Ok(())
    }

    fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.path(path).exists())
    }

    fn check_directory(&self, _: &str, _: bool) -> Result<()> {
        Ok(())
    }
    fn check_receipt_directory(&self, path: &str, _: bool) -> Result<()> {
        assert_eq!(path, RECEIPT);
        if self.unsafe_receipt_ancestor.get() {
            return Err(Failure::new("unsafe_path", "receipt ancestor lacks o+x"));
        }
        Ok(())
    }
    fn check_bin(&self, _: &str) -> Result<()> {
        Ok(())
    }

    fn read(&self, path: &str, _: u32, _: usize) -> Result<Option<Vec<u8>>> {
        Ok(fs::read(self.path(path)).ok())
    }

    fn write(&self, path: &str, _: u32, bytes: &[u8]) -> Result<()> {
        self.event(path)?;
        self.put(path, bytes);
        Ok(())
    }

    fn unlink(&self, path: &str) -> Result<()> {
        self.event(&format!("unlink {path}"))?;
        if path == ENABLEMENT {
            self.link.set(None);
        }
        if self.path(path).exists() {
            fs::remove_file(self.path(path)).unwrap();
        }
        Ok(())
    }

    fn enablement(&self) -> Result<Enablement> {
        if self.path(ENABLEMENT).exists() {
            Ok(Enablement::Other)
        } else {
            Ok(self
                .link
                .get()
                .map_or(Enablement::Missing, Enablement::Matching))
        }
    }

    fn create_enablement(&self) -> Result<LinkIdentity> {
        self.event("create enablement")?;
        assert!(self.link.get().is_none());
        Ok(self.link())
    }

    fn fetch(&self, _: &[Pin; 2]) -> Result<[Vec<u8>; 2]> {
        self.event("fetch")?;
        Ok(self.assets.clone())
    }

    fn unit(&self, name: &str) -> Result<Unit> {
        if self.foreign_unit.get() == Some(name) {
            return Ok(Unit {
                loaded: true,
                ..Unit::default()
            });
        }
        let loaded = name == UNIT_NAME && self.path(UNIT).exists();
        Ok(Unit {
            loaded,
            fragment: if loaded { UNIT.into() } else { String::new() },
            drop_ins: false,
            active: loaded && self.active.get(),
            settled: true,
            pid: if self.active.get() { 1 } else { 0 },
        })
    }

    fn systemctl(&self, args: &[&str]) -> Result<()> {
        self.event(args[0])?;
        match args {
            ["start", UNIT_NAME] => {
                self.active.set(true);
                self.put(SOCKET, b"socket");
            }
            ["stop", UNIT_NAME] => {
                self.active.set(false);
                if self.path(SOCKET).exists() {
                    fs::remove_file(self.path(SOCKET)).unwrap();
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn is_active(&self) -> Result<bool> {
        Ok(self.active.get())
    }

    fn owns_socket(&self, pid: u32, _: &str) -> Result<bool> {
        Ok(pid == 1 && self.active.get() && !self.foreign_socket.get())
    }

    fn ctr(&self, executable: &str, args: &[&str]) -> Result<String> {
        assert!(executable.ends_with("/bin/ctr"));
        if self.broken_ctr.get() {
            return Err(Failure::new("command_failed", "fixture"));
        }
        Ok(match args {
            ["namespaces", "list", "--quiet"] => "default\nother\n",
            ["--namespace", "other", "tasks", "list", "--quiet"] if self.busy.get() => "task123\n",
            _ => "",
        }
        .into())
    }

    fn now(&self) -> Result<u64> {
        Ok(1_790_000_000)
    }

    fn verify_stopped_tasks(&self, shim: &str) -> Result<()> {
        assert!(!self.active.get());
        assert!(!self.exists(SOCKET)?);
        assert!(shim.ends_with("/bin/containerd-shim-runc-v2"));
        self.event("verify stopped tasks")?;
        if self.stopped_tasks.get() {
            return Err(Failure::new("runtime_in_use", "fixture task survived stop"));
        }
        Ok(())
    }
}

fn archive(extra: Option<(&str, tar::EntryType, u32)>) -> Vec<u8> {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    let mut append = |path: &str, data: &[u8], kind, mode| {
        let mut header = tar::Header::new_ustar();
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        header.set_mode(mode);
        header.set_entry_type(kind);
        header.set_size(data.len() as u64);
        header.set_cksum();
        tar.append(&header, data).unwrap();
    };
    append("bin/", b"", tar::EntryType::Directory, 0o755);
    for name in [
        "containerd",
        "containerd-shim-runc-v2",
        "containerd-stress",
        "ctr",
    ] {
        append(
            &format!("bin/{name}"),
            name.as_bytes(),
            tar::EntryType::Regular,
            0o755,
        );
    }
    if let Some((path, kind, mode)) = extra {
        append(path, b"unsafe", kind, mode);
    }
    tar.into_inner().unwrap().finish().unwrap()
}

#[test]
fn plan_is_unprivileged_and_read_only() {
    let host = Fixture::new();
    host.root_user.set(false);
    let report = operation(&host, Operation::Plan, "aarch64").unwrap();
    assert_eq!(report["code"], "planned");
    assert_eq!(report["assets"][0]["version"], "2.4.2");
    assert_eq!(
        operation(&host, Operation::Plan, "riscv64")
            .unwrap_err()
            .code,
        "unsupported_arch"
    );
    assert_eq!(Operation::Plan.name(), "plan");
    assert!(host.events.borrow().is_empty());
}

#[test]
fn refuses_root_foreign_files_and_unowned_socket_before_writes() {
    let host = Fixture::new();
    host.root_user.set(false);
    assert_eq!(
        operation(&host, Operation::Install, "aarch64")
            .unwrap_err()
            .code,
        "root_required"
    );
    host.root_user.set(true);
    host.put("/run/k3s/running", b"");
    assert_eq!(
        operation(&host, Operation::Install, "aarch64")
            .unwrap_err()
            .code,
        "foreign_install"
    );
    fs::remove_dir_all(host.path("/run/k3s")).unwrap();
    host.put(SOCKET, b"foreign");
    assert_eq!(
        operation(&host, Operation::Install, "aarch64")
            .unwrap_err()
            .code,
        "unowned_socket"
    );
    assert!(host.events.borrow().is_empty());
}

#[test]
fn validates_archive_entries_and_both_pins() {
    for entry in [
        ("bin/ctr", tar::EntryType::Regular, 0o755),
        ("/bin/sh", tar::EntryType::Regular, 0o755),
        ("bin/../ctr", tar::EntryType::Regular, 0o755),
        ("bin/containerd", tar::EntryType::Symlink, 0o755),
        ("bin/ctr", tar::EntryType::Link, 0o755),
        ("bin/ctr", tar::EntryType::Char, 0o755),
        ("bin/ctr", tar::EntryType::Regular, 0o4755),
        ("bin/unexpected", tar::EntryType::Regular, 0o755),
    ] {
        assert_eq!(
            extract(&archive(Some(entry))).unwrap_err().code,
            "invalid_archive"
        );
    }
    let host = Fixture::new();
    let mut pins = host.pins("2.4.2");
    pins[1].sha256 = pins[0].sha256;
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "asset_digest_mismatch"
    );
    assert_eq!(&*host.events.borrow(), &["fetch"]);
}

#[test]
fn publishes_contract_receipt_after_start_and_repeats_without_writing() {
    let host = Fixture::new();
    let pins = host.pins("2.4.2");
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap(),
        "installed"
    );
    let events = host.events.take();
    assert_eq!(
        &events[events.len() - 3..],
        ["start", RECEIPT, &format!("unlink {PENDING}")]
    );
    let report = operation(&host, Operation::Status, "aarch64").unwrap();
    assert_eq!(report["code"], "installed");
    assert_eq!(report["receipt"]["type"], KIND);
    assert_eq!(report["receipt"]["version"], 1);
    assert_eq!(report["receipt"]["component"], "containerd");
    assert_eq!(report["receipt"]["installedAt"], 1_790_000_000);
    assert_eq!(report["receipt"]["unit"], UNIT);
    assert_eq!(report["receipt"]["socket"], SOCKET);
    assert_eq!(report["receipt"]["assets"][1]["name"], "runc");
    assert_eq!(report["receipt"]["files"].as_array().unwrap().len(), 6);
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap(),
        "installed"
    );
    assert!(host.events.borrow().is_empty());
}

#[test]
fn interrupted_install_requires_matching_files_and_resumes() {
    let host = Fixture::new();
    let pins = host.pins("2.4.2");
    host.fail_at.set(Some("start"));
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "interrupted"
    );
    assert!(!host.exists(RECEIPT).unwrap());
    assert!(host.exists(PENDING).unwrap());
    assert_eq!(
        mutate(&host, &pins, Operation::Remove).unwrap_err().code,
        "recovery_required"
    );
    host.put(CONFIG, b"foreign config");
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "ownership_mismatch"
    );
    host.put(CONFIG, config("2.4.2").as_bytes());
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap(),
        "installed"
    );
}

#[test]
fn retries_after_start_or_partial_removal() {
    let host = Fixture::new();
    let pins = host.pins("2.4.2");
    host.fail_at.set(Some(RECEIPT));
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "interrupted"
    );
    assert!(host.active.get());
    host.foreign_socket.set(true);
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "unowned_socket"
    );
    host.foreign_socket.set(false);
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap(),
        "installed"
    );
    host.fail_at.set(Some(
        "unlink /etc/systemd/system/canaveral-containerd.service",
    ));
    assert_eq!(
        mutate(&host, &pins, Operation::Remove).unwrap_err().code,
        "interrupted"
    );
    assert!(!host.active.get());
    assert!(host.path(RECEIPT).exists());
    assert_eq!(mutate(&host, &pins, Operation::Remove).unwrap(), "removed");
    assert!(!host.path(PENDING).exists());
    assert!(!host.path(RECEIPT).exists());
    assert!(!host.path(UNIT).exists());
    assert!(!host.path(CONFIG).exists());
}

#[test]
fn ownership_and_idle_checks_guard_mutations_and_upgrade_removes_old_binaries() {
    let host = Fixture::new();
    let old = host.pins("2.4.1");
    let new = host.pins("2.4.2");
    mutate(&host, &old, Operation::Install).unwrap();
    host.events.take();
    host.busy.set(true);
    assert_eq!(
        mutate(&host, &new, Operation::Install).unwrap_err().code,
        "runtime_in_use"
    );
    assert_eq!(
        mutate(&host, &old, Operation::Remove).unwrap_err().code,
        "runtime_in_use"
    );
    host.busy.set(false);
    host.broken_ctr.set(true);
    assert_eq!(
        mutate(&host, &old, Operation::Remove).unwrap_err().code,
        "idle_unproven"
    );
    host.broken_ctr.set(false);
    host.put(CONFIG, b"changed");
    assert_eq!(status(&host).unwrap()["code"], "ownership_mismatch");
    assert_eq!(
        mutate(&host, &old, Operation::Remove).unwrap_err().code,
        "ownership_mismatch"
    );
    assert!(host.events.borrow().is_empty());
    host.put(CONFIG, config("2.4.1").as_bytes());
    assert_eq!(
        mutate(&host, &new, Operation::Install).unwrap(),
        "installed"
    );
    assert!(!host.path(&bin("2.4.1", "ctr")).exists());
    assert!(host.path(&bin("2.4.2", "ctr")).exists());
    assert_eq!(mutate(&host, &new, Operation::Remove).unwrap(), "removed");
}

#[test]
fn detects_rootful_podman_and_stopped_rke2() {
    for path in [
        "/run/podman/podman.sock",
        "/usr/local/bin/rke2",
        "/usr/bin/rke2",
        "/var/lib/rancher/rke2",
        "/etc/rancher/rke2",
        "/etc/systemd/system/rke2-agent.service",
    ] {
        let host = Fixture::new();
        host.put(path, b"");
        assert_eq!(
            foreign(&host).unwrap_err().code,
            "foreign_install",
            "{path}"
        );
    }
    for name in [
        "podman.service",
        "podman.socket",
        "rke2-server.service",
        "rke2-agent.service",
    ] {
        let host = Fixture::new();
        host.foreign_unit.set(Some(name));
        assert_eq!(
            foreign(&host).unwrap_err().code,
            "foreign_install",
            "{name}"
        );
    }
}

#[test]
fn refuses_inaccessible_receipt_ancestry_before_installing() {
    let host = Fixture::new();
    host.unsafe_receipt_ancestor.set(true);
    let pins = host.pins("2.4.2");
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "unsafe_path"
    );
    assert!(host.events.borrow().is_empty());
    assert!(!host.exists(RECEIPT).unwrap());
}

#[test]
fn removes_only_the_recorded_enablement_link() {
    for replace in [false, true] {
        let host = Fixture::new();
        let pins = host.pins("2.4.2");
        let operator_link =
            "/etc/systemd/system/operator.target.wants/canaveral-containerd.service";
        host.put(operator_link, UNIT.as_bytes());
        mutate(&host, &pins, Operation::Install).unwrap();
        let link = if replace {
            host.link()
        } else {
            host.link.get().unwrap()
        };
        assert_eq!(mutate(&host, &pins, Operation::Remove).unwrap(), "removed");
        assert_eq!(host.link.get(), replace.then_some(link));
        assert!(host.exists(operator_link).unwrap());
    }
}

#[test]
fn preserves_enablement_when_ownership_was_never_recorded() {
    let host = Fixture::new();
    let pins = host.pins("2.4.2");
    host.fail_at.set(Some(INSTALLER_STATE));
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "interrupted"
    );
    let link = host.link.get().unwrap();
    mutate(&host, &pins, Operation::Install).unwrap();
    assert_eq!(
        document::<InstallerState>(&host, INSTALLER_STATE, 0o600)
            .unwrap()
            .unwrap()
            .enablement,
        None
    );
    mutate(&host, &pins, Operation::Remove).unwrap();
    assert_eq!(host.link.get(), Some(link));
}

#[test]
fn pending_stop_does_not_authorize_upgrade_or_removal() {
    for op in [Operation::Install, Operation::Remove] {
        let host = Fixture::new();
        let old = host.pins("2.4.1");
        let new = host.pins("2.4.2");
        mutate(&host, &old, Operation::Install).unwrap();
        let owned_link = host.link.get();
        host.stopped_tasks.set(true);
        assert_eq!(mutate(&host, &new, op).unwrap_err().code, "runtime_in_use");
        assert!(!host.active.get());
        assert!(
            !document::<Pending>(&host, PENDING, 0o644)
                .unwrap()
                .unwrap()
                .stop_verified
        );
        assert_eq!(receipt(&host).unwrap().unwrap().version(), "2.4.1");
        assert!(host.exists(&bin("2.4.1", "ctr")).unwrap());
        assert_eq!(host.link.get(), owned_link);
        host.stopped_tasks.set(false);
        assert_eq!(mutate(&host, &new, op).unwrap_err().code, "idle_unproven");
        host.systemctl(&["start", UNIT_NAME]).unwrap();
        mutate(&host, &new, op).unwrap();
    }
}

#[test]
fn matching_pins_refresh_generated_files_and_missing_installer_state() {
    let host = Fixture::new();
    let pins = host.pins("2.4.2");
    mutate(&host, &pins, Operation::Install).unwrap();
    host.unlink(INSTALLER_STATE).unwrap();
    let original_link = host.link.get();
    host.events.take();
    mutate(&host, &pins, Operation::Install).unwrap();
    assert_eq!(&*host.events.borrow(), &[INSTALLER_STATE]);
    assert_eq!(host.link.get(), original_link);

    let mut installed = receipt(&host).unwrap().unwrap();
    for record in &mut installed.files {
        if [CONFIG, UNIT].contains(&record.path.as_str()) {
            host.put(&record.path, b"old generated content");
            record.sha256 = sha256(b"old generated content");
        }
    }
    publish(&host, RECEIPT, &installed).unwrap();
    host.events.take();
    host.busy.set(true);
    assert_eq!(
        mutate(&host, &pins, Operation::Install).unwrap_err().code,
        "runtime_in_use"
    );
    assert!(host.events.borrow().is_empty());
    host.busy.set(false);
    mutate(&host, &pins, Operation::Install).unwrap();
    assert!(receipt(&host)
        .unwrap()
        .unwrap()
        .matches_generated(&generated_files("2.4.2")));
    let events = host.events.take();
    assert!(!events.iter().any(|event| event == "fetch"));
    assert!(
        events.iter().position(|e| e == "stop").unwrap()
            < events.iter().position(|e| e == CONFIG).unwrap()
    );
    assert!(
        events.iter().position(|e| e == UNIT).unwrap()
            < events.iter().position(|e| e == "start").unwrap()
    );
    assert_eq!(host.link.get(), original_link);
    mutate(&host, &pins, Operation::Install).unwrap();
    assert!(host.events.borrow().is_empty());
}
