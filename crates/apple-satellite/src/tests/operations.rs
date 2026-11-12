use super::*;
use crate::operations::{Arguments, Command as OperationCommand, Lane, Worker};
use base64::{engine::general_purpose::STANDARD, Engine};
use canaveral_guest_protocol::{encode, Decoder, Guest, Host};
fn command() -> OperationCommand {
    OperationCommand {
        id: uuid::Uuid::from_u128(42),
        lease_id: uuid::Uuid::from_u128(1),
        member_id: uuid::Uuid::from_u128(2),
        assignment_id: uuid::Uuid::from_u128(4),
        boot_attempt: uuid::Uuid::from_u128(3),
        bundle_digest: "a".repeat(64),
        arguments: Arguments {
            argv: vec!["echo".into(), "hello".into()],
        },
        start_before: 200.0,
        timeout_ms: 30000,
        execution_deadline_at: None,
        state: "queued".into(),
    }
}
fn ready() -> (guest::Session, std::os::unix::net::UnixStream) {
    let (mut s, mut peer) = guest::tests::session_pair();
    guest::tests::send_ready(&s, &mut peer);
    assert!(s.pump(100.0).unwrap());
    (s, peer)
}
#[test]
fn socket_command_drains_beyond_capture_and_replays_exact_receipt_without_exec() {
    let (mut session, mut peer) = ready();
    let mut lane = Lane::default();
    assert!(lane.receive(command(), 132.0).unwrap());
    let id = session
        .exec(
            command().arguments.argv,
            "/workspace".into(),
            Default::default(),
            30000,
            100.0,
        )
        .unwrap();
    assert_ne!(id, command().id);
    lane.current.as_mut().unwrap().guest_id = Some(id);
    session.credit(65536).unwrap();
    session.pump(100.0).unwrap();
    let mut decoder = Decoder::default();
    let mut buf = [0u8; 4096];
    let mut execs = 0;
    // Read the exec and initial credit from the fake guest side.
    for _ in 0..2 {
        loop {
            let n = peer.read(&mut buf[..decoder.needed().min(4096)]).unwrap();
            if let Some(frame) = decoder.feed(&buf[..n]).unwrap() {
                if let Host::Exec {
                    cwd,
                    env,
                    timeout_ms,
                    ..
                } = frame
                {
                    execs += 1;
                    assert_eq!(cwd, "/workspace");
                    assert!(env.is_empty());
                    assert_eq!(timeout_ms, 30000);
                }
                break;
            }
        }
    }
    for seq in 0..5 {
        // Each payload fits a socket write and exercises bounded credit replenishment.
        let data = vec![b'x'; 65536];
        let frame = Guest::Output {
            version: 1,
            id,
            stream: "stdout".into(),
            seq,
            data: STANDARD.encode(&data),
        };
        let bytes = encode(&frame).unwrap();
        // Socket capacity can be smaller than a frame; producer and consumer advance together.
        std::thread::scope(|scope| {
            scope.spawn(|| peer.write_all(&bytes).unwrap());
            loop {
                session.pump(100.0).unwrap();
                if let Some(event) = session.next_event() {
                    lane.current
                        .as_mut()
                        .unwrap()
                        .event(event, &mut session)
                        .unwrap();
                    break;
                }
                std::thread::yield_now();
            }
        });
    }
    peer.write_all(
        &encode(&Guest::Exit {
            version: 1,
            id,
            status: Some(0),
            signal: None,
            timed_out: false,
            duration_ms: 100,
            stdout_bytes: 5 * 65536,
            stderr_bytes: 0,
            termination_confirmed: true,
        })
        .unwrap(),
    )
    .unwrap();
    loop {
        session.pump(100.0).unwrap();
        if let Some(event) = session.next_event() {
            lane.current
                .as_mut()
                .unwrap()
                .event(event, &mut session)
                .unwrap();
            break;
        }
    }
    let saved = serde_json::to_vec(&lane).unwrap();
    let mut recovered: Lane = serde_json::from_slice(&saved).unwrap();
    recovered.current.as_mut().unwrap().unknown();
    let receipt = recovered.current.as_ref().unwrap().receipt.clone().unwrap();
    assert_eq!(receipt["state"], "succeeded");
    assert_eq!(receipt["result"]["truncated"], true);
    assert_eq!(
        STANDARD
            .decode(receipt["result"]["stdoutBase64"].as_str().unwrap())
            .unwrap()
            .len(),
        262144
    );
    assert!(!recovered.receive(command(), 200.0).unwrap());
    recovered
        .acknowledge(json!({"operationId":command().id,"state":"succeeded"}))
        .unwrap();
    let mut next = command();
    next.id = uuid::Uuid::from_u128(43);
    assert!(recovered.receive(next, 250.0).unwrap());
    assert!(recovered.receive(command(), 250.0).is_err());
    assert_eq!(execs, 1);
}
#[test]
fn received_intent_restart_is_unknown_and_blocks_another_command() {
    let mut lane = Lane::default();
    lane.receive(command(), 132.0).unwrap();
    let mut recovered: Lane = serde_json::from_slice(&serde_json::to_vec(&lane).unwrap()).unwrap();
    recovered.current.as_mut().unwrap().unknown();
    assert_eq!(
        recovered.current.as_ref().unwrap().receipt,
        Some(json!({"state":"unknown"}))
    );
    assert!(!recovered.receive(command(), 200.0).unwrap());
    let mut other = command();
    other.id = uuid::Uuid::from_u128(43);
    assert!(recovered.receive(other, 200.0).is_err());
}
#[test]
fn cleanup_and_restart_preserve_unacknowledged_operation_before_a_new_claim() {
    struct Reporting {
        inner: Wire,
        lose_operation: bool,
        operation_reports: Vec<Value>,
    }
    impl Controller for Reporting {
        fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
            if matches!(route, LeaseRoute::OperationReport) {
                self.operation_reports.push(body.clone());
                if self.lose_operation {
                    return Err("lost operation report");
                }
                return Ok(
                    json!({"operationId":body["operationId"],"state":body["receipt"]["state"]}),
                );
            }
            self.inner.request(route, body)
        }
    }
    let (_tmp, c) = fixture();
    let mut s = seeded(&c);
    let assignment = s.assignment().unwrap().clone();
    let mut cmd = command();
    cmd.assignment_id = assignment.id;
    cmd.lease_id = assignment.lease_id;
    cmd.member_id = assignment.member_id;
    s.state.direct = Some(Direct {
        boot_attempt: cmd.boot_attempt,
        revision: 1,
        bundle_digest: cmd.bundle_digest.clone(),
        artifacts: vec![],
        medium: None,
        agent_socket: None,
        workspace_disk: None,
        data_nonce: None,
        operator_deny_digest: None,
        data_closed: None,
        ready: false,
        withdrawn: true,
        timings: Timings::default(),
    });
    s.state.operations.receive(cmd, 132.0).unwrap();
    s.state.operations.current.as_mut().unwrap().receipt = Some(json!({"state":"failed"}));
    s.state.fenced = true;
    s.state.stopped = true;
    s.state.terminal = true;
    s.state.cleaned = true;
    s.save().unwrap();
    let mut controller = Reporting {
        inner: wire(assignment.clone()),
        lose_operation: true,
        operation_reports: vec![],
    };
    controller.inner.cancel = true;
    controller.inner.claim_null = true;
    // Cleanup can release resources even while its separate operation report is lost.
    s.run_once(&mut controller).unwrap();
    assert!(s.state.released);
    assert!(!s.state.operations.current.as_ref().unwrap().acknowledged);
    let original = controller.operation_reports[0].clone();
    drop(s);
    let mut s = Satellite::open_preflighted(c).unwrap();
    assert!(s.run_once(&mut controller).is_err());
    assert_eq!(s.assignment().unwrap().id, assignment.id);
    assert!(controller
        .inner
        .requests
        .iter()
        .all(|(route, _)| *route != "claim"));
    controller.lose_operation = false;
    s.run_once(&mut controller).unwrap();
    assert!(s.state.assignment.is_none());
    assert_eq!(controller.operation_reports.len(), 3);
    assert!(controller.operation_reports.iter().all(|r| *r == original));
    assert_eq!(controller.inner.requests.last().unwrap().0, "claim");
}
#[test]
fn durable_replay_membership_has_no_4096_command_cutoff_or_eviction() {
    let (_tmp, c) = fixture();
    let mut s = seeded(&c);
    let assignment = s.assignment().unwrap().id;
    // An independently seeded retained bucket exercises the old count boundary
    // without thousands of fsyncs in a portable unit test.
    let name = format!("completed-{}-00", s.state.claim_id);
    let mut bytes = assignment.as_bytes().to_vec();
    for i in 1..=4096 {
        bytes.extend_from_slice(uuid::Uuid::from_u128(i).as_bytes());
    }
    s.dir.write(&name, "history.next", &bytes).unwrap();
    let mut cmd = command();
    cmd.id = uuid::Uuid::from_u128(4097);
    s.state.operations.receive(cmd.clone(), 200.0).unwrap();
    s.state.operations.current.as_mut().unwrap().receipt = Some(json!({"state":"failed"}));
    s.acknowledge_operation(json!({"operationId":cmd.id,"state":"failed"}))
        .unwrap();
    assert!(s.state.operations.completed.is_empty());
    let claim = s.state.claim_id;
    drop(s);
    let mut s = Satellite::open_preflighted(c).unwrap();
    for id in [uuid::Uuid::from_u128(1), cmd.id] {
        assert!(s.dir.operation_completed(claim, assignment, id).unwrap());
    }
    assert!(!s
        .dir
        .operation_completed(claim, assignment, uuid::Uuid::from_u128(4098))
        .unwrap());
    let a = s.assignment().unwrap().clone();
    let mut old = cmd;
    old.id = uuid::Uuid::from_u128(1);
    old.assignment_id = a.id;
    old.lease_id = a.lease_id;
    old.member_id = a.member_id;
    s.state.direct = Some(Direct {
        boot_attempt: old.boot_attempt,
        revision: 1,
        bundle_digest: old.bundle_digest.clone(),
        artifacts: vec![],
        medium: None,
        agent_socket: None,
        workspace_disk: None,
        data_nonce: None,
        operator_deny_digest: None,
        data_closed: None,
        ready: true,
        withdrawn: false,
        timings: Timings::default(),
    });
    let reply = json!({"command":old,"lease":{"state":"ready","revision":1,"expiresAt":200.0,"controllerNow":100.0},"cancelRequested":false});
    // A stale completed UUID is refused before a missing session could dispatch it.
    assert_eq!(
        s.accept_poll(reply, clock::now().as_secs_f64(), None),
        Err("completed operation cannot execute again")
    );
}
#[test]
fn history_migrates_legacy_membership_and_refuses_corruption_and_links() {
    let (tmp, c) = fixture();
    let mut s = seeded(&c);
    let id = uuid::Uuid::from_u128(7);
    s.state.operations.completed.push(id);
    s.save().unwrap();
    let claim = s.state.claim_id;
    let assignment = s.assignment().unwrap().id;
    drop(s);
    let s = Satellite::open_preflighted(c).unwrap();
    assert!(s.state.operations.completed.is_empty());
    assert!(s.dir.operation_completed(claim, assignment, id).unwrap());
    assert!(s
        .dir
        .record_operation(claim, uuid::Uuid::from_u128(99), id)
        .is_err());
    let name = format!("completed-{claim}-00");
    s.dir.write(&name, "history.next", &[1; 17]).unwrap();
    assert!(s.dir.operation_completed(claim, assignment, id).is_err());
    assert!(s.dir.record_operation(claim, assignment, id).is_err());
    let path = s.config.state.join(name);
    std::fs::remove_file(&path).unwrap();
    let other = tmp.path().join("unrelated-history");
    std::fs::write(&other, b"keep").unwrap();
    symlink(&other, &path).unwrap();
    assert!(s.dir.record_operation(claim, assignment, id).is_err());
    assert_eq!(std::fs::read(other).unwrap(), b"keep");
}
#[test]
fn output_sequence_and_exit_counts_are_validated() {
    let (mut session, _peer) = ready();
    let mut lane = Lane::default();
    lane.receive(command(), 132.0).unwrap();
    let op = lane.current.as_mut().unwrap();
    let id = uuid::Uuid::from_u128(900);
    op.guest_id = Some(id);
    assert!(op
        .event(
            Guest::Output {
                version: 1,
                id,
                stream: "stdout".into(),
                seq: 1,
                data: "eA==".into()
            },
            &mut session
        )
        .is_err());
    assert!(op
        .event(
            Guest::Exit {
                version: 1,
                id,
                status: Some(0),
                signal: None,
                timed_out: false,
                duration_ms: 10,
                stdout_bytes: 1,
                stderr_bytes: 0,
                termination_confirmed: true
            },
            &mut session
        )
        .is_err());
    op.unknown();
    assert_eq!(op.receipt, Some(json!({"state":"unknown"})));
}
#[test]
fn stalled_worker_does_not_block_socket_pumping_or_cancel() {
    struct Stalled(std::sync::mpsc::Receiver<()>);
    impl Controller for Stalled {
        fn request(&mut self, _: LeaseRoute, _: Value) -> Result<Value> {
            self.0.recv().unwrap();
            Err("lost report")
        }
    }
    let (release, hold) = std::sync::mpsc::channel();
    let mut controller = Stalled(hold);
    std::thread::scope(|scope| {
        let worker = Worker::spawn(scope, &mut controller);
        worker.send.send((LeaseRoute::Report, json!({}))).unwrap();
        let (mut session, mut peer) = ready();
        let id = session
            .exec(
                vec!["sleep".into(), "30".into()],
                "/workspace".into(),
                Default::default(),
                30000,
                100.0,
            )
            .unwrap();
        session.cancel(id).unwrap();
        session.pump(100.0).unwrap();
        assert!(worker.recv.try_recv().is_err());
        let mut decoder = Decoder::default();
        let mut buf = [0u8; 4096];
        let mut cancelled = false;
        for _ in 0..2 {
            loop {
                let n = peer.read(&mut buf[..decoder.needed().min(4096)]).unwrap();
                if let Some(frame) = decoder.feed(&buf[..n]).unwrap() {
                    if matches!(frame,Host::Cancel{id:found,..} if found==id) {
                        cancelled = true;
                    }
                    break;
                }
            }
        }
        assert!(cancelled);
        release.send(()).unwrap();
        drop(worker);
    });
}
#[test]
fn old_journal_without_operation_fields_loads_and_restart_cannot_dispatch() {
    let (_tmp, c) = fixture();
    let mut s = seeded(&c);
    s.state.launch_intent = true;
    s.save().unwrap();
    let mut value = serde_json::to_value(&s.state).unwrap();
    value.as_object_mut().unwrap().remove("operations");
    let old: Journal = serde_json::from_value(value).unwrap();
    assert!(old.operations.current.is_none());
    let mut w = wire(s.assignment().unwrap().clone());
    assert!(s.run_once(&mut w).is_err());
    assert!(w.requests.iter().all(|(name, _)| *name == "report"));
}
#[test]
fn failure_after_durable_poll_intent_recovers_unknown_without_guest_effects() {
    let (_tmp, c) = fixture();
    let mut s = seeded(&c);
    s.state.launch_intent = true;
    s.state.direct = Some(Direct {
        boot_attempt: uuid::Uuid::from_u128(3),
        revision: 1,
        bundle_digest: "a".repeat(64),
        artifacts: vec![],
        medium: None,
        agent_socket: None,
        workspace_disk: None,
        data_nonce: None,
        operator_deny_digest: None,
        data_closed: None,
        ready: true,
        withdrawn: false,
        timings: Timings::default(),
    });
    let mut cmd = command();
    cmd.assignment_id = s.assignment().unwrap().id;
    cmd.lease_id = s.assignment().unwrap().lease_id;
    cmd.member_id = s.assignment().unwrap().member_id;
    let poll = json!({"command":cmd,"lease":{"state":"ready","revision":1,"expiresAt":200.0,"controllerNow":100.0},"cancelRequested":false});
    // Missing guest session injects failure after receive/save, before any exec.
    assert_eq!(
        s.accept_poll(poll, clock::now().as_secs_f64(), None)
            .unwrap_err(),
        "missing guest session"
    );
    assert!(s
        .state
        .operations
        .current
        .as_ref()
        .unwrap()
        .guest_id
        .is_none());
    drop(s);
    let mut recovered = Satellite::open_preflighted(c).unwrap();
    assert!(recovered.state.operations.current.is_some());
    let mut w = wire(recovered.assignment().unwrap().clone());
    assert!(recovered.run_once(&mut w).is_err());
    assert!(recovered.state.fenced);
    let reports: Vec<_> = w
        .requests
        .iter()
        .filter(|(name, _)| *name == "operationReport")
        .collect();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].1["receipt"], json!({"state":"unknown"}));
    assert!(!w.requests.iter().any(|(name, _)| *name == "operationPoll"));
}

