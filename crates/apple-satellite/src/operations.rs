//! Durable single-command lane. Received intent is never executed again after recovery.
use crate::{guest, random_uuid, Controller, Lease, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use canaveral_guest_protocol::{Guest, MAX_SAFE};
use canaveral_runner_client::LeaseRoute;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, SyncSender};
use uuid::Uuid;
pub const CAPTURE: usize = 262144;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub id: Uuid,
    pub lease_id: Uuid,
    pub member_id: Uuid,
    pub assignment_id: Uuid,
    pub boot_attempt: Uuid,
    pub bundle_digest: String,
    pub arguments: Arguments,
    pub start_before: f64,
    pub timeout_ms: u64,
    pub state: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Arguments {
    pub argv: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Poll {
    pub command: Option<Command>,
    pub lease: Lease,
    pub cancel_requested: bool,
    #[serde(default)]
    pub stop_requested: bool,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lane {
    pub poll_id: Option<Uuid>,
    pub current: Option<Operation>,
    /// Older journals retained UUIDs inline. Migrated to descriptor-relative history on open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed: Vec<Uuid>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub command: Command,
    pub guest_id: Option<Uuid>,
    pub receipt: Option<Value>,
    pub acknowledged: bool,
    pub deadline: f64,
    #[serde(default)]
    pub cancel_sent: bool,
    seq: u64,
    counts: [u64; 2],
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
impl Lane {
    pub fn poll_id(&mut self) -> Result<Uuid> {
        if self.poll_id.is_none() {
            self.poll_id = Some(random_uuid()?);
        }
        self.poll_id.ok_or("missing poll identity")
    }
    pub fn receive(&mut self, c: Command, deadline: f64) -> Result<bool> {
        if let Some(op) = &self.current {
            if op.command.id == c.id {
                return Ok(false);
            }
            if !op.acknowledged || op.receipt.as_ref().is_none_or(|r| r["state"] == "unknown") {
                return Err("operation lane unresolved");
            }
        }
        if self.completed.contains(&c.id) {
            return Err("operation replay");
        }
        self.current = Some(Operation {
            command: c,
            guest_id: None,
            receipt: None,
            acknowledged: false,
            deadline,
            cancel_sent: false,
            seq: 0,
            counts: [0, 0],
            stdout: Vec::new(),
            stderr: Vec::new(),
        });
        Ok(true)
    }
    pub fn validate_acknowledgment(&self, reply: &Value) -> Result<()> {
        let op = self.current.as_ref().ok_or("missing operation")?;
        op.receipt.as_ref().ok_or("missing operation receipt")?;
        if reply["operationId"] != json!(op.command.id)
            || !matches!(
                reply["state"].as_str(),
                Some("succeeded" | "failed" | "unknown")
            )
        {
            return Err("operation acknowledgment mismatch");
        }
        // First-terminal-wins can precede cancellation delivery. Local receipt evidence
        // remains intact so an uncertain guest termination still fences the lease.
        Ok(())
    }
    pub fn acknowledge(&mut self, reply: Value) -> Result<()> {
        self.validate_acknowledgment(&reply)?;
        let op = self.current.as_mut().ok_or("missing operation")?;
        op.acknowledged = true;
        self.poll_id = None;
        Ok(())
    }
}
impl Operation {
    pub fn unknown(&mut self) {
        if self.receipt.is_none() {
            self.receipt = Some(json!({"state":"unknown"}));
        }
    }
    pub fn event(&mut self, event: Guest, session: &mut guest::Session) -> Result<()> {
        if self.receipt.is_some() {
            return Err("event after terminal operation");
        }
        match event {
            Guest::Output {
                id,
                stream,
                seq,
                data,
                ..
            } => {
                if self.guest_id != Some(id) || seq != self.seq {
                    return Err("operation output sequence mismatch");
                }
                let bytes = STANDARD
                    .decode(&data)
                    .map_err(|_| "invalid operation output")?;
                if STANDARD.encode(&bytes) != data || bytes.is_empty() || bytes.len() > 65536 {
                    return Err("invalid operation output encoding");
                }
                self.seq = self.seq.checked_add(1).ok_or("output sequence overflow")?;
                let index = usize::from(stream == "stderr");
                self.counts[index] = self.counts[index]
                    .checked_add(bytes.len() as u64)
                    .filter(|n| *n <= MAX_SAFE)
                    .ok_or("output count overflow")?;
                let keep = bytes
                    .len()
                    .min(CAPTURE - self.stdout.len() - self.stderr.len());
                if index == 0 {
                    self.stdout.extend_from_slice(&bytes[..keep]);
                } else {
                    self.stderr.extend_from_slice(&bytes[..keep]);
                }
                session.credit(bytes.len() as u64)?;
            }
            Guest::SpawnFailed { id, .. } if self.guest_id == Some(id) => {
                self.receipt = Some(json!({"state":"failed"}));
            }
            Guest::Exit {
                id,
                status,
                signal,
                timed_out,
                duration_ms,
                stdout_bytes,
                stderr_bytes,
                termination_confirmed,
                ..
            } if self.guest_id == Some(id) => {
                if [stdout_bytes, stderr_bytes] != self.counts || duration_ms > MAX_SAFE {
                    return Err("operation exit counts mismatch");
                }
                if !termination_confirmed || (status.is_none() && signal.is_none() && !timed_out) {
                    self.unknown();
                } else {
                    let success = status == Some(0) && signal.is_none() && !timed_out;
                    self.receipt = Some(
                        json!({"state":if success {"succeeded"} else {"failed"},"result":{
                        "stdoutBase64":STANDARD.encode(&self.stdout),"stderrBase64":STANDARD.encode(&self.stderr),
                        "exitCode":status,"signal":signal,"timedOut":timed_out,"durationMs":duration_ms,
                        "stdoutBytes":stdout_bytes,"stderrBytes":stderr_bytes,
                        "truncated":stdout_bytes+stderr_bytes>(self.stdout.len()+self.stderr.len()) as u64,
                        "terminationConfirmed":true}}),
                    );
                }
            }
            _ => return Err("unexpected operation event"),
        }
        Ok(())
    }
}
/// Capacity one each way; the caller permits only one in-flight request. Credentials stay
/// borrowed from the locked identity until this scoped worker has joined.
pub struct Worker {
    pub send: SyncSender<(LeaseRoute, Value)>,
    pub recv: Receiver<(LeaseRoute, f64, Result<Value>)>,
}
impl Worker {
    pub fn spawn<'scope, 'env: 'scope>(
        scope: &'scope std::thread::Scope<'scope, 'env>,
        controller: &'scope mut (impl Controller + Send),
    ) -> Self {
        let (send, requests) = mpsc::sync_channel::<(LeaseRoute, Value)>(1);
        let (responses, recv) = mpsc::sync_channel(1);
        scope.spawn(move || {
            while let Ok((route, body)) = requests.recv() {
                let start = crate::clock::now().as_secs_f64();
                let reply = controller.request(route, body);
                if responses.send((route, start, reply)).is_err() {
                    break;
                }
            }
        });
        Self { send, recv }
    }
}
