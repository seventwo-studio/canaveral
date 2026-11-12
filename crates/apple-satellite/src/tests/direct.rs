//! Direct-boot satellite tests: fake helper and builder subprocesses, and a protocol-faithful
//! fake guest on the published relay socket. The builder writes a SIMULATED EROFS image that
//! only carries the header magic and launch.json; it is not mountable. No VM is started.
use super::*;
use canaveral_guest_protocol::{
    bundle::{Artifact, Launch, Manifest},
    encode, Decoder, Guest, Host,
};
use std::{
    ffi::CString,
    os::unix::{ffi::OsStrExt, net::UnixListener},
    sync::{Arc, Mutex},
};
const LABEL: &[u8] = b"CANAVERAL-SIMULATED-EROFS-NOT-MOUNTABLE\n";
/// Clears immutable flags so the disposable directory can be removed.
struct Unlock(Vec<PathBuf>);
impl Drop for Unlock {
    fn drop(&mut self) {
        for p in &self.0 {
            let c = CString::new(p.as_os_str().as_bytes()).unwrap();
            unsafe { libc::chflags(c.as_ptr(), 0) };
        }
    }
}
fn immutable(path: &Path) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o400)).unwrap();
    let c = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::chflags(c.as_ptr(), libc::UF_IMMUTABLE) }, 0);
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
struct Direct {
    _tmp: tempfile::TempDir,
    _unlock: Unlock,
    c: Config,
    root: PathBuf,
    artifacts: Vec<PathBuf>,
}
fn direct_fixture(manifest_edit: impl Fn(&mut Manifest)) -> Direct {
    let (tmp, mut c) = fixture_with(|m| {
        let root = m.ancestors().nth(3).unwrap().display().to_string();
        let m = m.display();
        format!("#!/bin/sh\necho \"$1\" >> '{root}/calls'\ncase \"$1\" in\nlease-clock) printf '%s' '{}' ;;\nprepare) cat > '{root}/prepare.json'; mkdir -m 700 '{m}' ;;\nrun) while [ ! -f '{m}/power-off.request' ]; do sleep 0.01; done ;;\ninspect) printf '%s' '{{\"locked\":false}}' ;;\nesac\n",
            clock_json())
    });
    let root = tmp.path().to_owned();
    let bundle = root.join("bundle");
    std::fs::create_dir(&bundle).unwrap();
    let mut kernel = vec![0u8; 64];
    kernel[56..60].copy_from_slice(b"ARMd");
    let mut rootfs = vec![0u8; 2048];
    rootfs[1024..1028].copy_from_slice(&bundle::EROFS_MAGIC);
    let files = [
        ("Image", kernel),
        ("initrd.img", b"fixture audited initrd".to_vec()),
        ("root.erofs", rootfs),
    ];
    let mut artifacts = vec![];
    let mut pins = vec![];
    for (name, bytes) in &files {
        let path = bundle.join(name);
        std::fs::write(&path, bytes).unwrap();
        immutable(&path);
        artifacts.push(path);
        pins.push(Artifact {
            path: (*name).into(),
            sha256: sha(bytes),
            size: bytes.len() as u64,
        });
    }
    let mut manifest = Manifest {
        version: 1,
        id: "fixture-coding".into(),
        revision: 1,
        arch: "arm64".into(),
        kernel: pins[0].clone(),
        initrd: Some(pins[1].clone()),
        rootfs: pins[2].clone(),
        command_line: "console=hvc0 root=/dev/vda rootfstype=erofs ro".into(),
        agent_vsock_port: 1024,
        protocol: 1,
        tool_versions: [
            ("shell", "canaveral-shell-v1"),
            ("git", "git version 2.47"),
            ("node", "v24.11.0"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect(),
    };
    manifest_edit(&mut manifest);
    let path = bundle.join("manifest.json");
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
    let digest = manifest
        .digest()
        .map_or("sha256:invalid".into(), |d| format!("sha256:{d}"));
    c.inventory = vec![Installed {
        credential_free: true,
        format: bundle::Format::BootBundle,
        image: Image {
            id: "coding".into(),
            revision: "1".into(),
            arch: "arm64".into(),
            backend: "appleVirtualization".into(),
            digest,
        },
        path,
    }];
    // SIMULATED EROFS builder: checks the fixed argv, writes magic, a label and launch.json.
    let builder = root.join("mkfs.erofs");
    std::fs::write(&builder, format!("#!/bin/sh\n[ $# = 9 ] && [ \"$1\" = --quiet ] && [ \"$2\" = --all-root ] && [ \"$3\" = -b4096 ] && [ \"$4\" = -T ] && [ \"$5\" = 0 ] && [ \"$6\" = -U ] || exit 2\n[ -f \"$9/launch.json\" ] || exit 3\nIFS= read -r line < \"$9/launch.json\"\n{{ printf '%1024s' ''; printf '\\342\\341\\365\\340'; printf '{}'; printf '%s' \"$line\"; }} > \"$8\"\n", String::from_utf8_lossy(LABEL).replace('\n', "\\n"))).unwrap();
    std::fs::set_permissions(&builder, std::fs::Permissions::from_mode(0o500)).unwrap();
    c.bootstrap_builder = Some(bundle::Builder {
        sha256: hash_file(&builder).unwrap(),
        path: builder,
    });
    let unlock = Unlock(artifacts.clone());
    Direct {
        _tmp: tmp,
        _unlock: unlock,
        c,
        root,
        artifacts,
    }
}
fn medium_launch(path: &Path) -> Launch {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(bytes[1024..1028], bundle::EROFS_MAGIC);
    let at = bytes.windows(LABEL.len()).position(|w| w == LABEL).unwrap();
    serde_json::from_slice(&bytes[at + LABEL.len()..]).unwrap()
}
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Ready,
    Command,
    WrongIdentity,
    WrongVersion,
    Stall,
}
/// Stands in for the helper relay and guest PID1: publishes the start record and socket,
/// validates hello against the medium's launch.json, then answers per `mode`.
fn fake_guest(d: &Direct, mode: Mode) -> Arc<Mutex<Vec<Host>>> {
    let frames = Arc::new(Mutex::new(vec![]));
    let seen = frames.clone();
    let machine = machine_of(&d.c);
    let medium = d.c.state.join("workspace/bootstrap/launch.erofs");
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while !machine.join("runner-launch.json").exists() {
            if start.elapsed() > Duration::from_secs(20) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let launch = medium_launch(&medium);
        launch.validate().unwrap();
        let dir = PathBuf::from(format!(
            "{}/canaveral-{}",
            guest::SOCKET_ROOT,
            random_uuid().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sock = dir.join("agent.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600)).unwrap();
        let b = &launch.binding;
        // Swift's uuidString spelling is uppercase.
        let started = json!({"event":"started","version":1,"continuous":clock::now().as_secs_f64(),
            "memberID":b.member_id.to_string().to_uppercase(),"leaseID":b.lease_id.to_string().to_uppercase(),
            "bootSessionID":boot_id().to_string().to_uppercase(),"bootAttempt":b.boot_attempt.to_string().to_uppercase(),
            "agentSocket":sock});
        std::fs::write(machine.join("direct-started.json"), started.to_string()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        let mut decoder = Decoder::default();
        let mut buf = [0u8; 4096];
        let mut command_id = None;
        loop {
            let want = decoder.needed().min(buf.len());
            let n = match stream.read(&mut buf[..want]) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let Ok(Some(frame)) = decoder.feed(&buf[..n]) else {
                continue;
            };
            let reply = match (&frame, mode) {
                (Host::Hello { binding, .. }, _) => {
                    assert_eq!(*binding, launch.binding, "hello must match launch.json");
                    let mut echo = binding.clone();
                    match mode {
                        Mode::Stall => None,
                        Mode::WrongIdentity => {
                            echo.member_id = uuid::Uuid::from_u128(999);
                            Some(encode(&Guest::Ready {
                                version: 1,
                                binding: echo,
                            }))
                        }
                        Mode::WrongVersion => Some(encode(&Guest::Ready {
                            version: 2,
                            binding: echo,
                        })),
                        Mode::Ready | Mode::Command => Some(encode(&Guest::Ready {
                            version: 1,
                            binding: echo,
                        })),
                    }
                }
                (Host::Renew { binding, .. }, _) => {
                    assert!(binding.same_launch(&launch.binding));
                    None
                }
                (
                    Host::Exec {
                        id,
                        argv,
                        cwd,
                        env,
                        timeout_ms,
                        ..
                    },
                    Mode::Command,
                ) => {
                    assert_eq!(argv, &["echo", "fixture"]);
                    assert_eq!(cwd, "/workspace");
                    assert!(env.is_empty());
                    assert!(*timeout_ms <= 30000);
                    assert_ne!(*id, uuid::Uuid::from_u128(42));
                    assert!(command_id.replace(*id).is_none(), "duplicate exec");
                    None
                }
                (Host::Credit { .. }, Mode::Command) if command_id.is_some() => {
                    let id = command_id.take().unwrap();
                    let mut bytes = encode(&Guest::Output {
                        version: 1,
                        id,
                        stream: "stdout".into(),
                        seq: 0,
                        data: "Zml4dHVyZQo=".into(),
                    })
                    .unwrap();
                    bytes.extend(
                        encode(&Guest::Exit {
                            version: 1,
                            id,
                            status: Some(0),
                            signal: None,
                            timed_out: false,
                            duration_ms: 1,
                            stdout_bytes: 8,
                            stderr_bytes: 0,
                            termination_confirmed: true,
                        })
                        .unwrap(),
                    );
                    Some(Ok(bytes))
                }
                _ => None,
            };
            seen.lock().unwrap().push(frame);
            if let Some(bytes) = reply {
                stream.write_all(&bytes.unwrap()).unwrap();
            }
        }
    });
    frames
}
fn calls(d: &Direct) -> String {
    std::fs::read_to_string(d.root.join("calls")).unwrap_or_default()
}
fn launch_direct(d: &Direct, mode: Mode, life: f64) -> (Result<()>, Wire, Arc<Mutex<Vec<Host>>>) {
    let mut s = seeded(&d.c);
    s.state.deadline = clock::now().as_secs_f64() + life;
    s.save().unwrap();
    let mut w = wire(s.assignment().unwrap().clone());
    w.stop_on_ready = true;
    let frames = fake_guest(d, mode);
    let result = s.run_once(&mut w);
    (result, w, frames)
}
fn assert_cleaned(d: &Direct, w: &Wire) {
    assert!(
        !d.c.state.join("workspace").exists(),
        "owned medium and workspace removed"
    );
    for path in &d.artifacts {
        assert!(path.exists(), "operator artifact deleted");
    }
    let journal: Value =
        serde_json::from_slice(&std::fs::read(d.c.state.join("state.json")).unwrap()).unwrap();
    let relay = PathBuf::from(journal["direct"]["agentSocket"].as_str().unwrap());
    assert!(
        !relay.parent().unwrap().exists(),
        "published relay removed after stop"
    );
    let (_, last) = w.requests.last().unwrap();
    assert_eq!(last["receipt"]["cleanup"], "complete");
}
#[test]
fn ready_only_after_bound_guest_ready_then_release_cleans_owned_state() {
    let d = direct_fixture(|_| {});
    validate_local(&d.c).unwrap();
    let (result, w, frames) = launch_direct(&d, Mode::Ready, 100.0);
    result.unwrap();
    let reports: Vec<_> = w.requests.iter().filter(|(n, _)| *n == "report").collect();
    let first_ready = reports
        .iter()
        .position(|(_, r)| r["receipt"]["ready"]["command"] == true)
        .expect("ready receipt");
    for (_, r) in &reports[..first_ready] {
        assert_eq!(r["receipt"]["ready"]["command"], false);
        assert_ne!(r["receipt"]["runtimeState"], "running");
    }
    assert_eq!(reports[first_ready].1["receipt"]["runtimeState"], "running");
    for (_, r) in &reports[first_ready + 1..] {
        assert_eq!(
            r["receipt"]["ready"]["command"], false,
            "readiness withdrawn on stop"
        );
    }
    // Prepare request: real Swift DirectBoot shape, pins bound to the launch tuple.
    let request: Value =
        serde_json::from_slice(&std::fs::read(d.root.join("prepare.json")).unwrap()).unwrap();
    assert!(request.get("image").is_none());
    let boot = &request["directBoot"];
    let attempt = boot["bootAttempt"].as_str().unwrap();
    assert_eq!(boot["launchFilesystemUUID"], attempt);
    assert_eq!(boot["bootSessionID"], json!(boot_id()));
    assert_eq!(boot["revision"], 1);
    assert_eq!(
        boot["commandLine"],
        "console=hvc0 root=/dev/vda rootfstype=erofs ro"
    );
    assert_eq!(
        format!("sha256:{}", boot["bundleDigest"].as_str().unwrap()),
        d.c.inventory[0].image.digest
    );
    for (role, path) in ["kernel", "initrd", "rootfs"].iter().zip(&d.artifacts) {
        assert_eq!(boot[role]["path"], json!(path));
        assert_eq!(
            boot[role]["sha256"],
            sha(&std::fs::read(path).unwrap()).as_str()
        );
    }
    assert!(boot["launchMedium"]["path"]
        .as_str()
        .unwrap()
        .ends_with("/workspace/bootstrap/launch.erofs"));
    // Hello carried the launch binding; the controller's newer revision followed as renew.
    let frames = frames.lock().unwrap();
    assert!(
        matches!(&frames[0], Host::Hello { binding, remaining_ms, .. }
        if binding.boot_attempt.to_string() == attempt && binding.revision == 1 && *remaining_ms < 100_000)
    );
    assert!(frames
        .iter()
        .any(|f| matches!(f, Host::Renew { binding, .. } if binding.revision == 2)));
    assert!(
        !frames.iter().any(|f| matches!(f, Host::Exec { .. })),
        "no host exec"
    );
    assert!(!calls(&d).contains("prepare\nrun\nrun"));
    assert_cleaned(&d, &w);
}
#[test]
fn wrong_guest_identity_or_version_never_ready_and_fences() {
    for mode in [Mode::WrongIdentity, Mode::WrongVersion] {
        let d = direct_fixture(|_| {});
        let (result, w, _) = launch_direct(&d, mode, 100.0);
        result.unwrap();
        assert_cleaned(&d, &w);
        for (_, r) in &w.requests {
            if let Some(r) = r.get("receipt") {
                assert_eq!(r["ready"]["command"], false);
                assert_ne!(r["runtimeState"], "running");
            }
        }
        let (_, last) = w.requests.last().unwrap();
        assert_eq!(last["receipt"]["failure"], "runtime");
        assert_eq!(last["receipt"]["runtimeState"], "stopped");
    }
}
#[test]
fn stalled_handshake_expires_locally_while_controller_is_unreachable() {
    let d = direct_fixture(|_| {});
    let mut s = seeded(&d.c);
    s.state.deadline = clock::now().as_secs_f64() + 4.5;
    s.save().unwrap();
    let mut w = wire(s.assignment().unwrap().clone());
    w.lose = true; // No renewal can arrive: only the local continuous deadline applies.
    let frames = fake_guest(&d, Mode::Stall);
    let started = std::time::Instant::now();
    assert!(s.run_once(&mut w).is_err());
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "supervision blocked"
    );
    assert!(s.state.fenced && s.state.stopped && !s.state.cleaned);
    assert!(matches!(frames.lock().unwrap()[0], Host::Hello { .. }));
    assert!(
        d.c.state.join("workspace").exists(),
        "no cleanup without acknowledgment"
    );
    drop(s);
    let mut s = Satellite::open_preflighted(d.c.clone()).unwrap();
    w.lose = false;
    s.run_once(&mut w).unwrap();
    for (_, r) in &w.requests {
        if let Some(r) = r.get("receipt") {
            assert_eq!(r["ready"]["command"], false);
        }
    }
    assert_cleaned(&d, &w);
}
#[test]
fn preflight_rejects_bad_builder_bundle_and_mutable_artifacts_before_claim() {
    let d = direct_fixture(|_| {});
    let mut missing = d.c.clone();
    missing.bootstrap_builder = None;
    assert_eq!(
        validate_local(&missing).unwrap_err(),
        "boot bundle requires a pinned bootstrap builder"
    );
    let mut bad = d.c.clone();
    bad.bootstrap_builder.as_mut().unwrap().sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(validate_local(&bad).is_err());
    let mut digest = d.c.clone();
    digest.inventory[0].image.digest = format!("sha256:{}", "1".repeat(64));
    assert!(validate_local(&digest).is_err());
    let no_initrd = direct_fixture(|m| m.initrd = None);
    assert_eq!(
        validate_local(&no_initrd.c).unwrap_err(),
        "direct boot v1 requires a bootstrap initrd"
    );
    let rw = direct_fixture(|m| m.command_line = "root=/dev/vda rootfstype=erofs rw".into());
    assert!(validate_local(&rw.c).is_err());
    // Removing the immutable flag fails the cheap descriptor proof.
    let c = CString::new(d.artifacts[2].as_os_str().as_bytes()).unwrap();
    unsafe { libc::chflags(c.as_ptr(), 0) };
    assert!(validate_local(&d.c).is_err());
    assert!(!d.c.state.exists(), "preflight created no state");
}
#[test]
fn recovered_ready_launch_reports_unknown_and_never_relaunches_or_execs() {
    let d = direct_fixture(|_| {});
    let mut s = seeded(&d.c);
    s.state.launch_intent = true;
    s.state.prepared = true;
    s.state.direct = Some(super::super::Direct {
        boot_attempt: uuid::Uuid::from_u128(5),
        revision: 1,
        bundle_digest: "a".repeat(64),
        artifacts: vec![],
        medium: None,
        agent_socket: None,
        ready: true,
        withdrawn: false,
        timings: Timings::default(),
    });
    s.save().unwrap();
    s.dir.workspace().unwrap();
    let machine = machine_of(&d.c);
    std::fs::create_dir(&machine).unwrap();
    std::fs::set_permissions(&machine, std::fs::Permissions::from_mode(0o700)).unwrap();
    drop(s);
    let mut s = Satellite::open_preflighted(d.c.clone()).unwrap();
    let mut w = wire(s.assignment().unwrap().clone());
    w.lose = true;
    assert!(s.run_once(&mut w).is_err());
    w.lose = false;
    assert!(s.run_once(&mut w).is_err());
    assert_eq!(w.requests[0], w.requests[1], "lost report replayed exactly");
    for (_, r) in &w.requests {
        assert_eq!(r["receipt"]["ready"]["command"], false);
        assert_eq!(r["receipt"]["runtimeState"], "unknown");
    }
    assert!(!calls(&d).contains("prepare") && !calls(&d).contains("run"));
    assert!(
        machine.join("power-off.request").exists(),
        "recovery fences, never relaunches"
    );
}
#[test]
fn started_record_must_bind_this_launch_and_private_relay() {
    let d = direct_fixture(|_| {});
    let machine = d.root.join("m");
    std::fs::create_dir(&machine).unwrap();
    let e = guest::Expected {
        lease_id: uuid::Uuid::from_u128(11),
        member_id: uuid::Uuid::from_u128(12),
        boot_session_id: boot_id(),
        boot_attempt: uuid::Uuid::from_u128(5),
        boot: 1.0,
    };
    let now = clock::now().as_secs_f64();
    assert!(guest::read_started(&machine, &e, now).unwrap().is_none());
    let sock = format!(
        "{}/canaveral-{}/agent.sock",
        guest::SOCKET_ROOT,
        uuid::Uuid::from_u128(9)
    );
    let good = json!({"event":"started","version":1,"continuous":now,"memberID":e.member_id,
        "leaseID":e.lease_id,"bootSessionID":e.boot_session_id,"bootAttempt":e.boot_attempt,"agentSocket":sock});
    let file = machine.join("direct-started.json");
    std::fs::write(&file, good.to_string()).unwrap();
    assert_eq!(
        guest::read_started(&machine, &e, now).unwrap(),
        Some(sock.clone())
    );
    for (key, value) in [
        ("bootAttempt", json!(uuid::Uuid::from_u128(6))),
        ("memberID", json!(uuid::Uuid::from_u128(1))),
        ("agentSocket", json!("/private/tmp/consumer.sock")),
        ("event", json!("ready")),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        std::fs::write(&file, bad.to_string()).unwrap();
        assert!(guest::read_started(&machine, &e, now).is_err(), "{key}");
    }
    // A relay directory that is not privately owned is never connected.
    assert!(guest::connect(&sock).is_err());
}

/// Real supervision path, fake helper/socket guest/controller; no VM or signing.
#[test]
fn command_poll_report_loss_retries_exact_receipt_and_executes_once() {
    struct Commands {
        wire: Wire,
        pending: Option<Value>,
        reports: Vec<Value>,
    }
    impl Controller for Commands {
        fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
            match route {
                LeaseRoute::OperationPoll => {
                    if self.pending.is_none() {
                        self.pending = Some(
                            json!({"id":uuid::Uuid::from_u128(42),"leaseId":self.wire.a.lease_id,
                            "memberId":self.wire.a.member_id,"assignmentId":self.wire.a.id,
                            "bootAttempt":body["bootAttempt"],"bundleDigest":body["bundleDigest"],
                            "arguments":{"argv":["echo","fixture"]},"startBefore":200.0,"timeoutMs":30000,"state":"queued"}),
                        );
                    }
                    Ok(
                        json!({"command":self.pending,"lease":{"state":"ready","revision":2,"expiresAt":200.0,"controllerNow":100.0},"cancelRequested":false}),
                    )
                }
                LeaseRoute::OperationReport => {
                    self.reports.push(body.clone());
                    assert_eq!(body["receipt"]["state"], "succeeded");
                    assert_eq!(body["receipt"]["result"]["stdoutBase64"], "Zml4dHVyZQo=");
                    if self.reports.len() == 1 {
                        return Err("lost committed report reply");
                    }
                    assert_eq!(self.reports[0], body, "exact report retry");
                    self.wire.cancel = true;
                    Ok(json!({"operationId":body["operationId"],"state":"succeeded"}))
                }
                _ => self.wire.request(route, body),
            }
        }
    }
    let d = direct_fixture(|_| {});
    let mut satellite = seeded(&d.c);
    satellite.state.deadline = clock::now().as_secs_f64() + 20.0;
    satellite.save().unwrap();
    let frames = fake_guest(&d, Mode::Command);
    let mut controller = Commands {
        wire: wire(satellite.assignment().unwrap().clone()),
        pending: None,
        reports: vec![],
    };
    satellite.run_once(&mut controller).unwrap();
    assert!(controller.reports.len() >= 2);
    assert_eq!(
        frames
            .lock()
            .unwrap()
            .iter()
            .filter(|f| matches!(f, Host::Exec { .. }))
            .count(),
        1
    );
    assert!(satellite.state.cleaned);
}
#[test]
fn active_command_stalled_poll_cannot_delay_local_fence_or_stop() {
    struct Stalled {
        wire: Wire,
        polls: usize,
        machine: PathBuf,
    }
    impl Controller for Stalled {
        fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
            match route {
                LeaseRoute::OperationPoll => {
                    self.polls += 1;
                    if self.polls == 2 {
                        std::thread::sleep(Duration::from_secs(5));
                        assert!(
                            self.machine.join("power-off.request").exists(),
                            "local fence waited for controller"
                        );
                        self.wire.cancel = true;
                        return Err("stalled reply lost");
                    }
                    Ok(
                        json!({"command":{"id":uuid::Uuid::from_u128(42),"leaseId":self.wire.a.lease_id,
                        "memberId":self.wire.a.member_id,"assignmentId":self.wire.a.id,
                        "bootAttempt":body["bootAttempt"],"bundleDigest":body["bundleDigest"],
                        "arguments":{"argv":["echo","fixture"]},"startBefore":200.0,"timeoutMs":30000,"state":"queued"},
                        "lease":{"state":"ready","revision":1,"expiresAt":200.0,"controllerNow":100.0},"cancelRequested":false}),
                    )
                }
                LeaseRoute::OperationReport => {
                    assert_eq!(body["receipt"], json!({"state":"unknown"}));
                    Ok(json!({"operationId":body["operationId"],"state":"unknown"}))
                }
                _ => {
                    let mut reply = self.wire.request(route, body)?;
                    reply["lease"]["revision"] = json!(1);
                    Ok(reply)
                }
            }
        }
    }
    let d = direct_fixture(|_| {});
    let mut satellite = seeded(&d.c);
    satellite.state.deadline = clock::now().as_secs_f64() + 3.5;
    satellite.save().unwrap();
    // Ready mode leaves exec running; the local deadline must cancel and fence it.
    let frames = fake_guest(&d, Mode::Ready);
    let mut controller = Stalled {
        wire: wire(satellite.assignment().unwrap().clone()),
        polls: 0,
        machine: machine_of(&d.c),
    };
    satellite.run_once(&mut controller).unwrap();
    assert_eq!(controller.polls, 2);
    assert_eq!(
        frames
            .lock()
            .unwrap()
            .iter()
            .filter(|f| matches!(f, Host::Exec { .. }))
            .count(),
        1
    );
    assert_eq!(
        satellite.state.operations.current.as_ref().unwrap().receipt,
        Some(json!({"state":"unknown"}))
    );
    assert!(satellite.state.stopped);
}
