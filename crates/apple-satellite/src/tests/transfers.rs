use super::*;
use canaveral_guest_protocol::data::{self as wire, Frame, Receipt};
use std::os::unix::net::UnixStream;
fn read_frame(peer: &mut UnixStream) -> Frame {
    let mut n = [0; 4];
    peer.read_exact(&mut n).unwrap();
    let mut bytes = vec![0; u32::from_be_bytes(n) as usize];
    peer.read_exact(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
fn setup() -> (tempfile::TempDir, Satellite, data::Lane, UnixStream) {
    let (tmp, config) = fixture();
    let mut s = seeded(&config);
    s.state.direct = Some(Direct {
        boot_attempt: uuid::Uuid::from_u128(11),
        revision: 1,
        bundle_digest: "a".repeat(64),
        artifacts: vec![],
        medium: None,
        agent_socket: None,
        ready: true,
        withdrawn: false,
        timings: Timings::default(),
        workspace_disk: None,
        data_nonce: Some("b".repeat(64)),
        operator_deny_digest: None,
        data_closed: None,
    });
    let (host, mut peer) = UnixStream::pair().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let binding = s.guest_binding(1).unwrap();
    let mut lane = data::Lane::test_lane(host, binding.clone());
    assert!(matches!(read_frame(&mut peer), Frame::DataHello { .. }));
    peer.write_all(
        &wire::encode(
            &Frame::DataReady {
                version: 1,
                binding,
                nonce: "b".repeat(64),
            },
            wire::Sender::Guest,
        )
        .unwrap(),
    )
    .unwrap();
    for _ in 0..100 {
        lane.pump();
        if lane.files_ready() {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(lane.files_ready());
    (tmp, s, lane, peer)
}
fn poll(s: &Satellite, request: Value, step: u64, cancel: bool) -> Value {
    let a = s.assignment().unwrap();
    json!({"transfer":{"id":uuid::Uuid::from_u128(42),"leaseId":a.lease_id,"memberId":a.member_id,
        "assignmentId":a.id,"bootAttempt":s.state.direct.as_ref().unwrap().boot_attempt,
        "bundleDigest":"a".repeat(64),"step":step,"request":request,"startBefore":1120.0,"deadlineAt":1120.0,"state":"queued"},
        "lease":{"state":"ready","revision":1,"expiresAt":1300.0,"controllerNow":1000.0},"cancelRequested":cancel})
}
#[test]
fn guest_steps_journal_before_report_and_replay_exactly_after_restart() {
    let (_tmp, mut s, mut data, mut guest) = setup();
    let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let steps = [
        (
            json!({"action":"beginUpload","path":"file","bytes":0,"sha256":sha,"replace":false}),
            Receipt::Writing { offset: 0 },
        ),
        (
            json!({"action":"finish","bytes":0,"sha256":sha}),
            Receipt::Committed {
                bytes: 0,
                sha256: sha.into(),
                durable: true,
            },
        ),
    ];
    for (n, (request, receipt)) in steps.into_iter().enumerate() {
        let step = n as u64 + 1;
        s.state.transfers.poll_id().unwrap();
        s.save().unwrap();
        let reply = poll(&s, request, step, false);
        s.accept_transfer_poll(reply.clone(), clock::now().as_secs_f64(), &data)
            .unwrap();
        let frame = read_frame(&mut guest);
        assert!(matches!(frame, Frame::TransferRequest { step: n, .. } if n == step));
        // A repeated nonnull poll must not send a second request.
        s.accept_transfer_poll(reply, clock::now().as_secs_f64(), &data)
            .unwrap();
        let saved: Value =
            serde_json::from_slice(&std::fs::read(s.config.state.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(saved["transfers"]["current"]["handedOff"], true);
        guest
            .write_all(
                &wire::encode(
                    &Frame::TransferReceipt {
                        version: 1,
                        id: uuid::Uuid::from_u128(42),
                        step,
                        receipt,
                    },
                    wire::Sender::Guest,
                )
                .unwrap(),
            )
            .unwrap();
        for _ in 0..100 {
            s.transfer_events(&data).unwrap();
            if s.state
                .transfers
                .current
                .as_ref()
                .unwrap()
                .receipt
                .is_some()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let body = s
            .state
            .transfers
            .report(s.operation_binding().unwrap())
            .unwrap();
        let mut recovered: crate::transfers::Lane = serde_json::from_value(
            serde_json::from_slice::<Value>(
                &std::fs::read(s.config.state.join("state.json")).unwrap(),
            )
            .unwrap()["transfers"]
                .clone(),
        )
        .unwrap();
        recovered.recover();
        assert_eq!(
            recovered.report(s.operation_binding().unwrap()).unwrap(),
            body
        );
        s.state
            .transfers
            .acknowledge(json!({"transferId":body["transferId"],"step":step,"state":"succeeded"}))
            .unwrap();
    }
    assert!(data.shutdown().complete());
}
#[test]
fn cancellation_deadline_and_data_loss_use_the_data_lane_only() {
    let (_tmp, mut s, mut data, mut guest) = setup();
    let reply = poll(&s, json!({"action":"abort"}), 1, false);
    s.accept_transfer_poll(reply.clone(), clock::now().as_secs_f64(), &data)
        .unwrap();
    assert!(matches!(
        read_frame(&mut guest),
        Frame::TransferRequest { .. }
    ));
    let mut cancelled = reply;
    cancelled["cancelRequested"] = json!(true);
    s.accept_transfer_poll(cancelled, clock::now().as_secs_f64(), &data)
        .unwrap();
    assert!(matches!(
        read_frame(&mut guest),
        Frame::TransferCancel {
            reason: wire::CancelReason::AuthorizationLost,
            ..
        }
    ));
    assert!(!s.state.fenced);
    assert_eq!(
        s.state
            .transfers
            .report(s.operation_binding().unwrap())
            .unwrap()["receipt"]["state"],
        "unknown"
    );
    assert!(data.shutdown().complete());

    let (_tmp, mut s, data, mut guest) = setup();
    s.accept_transfer_poll(
        poll(&s, json!({"action":"abort"}), 1, false),
        clock::now().as_secs_f64(),
        &data,
    )
    .unwrap();
    read_frame(&mut guest);
    drop(guest);
    for _ in 0..100 {
        if !data.files_ready() {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    s.transfer_events(&data).unwrap();
    let body = s
        .state
        .transfers
        .report(s.operation_binding().unwrap())
        .unwrap();
    assert_eq!(
        body["receipt"],
        json!({"state":"unknown","code":"data_channel_lost"})
    );
    assert!(!s.state.fenced);
}

#[test]
fn local_deadline_sends_priority_cancel_and_undispatched_loss_is_failed() {
    let (_tmp, mut s, mut data, mut guest) = setup();
    let reply = poll(&s, json!({"action":"abort"}), 1, false);
    s.accept_transfer_poll(reply, clock::now().as_secs_f64(), &data)
        .unwrap();
    read_frame(&mut guest);
    s.state.transfers.current.as_mut().unwrap().deadline = clock::now().as_secs_f64() + 1.0;
    s.transfer_events(&data).unwrap();
    assert!(matches!(
        read_frame(&mut guest),
        Frame::TransferCancel {
            reason: wire::CancelReason::Deadline,
            ..
        }
    ));
    assert_eq!(
        s.state
            .transfers
            .report(s.operation_binding().unwrap())
            .unwrap()["receipt"],
        json!({"state":"unknown","code":"deadline"})
    );
    assert!(!s.state.fenced);
    assert!(data.shutdown().complete());

    let (_tmp, mut s, mut data, _guest) = setup();
    assert!(data.shutdown().complete());
    s.accept_transfer_poll(
        poll(&s, json!({"action":"abort"}), 1, false),
        clock::now().as_secs_f64(),
        &data,
    )
    .unwrap();
    assert_eq!(
        s.state
            .transfers
            .report(s.operation_binding().unwrap())
            .unwrap()["receipt"],
        json!({"state":"failed","code":"data_channel_lost"})
    );
    assert!(!s.state.fenced);
}

#[test]
fn launched_workspace_cleanup_requires_positive_joined_data_evidence() {
    let (_tmp, mut s, mut data, _guest) = setup();
    s.state.assignment.as_mut().unwrap().workspace_io_version = Some(1);
    s.state.stopped = true;
    assert_eq!(s.receipt().unwrap()["receipt"]["dataPlaneClosed"], false);
    let closed = data.shutdown();
    assert!(closed.complete());
    s.state.direct.as_mut().unwrap().data_closed = Some(closed.complete());
    assert_eq!(s.receipt().unwrap()["receipt"]["dataPlaneClosed"], true);
    s.state.direct.as_mut().unwrap().data_closed = Some(false);
    assert_eq!(s.receipt().unwrap()["receipt"]["dataPlaneClosed"], false);
}