#[test]
fn workspace_command_deadline_is_fixed_and_conservative() {
    let mut c = command();
    assert!(c.validate_timing(false).is_ok());
    assert!(c.validate_timing(true).is_err());
    c.timeout_ms = 1800000;
    c.execution_deadline_at = Some(1100.0);
    assert_eq!(c.timeout(true, 100.0, 1000.0, 400.0, 110.0).unwrap(), 90000);
    // Renewal may extend lease authority, never this execution's frozen deadline.
    assert_eq!(c.timeout(true, 100.0, 1000.0, 900.0, 110.0).unwrap(), 90000);
    assert_eq!(c.timeout(true, 100.0, 1000.0, 120.0, 110.0).unwrap(), 8000);
    assert_eq!(c.timeout(true, 100.0, 1000.0, 900.0, 198.0).unwrap(), 2000);
    c.timeout_ms = 1;
    assert_eq!(c.timeout(true, 100.0, 1000.0, 900.0, 110.0).unwrap(), 1);
    assert!(c.validate_timing(false).is_err());
    c.timeout_ms = 1800001;
    assert!(c.validate_timing(true).is_err());
    c.timeout_ms = 30000;
    c.execution_deadline_at = Some(f64::NAN);
    assert!(c.validate_timing(true).is_err());
}
#[test]
fn workspace_exec_carries_no_environment_overrides() {
    for enabled in [false, true] {
        assert!(crate::operations::environment(enabled).is_empty());
    }
}

