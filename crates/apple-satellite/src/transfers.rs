//! Serialized, durable data lane. Only a fresh in-process handoff may execute.
use crate::{guest, random_uuid, Lease, Result};
use canaveral_guest_protocol::data::{Frame, Receipt, Request};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Work {
    pub id: Uuid,
    pub lease_id: Uuid,
    pub member_id: Uuid,
    pub assignment_id: Uuid,
    pub boot_attempt: Uuid,
    pub bundle_digest: String,
    pub step: u64,
    pub request: Option<Request>,
    pub start_before: f64,
    pub deadline_at: f64,
    pub state: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Poll {
    pub transfer: Option<Work>,
    pub lease: Lease,
    pub cancel_requested: bool,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lane {
    pub poll_id: Option<Uuid>,
    pub current: Option<Step>,
    #[serde(default)]
    pub blocked: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub work: Work,
    pub deadline: f64,
    pub handed_off: bool,
    pub receipt: Option<Receipt>,
    pub acknowledged: bool,
    pub cancel_sent: bool,
}
impl Lane {
    pub fn poll_id(&mut self) -> Result<Uuid> {
        if self.poll_id.is_none() {
            self.poll_id = Some(random_uuid()?);
        }
        self.poll_id.ok_or("missing transfer poll identity")
    }
    pub fn receive(
        &mut self,
        work: Work,
        sent: f64,
        controller_now: f64,
        now: f64,
        lease_deadline: f64,
    ) -> Result<Option<Frame>> {
        if let Some(step) = &self.current {
            if step.work.id == work.id && step.work.step == work.step {
                if work.state == "queued"
                    && (step.work.request != work.request
                        || step.work.deadline_at != work.deadline_at
                        || step.work.start_before != work.start_before)
                {
                    return Err("changed pinned transfer work");
                }
                self.blocked |= work.state == "unknown";
                return Ok(None); // Pinned poll replay, never a second guest handoff.
            }
            if !step.acknowledged || self.blocked {
                return Err("transfer lane unresolved");
            }
        }
        if work.state != "queued" {
            self.blocked = work.state == "unknown";
            return Ok(None);
        }
        if !sent.is_finite()
            || !now.is_finite()
            || now < sent
            || !controller_now.is_finite()
            || !work.deadline_at.is_finite()
            || !work.start_before.is_finite()
            || work.id.is_nil()
            || work.step == 0
            || work.step > canaveral_guest_protocol::MAX_SAFE
        {
            return Err("invalid transfer timing/identity");
        }
        let deadline = (sent + work.deadline_at - controller_now).min(lease_deadline);
        let remaining = guest::remaining_ms(deadline, now);
        let request = work
            .request
            .clone()
            .ok_or("queued transfer missing request")?;
        let frame = remaining
            .ok()
            .filter(|_| sent + work.start_before - controller_now > now)
            .map(|remaining_ms| Frame::TransferRequest {
                version: 1,
                id: work.id,
                step: work.step,
                request,
                remaining_ms,
            });
        if let Some(f) = &frame {
            f.validate(canaveral_guest_protocol::data::Sender::Host)
                .map_err(|_| "invalid transfer request")?;
        }
        self.current = Some(Step {
            work,
            deadline,
            handed_off: false,
            receipt: frame.is_none().then(|| Receipt::Failed {
                code: "deadline".into(),
            }),
            acknowledged: false,
            cancel_sent: false,
        });
        Ok(frame)
    }
    pub fn loss(&mut self, code: &str) {
        if let Some(step) = self.current.as_mut().filter(|s| s.receipt.is_none()) {
            step.receipt = Some(if step.handed_off {
                self.blocked = true;
                Receipt::Unknown { code: code.into() }
            } else {
                Receipt::Failed { code: code.into() }
            });
        }
    }
    pub fn recover(&mut self) {
        self.loss("transport_unknown");
    }
    pub fn event(&mut self, frame: Frame) -> Result<()> {
        let step = self
            .current
            .as_mut()
            .ok_or("unsolicited transfer receipt")?;
        match frame {
            Frame::TransferReceipt {
                id,
                step: n,
                receipt,
                ..
            } if step.work.id == id && step.work.step == n && step.handed_off => {
                receipt
                    .validate()
                    .map_err(|_| "invalid guest transfer receipt")?;
                if let Some(old) = &step.receipt {
                    // A locally declared unknown remains first-terminal-wins.
                    if !matches!(old, Receipt::Unknown { .. }) && old != &receipt {
                        return Err("changed transfer receipt");
                    }
                } else {
                    self.blocked |= matches!(receipt, Receipt::Unknown { .. });
                    step.receipt = Some(receipt);
                }
                Ok(())
            }
            _ => Err("transfer receipt owner mismatch"),
        }
    }
    pub fn report(&self, mut owner: Value) -> Result<Value> {
        let step = self.current.as_ref().ok_or("missing transfer")?;
        owner["transferId"] = json!(step.work.id);
        owner["step"] = json!(step.work.step);
        owner["receipt"] =
            serde_json::to_value(step.receipt.as_ref().ok_or("missing transfer receipt")?)
                .map_err(|_| "invalid transfer receipt")?;
        Ok(owner)
    }
    pub fn acknowledge(&mut self, reply: Value) -> Result<()> {
        let step = self.current.as_mut().ok_or("missing transfer")?;
        if reply["transferId"] != json!(step.work.id)
            || reply["step"] != json!(step.work.step)
            || !matches!(
                reply["state"].as_str(),
                Some("succeeded" | "failed" | "unknown")
            )
        {
            return Err("transfer acknowledgment mismatch");
        }
        let receipt = step.receipt.as_ref().ok_or("missing transfer receipt")?;
        let expected = match receipt {
            Receipt::Failed { .. } => "failed",
            Receipt::Unknown { .. } => "unknown",
            _ => "succeeded",
        };
        if reply["state"] != expected && reply["state"] != "unknown" {
            return Err("transfer outcome mismatch");
        }
        self.blocked |= reply["state"] == "unknown";
        step.acknowledged = true;
        self.poll_id = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn work(request: Request, step: u64) -> Work {
        Work {
            id: Uuid::from_u128(1),
            lease_id: Uuid::from_u128(2),
            member_id: Uuid::from_u128(3),
            assignment_id: Uuid::from_u128(4),
            boot_attempt: Uuid::from_u128(5),
            bundle_digest: "a".repeat(64),
            step,
            request: Some(request),
            start_before: 1120.0,
            deadline_at: 1120.0,
            state: "queued".into(),
        }
    }
    fn receive(lane: &mut Lane, request: Request, step: u64) -> Frame {
        lane.receive(work(request, step), 100.0, 1000.0, 110.0, 400.0)
            .unwrap()
            .unwrap()
    }
    fn receipt(lane: &mut Lane, receipt: Receipt) {
        let step = lane.current.as_mut().unwrap();
        step.handed_off = true;
        let id = step.work.id;
        let n = step.work.step;
        lane.event(Frame::TransferReceipt {
            version: 1,
            id,
            step: n,
            receipt,
        })
        .unwrap();
    }
    fn ack(lane: &mut Lane) {
        let body = lane.report(json!({})).unwrap();
        let state = match body["receipt"]["state"].as_str().unwrap() {
            "failed" => "failed",
            "unknown" => "unknown",
            _ => "succeeded",
        };
        lane.acknowledge(
            json!({"transferId":body["transferId"],"step":body["step"],"state":state}),
        )
        .unwrap();
    }
    #[test]
    fn upload_download_steps_poll_pinning_and_exact_lost_report_replay() {
        for download in [false, true] {
            let mut lane = Lane::default();
            let poll = lane.poll_id().unwrap();
            let mut recovered: Lane =
                serde_json::from_slice(&serde_json::to_vec(&lane).unwrap()).unwrap();
            assert_eq!(recovered.poll_id().unwrap(), poll);
            let sha =
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string();
            let requests = if download {
                vec![
                    (
                        Request::BeginDownload {
                            path: "file".into(),
                        },
                        Receipt::Reading {
                            offset: 0,
                            bytes: Some(3),
                            data: None,
                        },
                    ),
                    (
                        Request::Read {
                            offset: 0,
                            max_bytes: 65536,
                        },
                        Receipt::Reading {
                            offset: 3,
                            bytes: None,
                            data: Some("YWJj".into()),
                        },
                    ),
                    (
                        Request::Finish {
                            bytes: 3,
                            sha256: sha.clone(),
                        },
                        Receipt::Verified {
                            bytes: 3,
                            sha256: sha,
                        },
                    ),
                ]
            } else {
                vec![
                    (
                        Request::BeginUpload {
                            path: "file".into(),
                            bytes: 3,
                            sha256: sha.clone(),
                            replace: false,
                        },
                        Receipt::Writing { offset: 0 },
                    ),
                    (
                        Request::Write {
                            offset: 0,
                            data: "YWJj".into(),
                        },
                        Receipt::Writing { offset: 3 },
                    ),
                    (
                        Request::Finish {
                            bytes: 3,
                            sha256: sha.clone(),
                        },
                        Receipt::Committed {
                            bytes: 3,
                            sha256: sha,
                            durable: true,
                        },
                    ),
                ]
            };
            for (n, (request, result)) in requests.into_iter().enumerate() {
                let step = n as u64 + 1;
                let frame = receive(&mut lane, request.clone(), step);
                assert!(matches!(
                    frame,
                    Frame::TransferRequest {
                        remaining_ms: 108000,
                        ..
                    }
                ));
                assert!(lane
                    .receive(work(request, step), 100.0, 1000.0, 111.0, 400.0)
                    .unwrap()
                    .is_none());
                receipt(&mut lane, result);
                let body = lane.report(json!({"binding":"owner"})).unwrap();
                let mut restarted: Lane =
                    serde_json::from_slice(&serde_json::to_vec(&lane).unwrap()).unwrap();
                restarted.recover();
                assert_eq!(body, restarted.report(json!({"binding":"owner"})).unwrap());
                ack(&mut lane);
                assert!(lane.poll_id.is_none());
                if n == 0 {
                    assert_ne!(lane.poll_id().unwrap(), poll);
                }
            }
        }
    }
    #[test]
    fn restart_data_loss_deadline_and_controller_unknown_never_reexecute() {
        for handed_off in [false, true] {
            let mut lane = Lane::default();
            receive(&mut lane, Request::Abort, 1);
            lane.current.as_mut().unwrap().handed_off = handed_off;
            lane.loss("data_channel_lost");
            let body = lane.report(json!({})).unwrap();
            assert_eq!(
                body["receipt"]["state"],
                if handed_off { "unknown" } else { "failed" }
            );
            assert_eq!(body["receipt"]["code"], "data_channel_lost");
            let mut lane: Lane =
                serde_json::from_slice(&serde_json::to_vec(&lane).unwrap()).unwrap();
            lane.recover();
            assert_eq!(lane.report(json!({})).unwrap(), body);
            assert!(lane
                .receive(work(Request::Abort, 1), 100.0, 1000.0, 110.0, 400.0)
                .unwrap()
                .is_none());
        }
        let mut lane = Lane::default();
        receive(&mut lane, Request::Abort, 1);
        lane.current.as_mut().unwrap().handed_off = true;
        lane.recover();
        assert!(matches!(
            lane.current.as_ref().unwrap().receipt,
            Some(Receipt::Unknown { .. })
        ));
        let mut lane = Lane::default();
        assert!(lane
            .receive(work(Request::Abort, 1), 100.0, 1000.0, 219.0, 400.0)
            .unwrap()
            .is_none());
        assert!(
            matches!(&lane.current.as_ref().unwrap().receipt, Some(Receipt::Failed { code }) if code == "deadline")
        );
        let mut lane = Lane::default();
        receive(&mut lane, Request::Abort, 1);
        receipt(&mut lane, Receipt::Aborted);
        lane.acknowledge(json!({"transferId":Uuid::from_u128(1),"step":1,"state":"unknown"}))
            .unwrap();
        assert!(lane.blocked);
        assert!(lane
            .receive(work(Request::Abort, 2), 100.0, 1000.0, 110.0, 400.0)
            .is_err());
    }
    #[test]
    fn separate_controller_worker_replays_exact_body_after_lost_response() {
        use crate::{operations::Worker, Controller};
        use canaveral_runner_client::LeaseRoute;
        struct Fake {
            seen: Vec<Value>,
        }
        impl Controller for Fake {
            fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
                assert_eq!(body["assignmentId"], json!(Uuid::from_u128(4)));
                assert_eq!(body["bootAttempt"], json!(Uuid::from_u128(5)));
                assert_eq!(body["bundleDigest"], "a".repeat(64));
                self.seen.push(body.clone());
                if self.seen.len() % 2 == 1 {
                    return Err("lost response");
                }
                assert_eq!(self.seen[self.seen.len() - 2], body);
                match route {
                    LeaseRoute::TransferPoll => {
                        assert_eq!(body.as_object().unwrap().len(), 5);
                        assert!(body["pollId"].is_string());
                        Ok(
                            json!({"transfer":work(Request::Abort,1), "lease":{"state":"ready","revision":1,"expiresAt":1300.0,"controllerNow":1000.0},"cancelRequested":false}),
                        )
                    }
                    LeaseRoute::TransferReport => {
                        assert_eq!(body.as_object().unwrap().len(), 7);
                        assert_eq!(body["receipt"], json!({"state":"aborted"}));
                        Ok(
                            json!({"transferId":body["transferId"],"step":body["step"],"state":"succeeded"}),
                        )
                    }
                    _ => panic!("unexpected route"),
                }
            }
        }
        let mut fake = Fake { seen: Vec::new() };
        let owner = json!({"binding":{"controllerId":Uuid::from_u128(10),"runnerId":Uuid::from_u128(11),"generation":1,"incarnationId":Uuid::from_u128(12)},"assignmentId":Uuid::from_u128(4),"bootAttempt":Uuid::from_u128(5),"bundleDigest":"a".repeat(64)});
        let mut lane = Lane::default();
        let mut poll_body = owner.clone();
        poll_body["pollId"] = json!(lane.poll_id().unwrap());
        std::thread::scope(|scope| {
            let worker = Worker::spawn(scope, &mut fake);
            worker
                .send
                .send((LeaseRoute::TransferPoll, poll_body.clone()))
                .unwrap();
            assert!(worker.recv.recv().unwrap().2.is_err());
            worker
                .send
                .send((LeaseRoute::TransferPoll, poll_body))
                .unwrap();
            let response: Poll =
                serde_json::from_value(worker.recv.recv().unwrap().2.unwrap()).unwrap();
            assert!(lane
                .receive(
                    response.transfer.unwrap(),
                    100.0,
                    response.lease.controller_now,
                    110.0,
                    400.0
                )
                .unwrap()
                .is_some());
            receipt(&mut lane, Receipt::Aborted);
            let report = lane.report(owner).unwrap();
            worker
                .send
                .send((LeaseRoute::TransferReport, report.clone()))
                .unwrap();
            assert!(worker.recv.recv().unwrap().2.is_err());
            worker
                .send
                .send((LeaseRoute::TransferReport, report))
                .unwrap();
            lane.acknowledge(worker.recv.recv().unwrap().2.unwrap())
                .unwrap();
        });
        assert!(lane.current.unwrap().acknowledged);
        assert_eq!(fake.seen.len(), 4);
    }
}
