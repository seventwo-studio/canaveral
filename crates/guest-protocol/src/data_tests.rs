use super::*;
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
#[test]
fn strict_frames_and_poison_are_independent_of_control() {
    let frame = Frame::Credit {
        version: 1,
        id: id(1),
        bytes: 1,
    };
    let bytes = encode(&frame, Sender::Host).unwrap();
    let mut d = Decoder::default();
    for (i, b) in bytes.iter().enumerate() {
        assert_eq!(
            d.feed(&[*b], Sender::Host).unwrap().is_some(),
            i == bytes.len() - 1
        );
    }
    for json in [
        r#"{"type":"credit","version":1,"id":"00000000-0000-0000-0000-000000000001","bytes":1,"bytes":2}"#,
        r#"{"type":"credit","version":1,"id":"00000000-0000-0000-0000-000000000001","bytes":1,"extra":2}"#,
        r#"{"type":"credit","version":1,"id":"00000000-0000-0000-0000-000000000000","bytes":1}"#,
        r#"{"type":"credit","version":1,"id":"00000000-0000-0000-0000-000000000001","bytes":1.0}"#,
        r#"{"type":"credit","version":2,"id":"00000000-0000-0000-0000-000000000001","bytes":1}"#,
    ] {
        let mut d = Decoder::default();
        d.feed(&(json.len() as u32).to_be_bytes(), Sender::Host)
            .unwrap();
        assert!(d.feed(json.as_bytes(), Sender::Host).is_err());
        assert!(d.feed(&[], Sender::Host).is_err());
        // A separate control parser is unaffected by poisoning the data parser.
        let mut control = crate::Decoder::default();
        let frame = crate::encode(&crate::Host::Credit {
            version: 1,
            bytes: 1,
        })
        .unwrap();
        for b in frame {
            control.feed(&[b]).unwrap();
        }
    }
    for n in [0, MAX_FRAME + 1] {
        assert!(Decoder::default()
            .feed(&(n as u32).to_be_bytes(), Sender::Host)
            .is_err());
    }
    assert!(Frame::TransferCancel {
        version: 1,
        id: id(1),
        reason: CancelReason::Stop
    }
    .validate(Sender::Guest)
    .is_err());
}
#[test]
fn byte_bounds_and_paths() {
    for bad in ["", "Zg", "Zh==", "Zg==\n", "____"] {
        assert!(payload(bad, false).is_err(), "{bad}");
    }
    assert_eq!(payload("Zg==", false).unwrap(), b"f");
    assert!(payload(&STANDARD.encode(vec![0; MAX_CHUNK]), false).is_ok());
    assert!(payload(&STANDARD.encode(vec![0; MAX_CHUNK + 1]), false).is_err());
    for bad in [
        "",
        "/a",
        "a/",
        "a//b",
        ".",
        "..",
        "a/../b",
        ".canaveral/a",
        "a\\b",
        "a\0b",
    ] {
        assert!(path(bad).is_err(), "{bad}");
    }
    for good in ["a", "é/b", "a/.canaveral", ".canaveral-other"] {
        path(good).unwrap();
    }
}
#[test]
fn accounting_half_close_and_flow_retirement() {
    let mut budget = Budget::default();
    let mut flows = Flows::default();
    flows.open(id(1)).unwrap();
    assert!(flows.direction(id(1), Sender::Guest).is_err());
    flows.opened(id(1)).unwrap();
    let d = flows.direction(id(1), Sender::Guest).unwrap();
    assert!(d.receive(0, 1).is_err());
    d.grant(MAX_CREDIT, &mut budget).unwrap();
    assert!(d.grant(1, &mut budget).is_err());
    assert!(d.receive(1, 1).is_err());
    d.receive(0, MAX_CHUNK as u64).unwrap();
    d.half_close(&mut budget).unwrap();
    assert!(!d.drained());
    assert!(d.receive(1, 1).is_err());
    d.consumed(MAX_CHUNK as u64, &mut budget).unwrap();
    assert!(d.drained());
    assert_eq!(budget.decoded, 0);
    assert!(flows.close(id(1), &mut budget).unwrap());
    assert!(!flows.close(id(1), &mut budget).unwrap());
    assert!(flows.open(id(1)).is_err());
    flows.open(id(2)).unwrap();
    assert!(flows.close(id(1), &mut budget).is_err());
    for n in 3..18 {
        flows.open(id(n)).unwrap();
    }
    assert!(flows.open(id(18)).is_err());
    budget.reserve(DECODED_BUDGET, ENCODED_BUDGET).unwrap();
    assert!(budget.reserve(1, 0).is_err());
    assert!(budget.reserve(0, 1).is_err());
    budget.release(DECODED_BUDGET, ENCODED_BUDGET).unwrap();
    assert!(budget.release(1, 0).is_err());
}
#[test]
fn transfer_replays_do_not_extend_deadline_or_repeat_work() {
    let mut r = Replay::default();
    assert!(matches!(
        r.begin(
            id(1),
            1,
            Request::BeginDownload { path: "a".into() },
            10,
            100
        )
        .unwrap(),
        Step::Execute
    ));
    assert!(r
        .begin(
            id(1),
            1,
            Request::BeginDownload { path: "a".into() },
            100,
            100
        )
        .is_err());
    r.complete(Receipt::Reading {
        offset: 0,
        bytes: Some(1),
        data: None,
    })
    .unwrap();
    assert!(matches!(
        r.begin(
            id(1),
            1,
            Request::BeginDownload { path: "a".into() },
            100,
            105
        )
        .unwrap(),
        Step::Replay(_)
    ));
    assert!(!r.permits(110));
    assert!(r
        .begin(
            id(1),
            2,
            Request::Read {
                offset: 0,
                max_bytes: 1
            },
            10,
            111
        )
        .is_err());
    assert!(r
        .begin(
            id(1),
            1,
            Request::BeginDownload { path: "b".into() },
            10,
            111
        )
        .is_err());
}
#[test]
fn cursor_hash_empty_and_multistep_streams() {
    use sha2::{Digest, Sha256};
    for bytes in [vec![], vec![7; 131072]] {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let mut upload = Cursor::default();
        let begin = Request::BeginUpload {
            path: "a".into(),
            bytes: bytes.len() as u64,
            sha256: hash.clone(),
            replace: false,
        };
        upload
            .receipt(&begin, &Receipt::Writing { offset: 0 })
            .unwrap();
        for (i, chunk) in bytes.chunks(MAX_CHUNK).enumerate() {
            let offset = (i * MAX_CHUNK) as u64;
            assert!(upload
                .request(&Request::Write {
                    offset: offset + 1,
                    data: STANDARD.encode(chunk)
                })
                .is_err());
            upload
                .receipt(
                    &Request::Write {
                        offset,
                        data: STANDARD.encode(chunk),
                    },
                    &Receipt::Writing {
                        offset: offset + chunk.len() as u64,
                    },
                )
                .unwrap();
        }
        assert!(upload
            .request(&Request::Finish {
                bytes: bytes.len() as u64,
                sha256: "0".repeat(64)
            })
            .is_err());
        upload
            .receipt(
                &Request::Finish {
                    bytes: bytes.len() as u64,
                    sha256: hash.clone(),
                },
                &Receipt::Committed {
                    bytes: bytes.len() as u64,
                    sha256: hash.clone(),
                    durable: true,
                },
            )
            .unwrap();
        assert!(upload.request(&Request::Abort).is_err());
        let mut download = Cursor::default();
        download
            .receipt(
                &Request::BeginDownload { path: "a".into() },
                &Receipt::Reading {
                    offset: 0,
                    bytes: Some(bytes.len() as u64),
                    data: None,
                },
            )
            .unwrap();
        if !bytes.is_empty() {
            assert!(download
                .receipt(
                    &Request::Read {
                        offset: 0,
                        max_bytes: 1
                    },
                    &Receipt::Reading {
                        offset: 0,
                        bytes: None,
                        data: Some("".into())
                    }
                )
                .is_err());
        }
        for (i, chunk) in bytes.chunks(MAX_CHUNK).enumerate() {
            let offset = (i * MAX_CHUNK) as u64;
            download
                .receipt(
                    &Request::Read {
                        offset,
                        max_bytes: MAX_CHUNK as u64,
                    },
                    &Receipt::Reading {
                        offset: offset + chunk.len() as u64,
                        bytes: None,
                        data: Some(STANDARD.encode(chunk)),
                    },
                )
                .unwrap();
        }
        download
            .receipt(
                &Request::Finish {
                    bytes: bytes.len() as u64,
                    sha256: hash.clone(),
                },
                &Receipt::Verified {
                    bytes: bytes.len() as u64,
                    sha256: hash,
                },
            )
            .unwrap();
    }
}