#[test]
fn incomplete_workspace_snapshot_refuses_assignments_and_cleanup_evidence() {
    let (_tmp, c) = fixture();
    let mut s = seeded(&c);
    s.state.assignment.as_mut().unwrap().workspace_io_version = Some(1);
    assert!(matches!(
        s.validate_assignment(s.assignment().unwrap()),
        Err("incomplete workspace admission snapshot")
    ));
    let r = s.receipt().unwrap();
    assert_eq!(r["receipt"]["workspaceRemoved"], false);
    assert_eq!(r["receipt"]["dataPlaneClosed"], false);
    s.state.stopped = true;
    s.state.cleaned = true;
    // Generic storage flags alone cannot prove the disk or data-plane lifecycle.
    let r = s.receipt().unwrap();
    assert_eq!(r["receipt"]["workspaceRemoved"], false);
    assert_eq!(r["receipt"]["dataPlaneClosed"], false);
}

#[test]
fn controller_short_deadlines_convert_without_lease_margin() {
    let mut c = command();
    for ms in [1, 1500, 2500] {
        c.timeout_ms = ms;
        c.execution_deadline_at = Some(1000.0 + ms as f64 / 1000.0);
        let timeout = c.timeout(true, 100.0, 1000.0, 400.0, 100.0).unwrap();
        assert!(timeout > 0 && timeout <= ms);
        assert_eq!(c.timeout(true, 100.0, 1000.0, 400.0, 103.0).unwrap(), 0);
    }
}

