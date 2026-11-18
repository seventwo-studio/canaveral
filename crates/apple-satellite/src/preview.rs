use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Dispatch {
    id: Uuid,
    operation_id: Uuid,
    lease_id: Uuid,
    member_id: Uuid,
    assignment_id: Uuid,
    boot_attempt: Uuid,
    bundle_digest: String,
    method: String,
    target: String,
    expires_at: f64,
}

impl Dispatch {
    fn matches(&self, c: &operations::Command) -> bool {
        !self.id.is_nil()
            && self.operation_id == c.id
            && self.lease_id == c.lease_id
            && self.member_id == c.member_id
            && self.assignment_id == c.assignment_id
            && self.boot_attempt == c.boot_attempt
            && self.bundle_digest == c.bundle_digest
    }
}

#[derive(Default)]
pub(super) struct Loop {
    inflight: bool,
    polled: Option<clock::Clock>,
    reply: Option<(Value, reactor::PreviewReply)>,
}

impl Loop {
    pub(super) fn tick(
        &mut self,
        sat: &Satellite,
        session: Option<&guest::Session>,
        data: &data::Lane,
        worker: &operations::Worker,
    ) -> Result<()> {
        let active = sat
            .state
            .operations
            .current
            .as_ref()
            .filter(|o| sat.preview_ready && !o.cancel_sent && o.receipt.is_none());
        let live = active.and_then(|op| {
            let s = session?;
            let exec = op.guest_id?;
            let binding = sat
                .guest_binding(sat.state.direct.as_ref()?.revision)
                .ok()?;
            s.preview_authority(&binding, &binding.bundle_digest, exec)
                .ok()?;
            Some((&op.command, s, exec))
        });
        if self.inflight {
            let Ok((route, sent, result)) = worker.recv.try_recv() else {
                return Ok(());
            };
            self.inflight = false;
            if let (LeaseRoute::PreviewPoll, Ok(body), Some((command, s, exec))) =
                (route, result, live)
            {
                if let (Some(now), Ok(d)) = (
                    body["controllerNow"].as_f64(),
                    serde_json::from_value::<Dispatch>(body["dispatch"].clone()),
                ) {
                    if d.matches(command) {
                        let mut report = sat.operation_binding()?;
                        report["operationId"] = json!(command.id);
                        report["dispatchId"] = json!(d.id);
                        let deadline =
                            Duration::try_from_secs_f64(sent + (d.expires_at - now).min(1.0)).ok();
                        let request = deadline.filter(|t| *t > clock::now()).and_then(|t| {
                            data.preview_request(s, exec, &d.method, &d.target, t).ok()
                        });
                        if let Some(reply) = request {
                            self.reply = Some((report, reply));
                        } else {
                            report["responseBase64"] = Value::Null;
                            return self.send(worker, LeaseRoute::PreviewReport, report);
                        }
                    }
                }
            }
        }
        if let Some((report, reply)) = &self.reply {
            let bytes = if live.is_some_and(|(c, _, _)| report["operationId"] == json!(c.id)) {
                reply.poll()
            } else {
                Err("preview revoked")
            };
            if matches!(bytes, Ok(None)) {
                return Ok(());
            }
            let mut body = report.clone();
            body["responseBase64"] = json!(bytes.ok().flatten().map(|b| STANDARD.encode(b)));
            self.reply = None;
            return self.send(worker, LeaseRoute::PreviewReport, body);
        }
        if let Some((command, _, _)) = live {
            if self
                .polled
                .is_none_or(|p| p.elapsed() >= Duration::from_millis(100))
            {
                let mut body = sat.operation_binding()?;
                body["operationId"] = json!(command.id);
                self.polled = Some(clock::Clock::now());
                self.send(worker, LeaseRoute::PreviewPoll, body)?;
            }
        }
        Ok(())
    }
    fn send(&mut self, worker: &operations::Worker, route: LeaseRoute, body: Value) -> Result<()> {
        worker
            .send
            .try_send((route, body))
            .map_err(|_| "preview worker stopped")?;
        self.inflight = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_must_match_every_part_of_live_command_binding() {
        let command: operations::Command = serde_json::from_value(json!({
            "id":Uuid::from_u128(1), "leaseId":Uuid::from_u128(2),
            "memberId":Uuid::from_u128(3), "assignmentId":Uuid::from_u128(4),
            "bootAttempt":Uuid::from_u128(5), "bundleDigest":"a".repeat(64),
            "arguments":{"argv":["preview"]},"startBefore":20.0,"timeoutMs":30000,"state":"queued"
        }))
        .unwrap();
        let valid = json!({"id":Uuid::from_u128(6),"operationId":command.id,
            "leaseId":command.lease_id,"memberId":command.member_id,
            "assignmentId":command.assignment_id,"bootAttempt":command.boot_attempt,
            "bundleDigest":command.bundle_digest,"method":"GET","target":"/","expiresAt":10.0});
        assert!(serde_json::from_value::<Dispatch>(valid.clone())
            .unwrap()
            .matches(&command));
        for field in [
            "id",
            "operationId",
            "leaseId",
            "memberId",
            "assignmentId",
            "bootAttempt",
            "bundleDigest",
        ] {
            let mut stale = valid.clone();
            stale[field] = json!(Uuid::nil());
            assert!(
                !serde_json::from_value::<Dispatch>(stale)
                    .unwrap()
                    .matches(&command),
                "{field}"
            );
        }
    }
}
