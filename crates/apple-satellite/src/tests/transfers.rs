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

#[test]
fn opened_transfer_missed_start_cancels_and_blocks_successors() {
    opened_transfer_local_refusal(false);
}
#[test]
fn opened_transfer_expiry_after_persistence_cancels_and_blocks_successors() {
    opened_transfer_local_refusal(true);
}
fn opened_transfer_local_refusal(persisted: bool) {
    for upload in [false, true] {
        let (_tmp, mut s, mut data, mut guest) = setup();
        let begin = if upload {
            json!({"action":"beginUpload","path":"file","bytes":3,"sha256":"a".repeat(64),"replace":false})
        } else {
            json!({"action":"beginDownload","path":"file"})
        };
        s.accept_transfer_poll(poll(&s, begin, 1, false), clock::now().as_secs_f64(), &data)
            .unwrap();
        read_frame(&mut guest);
        guest
            .write_all(
                &wire::encode(
                    &Frame::TransferReceipt {
                        version: 1,
                        id: uuid::Uuid::from_u128(42),
                        step: 1,
                        receipt: if upload {
                            Receipt::Writing { offset: 0 }
                        } else {
                            Receipt::Reading {
                                offset: 0,
                                bytes: Some(3),
                                data: None,
                            }
                        },
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
        s.state
            .transfers
            .acknowledge(
                json!({"transferId":uuid::Uuid::from_u128(42),"step":1,"state":"succeeded"}),
            )
            .unwrap();
        let request = if upload {
            json!({"action":"write","offset":0,"data":"YWJj"})
        } else {
            json!({"action":"read","offset":0,"maxBytes":3})
        };
        let sent = clock::now().as_secs_f64();
        let mut reply = poll(&s, request, 2, false);
        if !persisted {
            reply["transfer"]["startBefore"] = json!(1001.0);
        }
        let mut calls = 0;
        s.accept_transfer_poll_with_clock(reply, sent, &data, || {
            calls += 1;
            // First read admits work; the second occurs after both journal writes.
            sent + if persisted && calls == 1 {
                0.0
            } else if persisted {
                121.0
            } else {
                2.0
            }
        })
        .unwrap();
        assert_eq!(calls, if persisted { 2 } else { 1 });
        assert!(
            matches!(read_frame(&mut guest), Frame::TransferCancel { id, .. } if id == uuid::Uuid::from_u128(42))
        );
        let body = s.state.transfers.report(json!({})).unwrap();
        assert_eq!(
            body["receipt"],
            json!({"state":"unknown","code":"deadline"})
        );
        assert!(s.state.transfers.blocked);
        s.state
            .transfers
            .acknowledge(json!({"transferId":uuid::Uuid::from_u128(42),"step":2,"state":"unknown"}))
            .unwrap();
        let mut successor = poll(
            &s,
            json!({"action":"beginDownload","path":"next"}),
            1,
            false,
        );
        successor["transfer"]["id"] = json!(uuid::Uuid::from_u128(43));
        assert!(s.accept_transfer_poll(successor, sent, &data).is_err());
        let mut recovered: crate::transfers::Lane = serde_json::from_value(
            serde_json::from_slice::<Value>(
                &std::fs::read(s.config.state.join("state.json")).unwrap(),
            )
            .unwrap()["transfers"]
                .clone(),
        )
        .unwrap();
        recovered.recover();
        assert_eq!(recovered.report(json!({})).unwrap(), body);
        assert!(data.files_ready());
        assert!(!s.state.fenced);
        assert!(data.shutdown().complete());
    }
}

#[test]
fn transfer_stop_distinguishes_runtime_failure_from_terminal_lease() {
    for state in ["ready", "released", "expired", "failed"] {
        let (_tmp, mut s, data, _peer) = setup();
        s.accept_transfer_poll(
            json!({"transfer":null,"cancelRequested":true,"stopRequested":true,
            "lease":{"state":state,"revision":1,"expiresAt":1300.0,"controllerNow":1000.0}}),
            clock::now().as_secs_f64(),
            &data,
        )
        .unwrap();
        assert!(s.state.fenced);
        assert_eq!(s.state.terminal, state != "ready");
        assert_eq!(
            s.receipt().unwrap()["receipt"]["failure"],
            if state == "ready" {
                json!("runtime")
            } else {
                Value::Null
            }
        );
    }
}

#[test]
fn transfer_acknowledges_first_terminal_without_replacing_local_receipt() {
    for state in ["succeeded", "failed", "unknown"] {
        let (_tmp, mut s, data, _peer) = setup();
        let reply = poll(
            &s,
            json!({"action":"beginDownload","path":"file"}),
            1,
            false,
        );
        s.accept_transfer_poll(reply, clock::now().as_secs_f64(), &data)
            .unwrap();
        s.state.transfers.loss("authorization_lost");
        let step = s.state.transfers.current.as_ref().unwrap();
        let receipt = serde_json::to_value(&step.receipt).unwrap();
        let ack = json!({"transferId":step.work.id,"step":step.work.step,"state":state});
        s.state.transfers.acknowledge(ack).unwrap();
        let step = s.state.transfers.current.as_ref().unwrap();
        assert!(step.acknowledged);
        assert_eq!(serde_json::to_value(&step.receipt).unwrap(), receipt);
        assert!(s.state.transfers.blocked);
    }
}

#[test]
fn writing_controller_unknown_cancels_once_and_blocks_successors() {
    controller_terminal_cancels_opened_transfer(true, false);
}
#[test]
fn reading_controller_unknown_cancels_once_and_blocks_successors() {
    controller_terminal_cancels_opened_transfer(false, false);
}
#[test]
fn controller_unknown_journal_replay_retries_unsent_cancel() {
    for upload in [true, false] {
        controller_terminal_cancels_opened_transfer(upload, true);
    }
}
fn controller_terminal_cancels_opened_transfer(upload: bool, replay: bool) {
    for state in ["unknown", "failed"] {
        let (_tmp, mut s, mut data, mut guest) = setup();
        let request = if upload {
            json!({"action":"beginUpload","path":"file","bytes":3,"sha256":"a".repeat(64),"replace":false})
        } else {
            json!({"action":"beginDownload","path":"file"})
        };
        s.accept_transfer_poll(
            poll(&s, request, 1, false),
            clock::now().as_secs_f64(),
            &data,
        )
        .unwrap();
        assert!(matches!(
            read_frame(&mut guest),
            Frame::TransferRequest { .. }
        ));
        let receipt = if upload {
            Receipt::Writing { offset: 0 }
        } else {
            Receipt::Reading {
                offset: 0,
                bytes: Some(3),
                data: None,
            }
        };
        s.state
            .transfers
            .event(Frame::TransferReceipt {
                version: 1,
                id: uuid::Uuid::from_u128(42),
                step: 1,
                receipt: receipt.clone(),
            })
            .unwrap();
        s.state
            .transfers
            .acknowledge(json!({"transferId":uuid::Uuid::from_u128(42),"step":1,"state":state}))
            .unwrap();
        s.save().unwrap();
        if replay {
            // No transport: enqueue fails and must leave the durable retry pending.
            s.transfer_events(&data::Lane::default()).unwrap();
            assert!(!s.state.transfers.current.as_ref().unwrap().cancel_sent);
            let saved: Value =
                serde_json::from_slice(&std::fs::read(s.config.state.join("state.json")).unwrap())
                    .unwrap();
            s.state.transfers = serde_json::from_value(saved["transfers"].clone()).unwrap();
            s.state.transfers.recover();
        }
        s.transfer_events(&data).unwrap();
        assert!(
            matches!(read_frame(&mut guest), Frame::TransferCancel { id, .. } if id == uuid::Uuid::from_u128(42))
        );
        for _ in 0..3 {
            s.transfer_events(&data).unwrap();
        }
        let step = s.state.transfers.current.as_ref().unwrap();
        assert!(step.cancel_sent);
        assert!(step.acknowledged);
        assert_eq!(step.receipt, Some(receipt));
        assert!(s.state.transfers.blocked);
        let mut successor = poll(
            &s,
            json!({"action":"beginDownload","path":"next"}),
            1,
            false,
        );
        successor["transfer"]["id"] = json!(uuid::Uuid::from_u128(43));
        assert!(s
            .accept_transfer_poll(successor, clock::now().as_secs_f64(), &data)
            .is_err());
        guest
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let mut byte = [0];
        let error = guest.read(&mut byte).unwrap_err();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        assert!(data.shutdown().complete());
    }
}