#[test]
fn expired_command_before_exec_reports_timeout_without_fencing_lease() {
    for ms in [1, 1500, 2500] {
        let (_tmp, config) = fixture();
        let mut s = seeded(&config);
        s.state.assignment.as_mut().unwrap().workspace_io_version = Some(1);
        s.state.direct = Some(Direct {
            boot_attempt: uuid::Uuid::from_u128(3),
            revision: 1,
            bundle_digest: "a".repeat(64),
            artifacts: vec![],
            medium: None,
            agent_socket: None,
            workspace_disk: None,
            data_nonce: None,
            operator_deny_digest: None,
            data_closed: None,
            ready: true,
            withdrawn: false,
            timings: Timings::default(),
        });
        let a = s.assignment().unwrap();
        let mut cmd = command();
        cmd.assignment_id = a.id;
        cmd.lease_id = a.lease_id;
        cmd.member_id = a.member_id;
        cmd.timeout_ms = ms;
        cmd.execution_deadline_at = Some(100.0 + ms as f64 / 1000.0);
        // Controller dispatch plus timeout, with a response arriving three seconds later.
        let poll = json!({"command":cmd,"lease":{"state":"ready","revision":1,
            "expiresAt":200.0,"controllerNow":100.0},"cancelRequested":false});
        s.accept_poll(poll, clock::now().as_secs_f64() - 3.0, None)
            .unwrap();
        let op = s.state.operations.current.as_ref().unwrap();
        assert!(op.guest_id.is_none());
        assert_eq!(op.receipt.as_ref().unwrap()["state"], "failed");
        assert_eq!(op.receipt.as_ref().unwrap()["result"]["timedOut"], true);
        assert!(!s.state.fenced);
    }
}
