//! Independent data protocol. Errors here carry no control-session authority.
use crate::{Binding, Result, MAX_SAFE};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub const MAX_FRAME: usize = 131072;
pub const MAX_CHUNK: usize = 65536;
pub const MAX_CREDIT: u64 = 262144;
pub const DECODED_BUDGET: u64 = 4 * 1024 * 1024;
pub const ENCODED_BUDGET: usize = 8 * 1024 * 1024;
pub fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn payload(s: &str, empty: bool) -> Result<Vec<u8>> {
    if s.len() > MAX_CHUNK.div_ceil(3) * 4 {
        return Err("payload limit".into());
    }
    let b = STANDARD.decode(s)?;
    if b.len() > MAX_CHUNK || (!empty && b.is_empty()) || STANDARD.encode(&b) != s {
        return Err("noncanonical payload".into());
    }
    Ok(b)
}
pub fn path(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 4096
        || s.contains(['\0', '\\'])
        || s.split('/').any(|c| c.is_empty() || c == "." || c == "..")
        || s.split('/').next() == Some(".canaveral")
    {
        return Err("invalid workspace path".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    BeginUpload {
        path: String,
        bytes: u64,
        sha256: String,
        replace: bool,
    },
    BeginDownload {
        path: String,
    },
    Write {
        offset: u64,
        data: String,
    },
    Read {
        offset: u64,
        #[serde(rename = "maxBytes")]
        max_bytes: u64,
    },
    Finish {
        bytes: u64,
        sha256: String,
    },
    Abort,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::BeginUpload {
                path: p,
                bytes,
                sha256,
                ..
            } => {
                path(p)?;
                size(*bytes)?;
                hash(sha256)?;
            }
            Self::BeginDownload { path: p } => path(p)?,
            Self::Write { offset, data } => {
                size(*offset)?;
                payload(data, false)?;
            }
            Self::Read { offset, max_bytes } => {
                size(*offset)?;
                if !(1..=MAX_CHUNK as u64).contains(max_bytes) {
                    return Err("read limit".into());
                }
            }
            Self::Finish { bytes, sha256 } => {
                size(*bytes)?;
                hash(sha256)?;
            }
            Self::Abort => (),
        }
        Ok(())
    }
}
fn size(n: u64) -> Result<()> {
    if n > MAX_SAFE {
        Err("unsafe integer".into())
    } else {
        Ok(())
    }
}
fn hash(s: &str) -> Result<()> {
    if !lower_hex(s, 64) {
        Err("invalid hash".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub enum Receipt {
    Writing {
        offset: u64,
    },
    Reading {
        offset: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
    },
    Committed {
        bytes: u64,
        sha256: String,
        durable: bool,
    },
    Verified {
        bytes: u64,
        sha256: String,
    },
    Aborted,
    Failed {
        code: String,
    },
    Unknown {
        code: String,
    },
}
impl Receipt {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Writing { offset } => size(*offset)?,
            Self::Reading {
                offset,
                bytes,
                data,
            } => {
                size(*offset)?;
                match (bytes, data) {
                    (Some(b), None) if *offset == 0 => size(*b)?,
                    (None, Some(d)) => {
                        payload(d, true)?;
                    }
                    _ => return Err("invalid read receipt".into()),
                }
            }
            Self::Committed {
                bytes,
                sha256,
                durable,
            } => {
                size(*bytes)?;
                hash(sha256)?;
                if !durable {
                    return Err("commit must be durable".into());
                }
            }
            Self::Verified { bytes, sha256 } => {
                size(*bytes)?;
                hash(sha256)?;
            }
            Self::Failed { code } => {
                if !matches!(
                    code.as_str(),
                    "not_found"
                        | "path_denied"
                        | "not_regular"
                        | "hardlink_denied"
                        | "destination_exists"
                        | "disk_full"
                        | "size_mismatch"
                        | "digest_mismatch"
                        | "source_changed"
                        | "io_error"
                        | "deadline"
                        | "authorization_lost"
                        | "controller_restarted"
                        | "data_channel_lost"
                ) {
                    return Err("invalid failed code".into());
                }
            }
            Self::Unknown { code } => {
                if !matches!(
                    code.as_str(),
                    "publication_unknown" | "transport_unknown" | "deadline"
                ) {
                    return Err("invalid unknown code".into());
                }
            }
            Self::Aborted => (),
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidTarget,
    PortDenied,
    EgressDenied,
    DestinationDenied,
    RouteDenied,
    ConnectFailed,
    ConnectTimeout,
    IdleTimeout,
    Limit,
}
impl ErrorCode {
    pub fn http_status(self) -> u16 {
        match self {
            Self::InvalidTarget => 400,
            Self::PortDenied | Self::EgressDenied | Self::DestinationDenied | Self::RouteDenied => {
                403
            }
            Self::Limit => 503,
            Self::ConnectTimeout => 504,
            _ => 502,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    AuthorizationLost,
    Deadline,
    Stop,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Frame {
    DataHello {
        version: u32,
        binding: Binding,
        nonce: String,
    },
    DataReady {
        version: u32,
        binding: Binding,
        nonce: String,
    },
    Open {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        host: String,
        port: u16,
    },
    Opened {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
    },
    Data {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        seq: u64,
        data: String,
    },
    Credit {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        bytes: u64,
    },
    HalfClose {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
    },
    Close {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
    },
    Error {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        code: ErrorCode,
    },
    TransferRequest {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        step: u64,
        request: Request,
        #[serde(rename = "remainingMs")]
        remaining_ms: u64,
    },
    TransferCancel {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        reason: CancelReason,
    },
    TransferReceipt {
        version: u32,
        #[serde(deserialize_with = "crate::uuid")]
        id: Uuid,
        step: u64,
        receipt: Receipt,
    },
}
#[derive(Clone, Copy)]
pub enum Sender {
    Host,
    Guest,
}
impl Frame {
    pub fn validate(&self, sender: Sender) -> Result<()> {
        let id = match self {
            Self::DataHello { .. } | Self::DataReady { .. } => None,
            Self::Open { id, .. }
            | Self::Opened { id, .. }
            | Self::Data { id, .. }
            | Self::Credit { id, .. }
            | Self::HalfClose { id, .. }
            | Self::Close { id, .. }
            | Self::Error { id, .. }
            | Self::TransferRequest { id, .. }
            | Self::TransferCancel { id, .. }
            | Self::TransferReceipt { id, .. } => Some(id),
        };
        if id.is_some_and(Uuid::is_nil) {
            return Err("nil data ID".into());
        }
        let host = matches!(sender, Sender::Host);

        let version = match self {
            Self::DataHello {
                version,
                binding,
                nonce,
            }
            | Self::DataReady {
                version,
                binding,
                nonce,
            } => {
                binding.validate()?;
                if !lower_hex(nonce, 64) || host != matches!(self, Self::DataHello { .. }) {
                    return Err("invalid data handshake".into());
                }
                *version
            }
            Self::Open { version, .. } => {
                if host {
                    return Err("invalid open direction".into());
                }
                *version
            }
            Self::Opened { version, .. } | Self::Error { version, .. } => {
                if !host {
                    return Err("invalid direction".into());
                }
                *version
            }
            Self::Data {
                version, seq, data, ..
            } => {
                size(*seq)?;
                payload(data, false)?;
                *version
            }
            Self::Credit { version, bytes, .. } => {
                if !(1..=MAX_CREDIT).contains(bytes) {
                    return Err("invalid flow credit".into());
                }
                *version
            }
            Self::HalfClose { version, .. } | Self::Close { version, .. } => *version,
            Self::TransferRequest {
                version,
                step,
                request,
                remaining_ms,
                ..
            } => {
                if !host
                    || *step == 0
                    || *step > MAX_SAFE
                    || *remaining_ms == 0
                    || *remaining_ms > MAX_SAFE
                {
                    return Err("invalid transfer authority".into());
                }
                request.validate()?;
                *version
            }
            Self::TransferCancel { version, .. } => {
                if !host {
                    return Err("invalid cancel direction".into());
                }
                *version
            }
            Self::TransferReceipt {
                version,
                step,
                receipt,
                ..
            } => {
                if host || *step == 0 || *step > MAX_SAFE {
                    return Err("invalid receipt direction/step".into());
                }
                receipt.validate()?;
                *version
            }
        };
        if version != 1 {
            return Err("unsupported data protocol".into());
        }
        Ok(())
    }
}
/// A poisoned parser cannot be reused after a protocol error. Feed no more than needed().
#[derive(Default)]
pub struct Decoder {
    prefix: Vec<u8>,
    body: Vec<u8>,
    length: Option<usize>,
    closed: bool,
}
impl Decoder {
    pub fn needed(&self) -> usize {
        self.length
            .map_or(4 - self.prefix.len(), |n| n - self.body.len())
    }
    pub fn feed(&mut self, input: &[u8], sender: Sender) -> Result<Option<Frame>> {
        if self.closed {
            return Err("data closed".into());
        }
        let result = self.feed_inner(input, sender);
        if result.is_err() {
            self.closed = true;
            self.prefix.clear();
            self.body.clear();
        }
        result
    }
    fn feed_inner(&mut self, input: &[u8], sender: Sender) -> Result<Option<Frame>> {
        if input.len() > self.needed() {
            return Err("data parser overfeed".into());
        }
        if self.length.is_none() {
            self.prefix.extend_from_slice(input);
            if self.prefix.len() == 4 {
                let n = u32::from_be_bytes(self.prefix[..].try_into()?) as usize;
                if n == 0 || n > MAX_FRAME {
                    return Err("data frame limit".into());
                }
                self.length = Some(n);
            }
            return Ok(None);
        }
        self.body.extend_from_slice(input);
        if self.body.len() != self.length.unwrap() {
            return Ok(None);
        }
        let frame: Frame = serde_json::from_slice(&self.body)?;
        frame.validate(sender)?;
        self.prefix.clear();
        self.body.clear();
        self.length = None;
        Ok(Some(frame))
    }
}
pub fn encode(frame: &Frame, sender: Sender) -> Result<Vec<u8>> {
    frame.validate(sender)?;
    let body = serde_json::to_vec(frame)?;
    if body.len() > MAX_FRAME {
        return Err("data frame limit".into());
    }
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    Ok(out)
}

/// Endpoint-wide accounting includes received bytes and credit already promised.
#[derive(Default)]
pub struct Budget {
    decoded: u64,
    encoded: usize,
}
impl Budget {
    pub fn reserve(&mut self, decoded: u64, encoded: usize) -> Result<()> {
        let d = self.decoded.checked_add(decoded).ok_or("budget overflow")?;
        let e = self.encoded.checked_add(encoded).ok_or("budget overflow")?;
        if d > DECODED_BUDGET || e > ENCODED_BUDGET {
            return Err("data budget exhausted".into());
        }
        self.decoded = d;
        self.encoded = e;
        Ok(())
    }
    pub fn release(&mut self, decoded: u64, encoded: usize) -> Result<()> {
        let d = self
            .decoded
            .checked_sub(decoded)
            .ok_or("budget underflow")?;
        let e = self
            .encoded
            .checked_sub(encoded)
            .ok_or("budget underflow")?;
        self.decoded = d;
        self.encoded = e;
        Ok(())
    }
}
#[derive(Default)]
pub struct Direction {
    credit: u64,
    buffered: u64,
    sequence: u64,
    half_closed: bool,
}
impl Direction {
    /// Receiver grants only budget it can honor. Receiving moves credit into the buffer.
    pub fn grant(&mut self, bytes: u64, budget: &mut Budget) -> Result<()> {
        if bytes == 0 || bytes > MAX_CREDIT || self.credit + bytes > MAX_CREDIT || self.half_closed
        {
            return Err("invalid credit".into());
        }
        budget.reserve(bytes, 0)?;
        self.credit += bytes;
        Ok(())
    }
    pub fn receive(&mut self, seq: u64, bytes: u64) -> Result<()> {
        if self.half_closed
            || seq != self.sequence
            || seq > MAX_SAFE
            || bytes == 0
            || bytes > MAX_CHUNK as u64
            || bytes > self.credit
        {
            return Err("flow sequence/credit violation".into());
        }
        self.credit -= bytes;
        self.buffered += bytes;
        self.sequence += 1;
        Ok(())
    }
    pub fn consumed(&mut self, bytes: u64, budget: &mut Budget) -> Result<()> {
        if bytes > self.buffered {
            return Err("buffer underflow".into());
        }
        budget.release(bytes, 0)?;
        self.buffered -= bytes;
        Ok(())
    }
    pub fn half_close(&mut self, budget: &mut Budget) -> Result<()> {
        if self.half_closed {
            return Err("duplicate half close".into());
        }
        budget.release(self.credit, 0)?;
        self.credit = 0;
        self.half_closed = true;
        Ok(())
    }
    pub fn drained(&self) -> bool {
        self.half_closed && self.buffered == 0
    }
    fn discard(&mut self, budget: &mut Budget) -> Result<()> {
        budget.release(self.credit + self.buffered, 0)?;
        self.credit = 0;
        self.buffered = 0;
        self.half_closed = true;
        Ok(())
    }
}
pub struct Flow {
    pub directions: [Direction; 2],
    pub opened: bool,
}
/// Only proxy IDs live here. Transfer UUIDs have their own replay lane.
#[derive(Default)]
pub struct Flows {
    live: std::collections::BTreeMap<Uuid, Flow>,
    last: Uuid,
}
impl Flows {
    pub fn open(&mut self, id: Uuid) -> Result<()> {
        if id.is_nil() || id <= self.last || self.live.len() == 16 {
            return Err("invalid flow ID or limit".into());
        }
        self.last = id;
        self.live.insert(
            id,
            Flow {
                directions: Default::default(),
                opened: false,
            },
        );
        Ok(())
    }
    pub fn opened(&mut self, id: Uuid) -> Result<()> {
        let flow = self.live.get_mut(&id).ok_or("unknown flow")?;
        if flow.opened {
            return Err("duplicate opened".into());
        }
        flow.opened = true;
        Ok(())
    }
    pub fn direction(&mut self, id: Uuid, sender: Sender) -> Result<&mut Direction> {
        let flow = self.live.get_mut(&id).ok_or("unknown flow")?;
        if !flow.opened {
            return Err("data before opened".into());
        }
        Ok(&mut flow.directions[if matches!(sender, Sender::Host) { 0 } else { 1 }])
    }
    /// IDs below the high-water mark are no longer reusable in this boot.
    /// Gaps are retired too: strictly increasing Open makes them impossible to open.
    pub fn is_retired(&self, id: Uuid) -> bool {
        !id.is_nil() && id <= self.last && !self.live.contains_key(&id)
    }
    pub fn close(&mut self, id: Uuid, budget: &mut Budget) -> Result<bool> {
        if self.is_retired(id) {
            return Ok(false);
        }
        let mut flow = self.live.remove(&id).ok_or("unknown flow")?;
        for d in &mut flow.directions {
            d.discard(budget)?;
        }
        Ok(true)
    }
}
/// One live serialized transfer. Caller durably saves the receipt before reporting it.
#[derive(Default)]
pub struct Replay {
    id: Option<Uuid>,
    step: u64,
    request: Option<Request>,
    receipt: Option<Receipt>,
    deadline: u64,
    cancelled: bool,
}
pub enum Step<'a> {
    Execute,
    Replay(&'a Receipt),
}
impl Replay {
    pub fn begin(
        &mut self,
        id: Uuid,
        step: u64,
        request: Request,
        remaining: u64,
        now: u64,
    ) -> Result<Step<'_>> {
        request.validate()?;
        if id.is_nil() || step == 0 || step > MAX_SAFE || remaining == 0 || remaining > MAX_SAFE {
            return Err("invalid transfer step".into());
        }
        if self.id.is_some_and(|old| old != id) {
            return Err("transfer lane busy".into());
        }
        if self.id == Some(id) && step == self.step {
            if self.request.as_ref() != Some(&request) {
                return Err("changed transfer replay".into());
            }
            return self
                .receipt
                .as_ref()
                .map(Step::Replay)
                .ok_or_else(|| "step still in flight".into());
        }
        if self.cancelled || step != self.step + 1 || (self.step != 0 && self.receipt.is_none()) {
            return Err("transfer gap/cancelled".into());
        }
        self.deadline = now.checked_add(remaining).ok_or("deadline overflow")?;
        self.id = Some(id);
        self.step = step;
        self.request = Some(request);
        self.receipt = None;
        Ok(Step::Execute)
    }
    pub fn permits(&mut self, now: u64) -> bool {
        self.cancelled |= now >= self.deadline;
        !self.cancelled
    }
    pub fn cancel(&mut self, id: Uuid) {
        if self.id == Some(id) {
            self.cancelled = true;
        }
    }
    pub fn complete(&mut self, receipt: Receipt) -> Result<()> {
        receipt.validate()?;
        if self.id.is_none() || self.receipt.is_some() {
            return Err("no pending transfer step".into());
        }
        self.receipt = Some(receipt);
        Ok(())
    }
}

#[cfg(test)]
#[path = "data_tests.rs"]
mod tests;

/// Validates successful transfer receipts against the accepted stream, including
/// cursor and incremental SHA-256. Filesystem identity/durability is a separate check.
#[derive(Default)]
pub struct Cursor {
    state: Option<CopyState>,
    ended: bool,
}
struct CopyState {
    upload: bool,
    bytes: u64,
    offset: u64,
    expected: Option<String>,
    hash: sha2::Sha256,
}
impl Cursor {
    pub fn request(&self, request: &Request) -> Result<()> {
        request.validate()?;
        if self.ended {
            return Err("transfer already ended".into());
        }
        match (self.state.as_ref(), request) {
            (
                None,
                Request::BeginUpload { .. } | Request::BeginDownload { .. } | Request::Abort,
            ) => Ok(()),
            (Some(s), Request::Write { offset, data }) if s.upload && *offset == s.offset => {
                if s.offset
                    .checked_add(payload(data, false)?.len() as u64)
                    .is_none_or(|n| n > s.bytes)
                {
                    return Err("upload exceeds declared size".into());
                }
                Ok(())
            }
            (Some(s), Request::Read { offset, .. }) if !s.upload && *offset == s.offset => Ok(()),
            (Some(s), Request::Finish { bytes, sha256 })
                if s.offset == s.bytes && *bytes == s.bytes =>
            {
                use sha2::Digest;
                if s.expected.as_ref().is_some_and(|h| h != sha256)
                    || format!("{:x}", s.hash.clone().finalize()) != *sha256
                {
                    return Err("transfer digest mismatch".into());
                }
                Ok(())
            }
            (Some(_), Request::Abort) => Ok(()),
            _ => Err("transfer action/cursor mismatch".into()),
        }
    }
    pub fn receipt(&mut self, request: &Request, receipt: &Receipt) -> Result<()> {
        use sha2::Digest;
        self.request(request)?;
        receipt.validate()?;
        match (request, receipt) {
            (_, Receipt::Failed { .. } | Receipt::Unknown { .. }) => {
                self.ended = true;
            }
            (Request::BeginUpload { bytes, sha256, .. }, Receipt::Writing { offset: 0 }) => {
                self.state = Some(CopyState {
                    upload: true,
                    bytes: *bytes,
                    offset: 0,
                    expected: Some(sha256.clone()),
                    hash: sha2::Sha256::new(),
                });
            }
            (
                Request::BeginDownload { .. },
                Receipt::Reading {
                    offset: 0,
                    bytes: Some(bytes),
                    data: None,
                },
            ) => {
                self.state = Some(CopyState {
                    upload: false,
                    bytes: *bytes,
                    offset: 0,
                    expected: None,
                    hash: sha2::Sha256::new(),
                });
            }
            (Request::Write { data, .. }, Receipt::Writing { offset }) => {
                let bytes = payload(data, false)?;
                let s = self.state.as_mut().ok_or("missing transfer")?;
                if *offset != s.offset + bytes.len() as u64 {
                    return Err("invalid write cursor".into());
                }
                s.hash.update(&bytes);
                s.offset = *offset;
            }
            (
                Request::Read { max_bytes, .. },
                Receipt::Reading {
                    offset,
                    bytes: None,
                    data: Some(data),
                },
            ) => {
                let bytes = payload(data, true)?;
                let s = self.state.as_mut().ok_or("missing transfer")?;
                if bytes.len() as u64 > *max_bytes
                    || *offset != s.offset + bytes.len() as u64
                    || *offset > s.bytes
                    || (bytes.is_empty() && s.offset != s.bytes)
                {
                    return Err("invalid read cursor".into());
                }
                s.hash.update(&bytes);
                s.offset = *offset;
            }
            (
                Request::Finish { bytes, sha256 },
                Receipt::Committed {
                    bytes: got,
                    sha256: hash,
                    durable: true,
                },
            ) if self.state.as_ref().is_some_and(|s| s.upload)
                && bytes == got
                && sha256 == hash =>
            {
                self.ended = true;
            }
            (
                Request::Finish { bytes, sha256 },
                Receipt::Verified {
                    bytes: got,
                    sha256: hash,
                },
            ) if self.state.as_ref().is_some_and(|s| !s.upload)
                && bytes == got
                && sha256 == hash =>
            {
                self.ended = true;
            }
            (Request::Abort, Receipt::Aborted) => {
                self.ended = true;
            }
            _ => return Err("receipt does not match transfer request".into()),
        }
        Ok(())
    }
}
