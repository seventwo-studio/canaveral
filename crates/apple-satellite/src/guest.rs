//! Owned host side of guest protocol 1 through the helper's private per-boot relay socket.
//!
//! The socket path comes only from the helper's `direct-started.json`, bound to this lease,
//! member, host boot session and boot attempt, and must be the helper's exact private
//! `canaveral-<uuid>/agent.sock` form. Ownership, mode and the peer uid are verified before
//! hello. All transport I/O is nonblocking and bounded per pump, so a stalled relay never
//! delays lease fencing, renewal or disconnect handling in the caller's loop.
use crate::{private, Result};
use canaveral_guest_protocol::{encode, Binding, Guest, GuestDecoder, Host, MAX_FRAME};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
#[cfg(target_os = "macos")]
pub const SOCKET_ROOT: &str = "/private/tmp";
#[cfg(not(target_os = "macos"))]
pub const SOCKET_ROOT: &str = "/tmp";
/// Subtracted from the host's remaining lease time: transit, relay and publication latency.
pub const MARGIN_MS: u64 = 2000;
/// Queued bytes must reach the relay within this bound, keeping the guest deadline below ours.
const WRITE_STALL: Duration = Duration::from_secs(1);
/// Guest probes finish before the agent accepts, so ready must follow hello promptly.
const HANDSHAKE: Duration = Duration::from_secs(30);
const CHUNK: usize = 65536;
/// Bounds queued outbound bytes and unread guest frames.
const OUT_MAX: usize = 4 * CHUNK;
const EVENTS_MAX: usize = MAX_FRAME;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Started {
    event: String,
    version: u32,
    continuous: f64,
    #[serde(rename = "memberID")]
    member_id: Uuid,
    #[serde(rename = "leaseID")]
    lease_id: Uuid,
    #[serde(rename = "bootSessionID")]
    boot_session_id: Uuid,
    #[serde(rename = "bootAttempt")]
    boot_attempt: Uuid,
    #[serde(rename = "agentSocket")]
    agent_socket: String,
    #[serde(default, rename = "dataSocketPath")]
    data_socket_path: Option<String>,
}
pub struct Expected {
    pub lease_id: Uuid,
    pub member_id: Uuid,
    pub boot_session_id: Uuid,
    pub boot_attempt: Uuid,
    /// Continuous-clock time of launch intent; a started record cannot predate it.
    pub boot: f64,
}
/// The only accepted relay location: SOCKET_ROOT/canaveral-<lowercase uuid>/agent.sock.
fn relay_directory(path: &str) -> Option<PathBuf> {
    relay_directory_for(path, "agent.sock")
}
fn relay_directory_for(path: &str, socket: &str) -> Option<PathBuf> {
    let rest = path
        .strip_prefix(SOCKET_ROOT)?
        .strip_prefix("/canaveral-")?
        .strip_suffix(&format!("/{socket}"))?;
    let id = Uuid::parse_str(rest).ok()?;
    (id.hyphenated().to_string() == rest && !id.is_nil())
        .then(|| PathBuf::from(format!("{SOCKET_ROOT}/canaveral-{rest}")))
}
/// `Ok(None)` until the helper publishes VMM start; any binding mismatch is an error.
pub fn read_started(machine: &Path, e: &Expected, now: f64) -> Result<Option<String>> {
    let Some(bytes) = private::read_owned(&machine.join("direct-started.json"), 4096)
        .map_err(|_| "unsafe direct start record")?
    else {
        return Ok(None);
    };
    let s: Started = serde_json::from_slice(&bytes).map_err(|_| "invalid direct start record")?;
    if s.event != "started"
        || s.version != 1
        || !s.continuous.is_finite()
        || s.continuous < e.boot
        || s.continuous > now + 2.0
        || s.lease_id != e.lease_id
        || s.member_id != e.member_id
        || s.boot_session_id != e.boot_session_id
        || s.boot_attempt != e.boot_attempt
        || relay_directory(&s.agent_socket).is_none()
        || s.data_socket_path.as_ref().is_some_and(|path| {
            relay_directory_for(path, "data.sock") != relay_directory(&s.agent_socket)
        })
    {
        return Err("direct start record does not match this launch");
    }
    Ok(Some(s.agent_socket))
}
/// Peer credentials of a connected Unix stream.
pub fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    {
        let (mut uid, mut gid) = (0, 0);
        (unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
    }
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        (unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        } == 0)
            .then_some(cred.uid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "linux")))]
    {
        let _ = stream;
        None
    }
}
/// Verifies private ownership of the published relay and of its peer before any frame.
pub fn connect(path: &str) -> Result<UnixStream> {
    connect_relay(path, "agent.sock")
}
/// Data relay must be the exact sibling of the authenticated control relay.
/// No guest-supplied or independently published path is accepted.
pub fn connect_data(agent_path: &str) -> Result<UnixStream> {
    let directory = relay_directory(agent_path).ok_or("unexpected control relay path")?;
    let path = directory.join("data.sock");
    connect_relay(path.to_str().ok_or("invalid data relay path")?, "data.sock")
}
fn connect_relay(path: &str, socket: &str) -> Result<UnixStream> {
    let dir = relay_directory_for(path, socket).ok_or("unexpected relay socket path")?;
    let me = unsafe { libc::geteuid() };
    // Nofollow walk: root-owned sticky SOCKET_ROOT, then our private directory.
    let opened = private::walk(&dir).map_err(|_| "unsafe relay directory")?;
    let d = opened.metadata().map_err(|_| "unsafe relay directory")?;
    let s = std::fs::symlink_metadata(path).map_err(|_| "relay socket missing")?;
    if d.uid() != me
        || d.mode() & 0o7777 != 0o700
        || !s.file_type().is_socket()
        || s.uid() != me
        || s.mode() & 0o077 != 0
    {
        return Err("relay socket is not privately owned");
    }
    let stream = UnixStream::connect(path).map_err(|_| "relay socket refused")?;
    if peer_uid(&stream) != Some(me) {
        return Err("relay peer is not the helper uid");
    }
    let after = std::fs::symlink_metadata(path).map_err(|_| "relay socket disappeared")?;
    let current = private::walk(&dir).map_err(|_| "relay directory changed")?;
    let current = current.metadata().map_err(|_| "relay directory changed")?;
    if (s.dev(), s.ino(), s.uid(), s.mode())
        != (after.dev(), after.ino(), after.uid(), after.mode())
        || (d.dev(), d.ino(), d.uid(), d.mode())
            != (current.dev(), current.ino(), current.uid(), current.mode())
    {
        return Err("relay changed during connect");
    }
    stream
        .set_nonblocking(true)
        .map_err(|_| "relay socket refused")?;
    Ok(stream)
}
/// Removes only the exact published relay directory after positive VM stop.
pub fn remove_published(path: &str) -> Result<()> {
    let dir = relay_directory(path).ok_or("unexpected relay socket path")?;
    private::walk(Path::new(SOCKET_ROOT)).map_err(|_| "unsafe relay root")?;
    let d = match std::fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        other => other.map_err(|_| "relay directory unreadable")?,
    };
    if !d.is_dir() || d.uid() != unsafe { libc::geteuid() } || d.mode() & 0o7777 != 0o700 {
        return Err("relay directory is not owned; retained");
    }
    for entry in std::fs::read_dir(&dir).map_err(|_| "relay directory unreadable")? {
        let entry = entry.map_err(|_| "relay directory unreadable")?;
        let kind = entry
            .file_type()
            .map_err(|_| "relay directory unreadable")?;
        if !["agent.sock", "data.sock"]
            .iter()
            .any(|name| entry.file_name() == *name)
            || !kind.is_socket()
        {
            return Err("unexpected relay directory content; retained");
        }
        std::fs::remove_file(entry.path()).map_err(|_| "relay socket removal failed")?;
    }
    std::fs::remove_dir(&dir).map_err(|_| "relay directory removal failed")
}
/// Conservative remaining duration for the guest's own clock: never host absolute time.
pub fn remaining_ms(deadline: f64, now: f64) -> Result<u64> {
    let ms = ((deadline - now) * 1000.0).floor();
    if !ms.is_finite() || ms <= MARGIN_MS as f64 {
        return Err("too little lease time for guest authority");
    }
    Ok((ms as u64 - MARGIN_MS).min(canaveral_guest_protocol::MAX_SAFE))
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Handshake,
    Ready,
    Closed,
}
pub struct Session {
    stream: UnixStream,
    out: Vec<u8>,
    sent: usize,
    queued: Option<crate::clock::Clock>,
    opened: crate::clock::Clock,
    decoder: GuestDecoder,
    hello: Binding,
    revision: u64,
    /// Host-side upper estimate of the guest's own deadline (continuous seconds).
    guest_deadline: f64,
    phase: Phase,
    events: VecDeque<Guest>,
    event_bytes: usize,
    last_id: Uuid,
    active: Option<Uuid>,
    output_credit_started: bool,
    pub first_command: Option<f64>,
}
impl Session {
    /// Connects to the verified relay and queues hello for the trusted launch binding.
    pub fn open(path: &str, binding: Binding, deadline: f64, now: f64) -> Result<Self> {
        let remaining = remaining_ms(deadline, now)?;
        let stream = connect(path)?;
        let mut s = Self {
            stream,
            out: Vec::new(),
            sent: 0,
            queued: None,
            opened: crate::clock::Clock::now(),
            decoder: GuestDecoder::default(),
            revision: binding.revision,
            hello: binding.clone(),
            guest_deadline: now + remaining as f64 / 1000.0,
            phase: Phase::Handshake,
            events: VecDeque::new(),
            event_bytes: 0,
            last_id: Uuid::nil(),
            active: None,
            output_credit_started: false,
            first_command: None,
        };
        s.queue(&Host::Hello {
            version: 1,
            binding,
            remaining_ms: remaining,
        })?;
        Ok(s)
    }
    pub fn authority_expired(&self, now: f64) -> bool {
        now >= self.guest_deadline
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    /// Ready, and the guest's authority cannot have lapsed by the host's estimate.
    pub fn ready(&self, now: f64) -> bool {
        self.phase == Phase::Ready && now < self.guest_deadline
    }
    fn queue(&mut self, frame: &Host) -> Result<()> {
        let bytes = encode(frame).map_err(|_| "guest frame encoding failed")?;
        if self.out.len() + bytes.len() > OUT_MAX {
            return Err("guest transport backlog");
        }
        if self.out.is_empty() {
            self.queued = Some(crate::clock::Clock::now());
        }
        self.out.extend(bytes);
        Ok(())
    }
    fn closed<T>(&mut self, r: Result<T>) -> Result<T> {
        if r.is_err() {
            self.phase = Phase::Closed;
            let _ = self.stream.shutdown(std::net::Shutdown::Both);
        }
        r
    }
    /// Forwards a strictly newer revision of the same launch. Late delivery fails the session.
    pub fn renew(&mut self, binding: Binding, deadline: f64, now: f64) -> Result<()> {
        let r = (|| {
            if self.phase == Phase::Closed
                || now >= self.guest_deadline
                || !binding.same_launch(&self.hello)
                || binding.revision <= self.revision
            {
                return Err("invalid guest renewal");
            }
            let remaining = remaining_ms(deadline, now)?;
            let revision = binding.revision;
            self.queue(&Host::Renew {
                version: 1,
                binding,
                remaining_ms: remaining,
            })?;
            self.revision = revision;
            self.guest_deadline = now + remaining as f64 / 1000.0;
            Ok(())
        })();
        self.closed(r)
    }
    /// One bounded nonblocking step. Returns true exactly once, when the guest becomes ready.
    pub fn pump(&mut self, now: f64) -> Result<bool> {
        let r = self.step(now);
        self.closed(r)
    }
    fn step(&mut self, now: f64) -> Result<bool> {
        if self.phase == Phase::Closed {
            return Err("guest session closed");
        }
        if now >= self.guest_deadline {
            return Err("guest authority lapsed");
        }
        if self.phase == Phase::Handshake && self.opened.elapsed() > HANDSHAKE {
            return Err("guest handshake timeout");
        }
        if self.sent < self.out.len() {
            let end = self.out.len().min(self.sent + CHUNK);
            match self.stream.write(&self.out[self.sent..end]) {
                Ok(0) => return Err("guest transport closed"),
                Ok(n) => self.sent += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Err("guest transport failed"),
            }
            if self.sent == self.out.len() {
                self.out.clear();
                self.sent = 0;
                self.queued = None;
            } else if self.queued.is_some_and(|q| q.elapsed() > WRITE_STALL) {
                return Err("guest transport write stalled");
            }
        }
        let mut buf = vec![0; CHUNK];
        let mut became_ready = false;
        for _ in 0..16 {
            if self.event_bytes >= EVENTS_MAX {
                break; // Backpressure: unread frames stop reads, never supervision.
            }
            let want = self.decoder.needed().min(CHUNK);
            match self.stream.read(&mut buf[..want]) {
                Ok(0) => return Err("guest disconnected"),
                Ok(n) => {
                    let Some(frame) = self
                        .decoder
                        .feed(&buf[..n])
                        .map_err(|_| "guest protocol violation")?
                    else {
                        continue;
                    };
                    // Drain the bounded read pass before publishing readiness: an already
                    // readable EOF or protocol failure must invalidate the transition.
                    became_ready |= self.accept(frame)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return Err("guest transport failed"),
            }
        }
        Ok(became_ready)
    }
    fn accept(&mut self, frame: Guest) -> Result<bool> {
        match (&self.phase, &frame) {
            (Phase::Handshake, Guest::Ready { binding, .. }) => {
                // Ready follows the guest's manifest-bound tool probes; echo must be exact.
                if *binding != self.hello {
                    return Err("guest identity mismatch");
                }
                self.phase = Phase::Ready;
                return Ok(true);
            }
            (Phase::Ready, Guest::Rejected { .. }) => {}
            (Phase::Ready, Guest::Output { id, .. }) if self.active == Some(*id) => {}
            (Phase::Ready, Guest::Exit { id, .. } | Guest::SpawnFailed { id, .. })
                if self.active == Some(*id) =>
            {
                self.active = None;
            }
            _ => return Err("unexpected guest frame"),
        }
        self.event_bytes += serde_json::to_vec(&frame).map_or(MAX_FRAME, |b| b.len());
        self.events.push_back(frame);
        Ok(false)
    }
    /// Command client for the controller operation lane.
    /// Requires ready, no active command, every earlier control frame read and nothing queued.
    pub fn exec(
        &mut self,
        argv: Vec<String>,
        cwd: String,
        env: BTreeMap<String, String>,
        timeout_ms: u64,
        now: f64,
    ) -> Result<Uuid> {
        if !self.ready(now)
            || self.active.is_some()
            || !self.events.is_empty()
            || !self.out.is_empty()
        {
            return Err("guest not ready for exec");
        }
        let id = next_id(self.last_id)?;
        let frame = Host::Exec {
            version: 1,
            id,
            argv,
            cwd,
            env,
            timeout_ms,
        };
        frame.validate().map_err(|_| "invalid exec")?;
        let r = self.queue(&frame);
        self.closed(r)?;
        self.last_id = id;
        self.active = Some(id);
        self.first_command.get_or_insert(now);
        Ok(id)
    }
    /// Initialize the session-wide output window once; later reads replenish only
    /// consumed bytes. Starting another command must not grant a second window.
    pub fn start_output_credit(&mut self) -> Result<()> {
        if !self.output_credit_started {
            self.credit(65536)?;
            self.output_credit_started = true;
        }
        Ok(())
    }
    pub fn credit(&mut self, bytes: u64) -> Result<()> {
        let frame = Host::Credit { version: 1, bytes };
        if self.phase != Phase::Ready || frame.validate().is_err() {
            return Err("invalid credit");
        }
        let r = self.queue(&frame);
        self.closed(r)
    }
    pub fn cancel(&mut self, id: Uuid) -> Result<()> {
        if self.phase != Phase::Ready {
            return Err("guest not ready");
        }
        let r = self.queue(&Host::Cancel { version: 1, id });
        self.closed(r)
    }
    /// Next unread guest command frame, in order.
    pub fn next_event(&mut self) -> Option<Guest> {
        let frame = self.events.pop_front()?;
        self.event_bytes = self
            .event_bytes
            .saturating_sub(serde_json::to_vec(&frame).map_or(MAX_FRAME, |b| b.len()));
        Some(frame)
    }
}
/// Strictly increasing UUIDs by bytes: millisecond time-ordered, random tail, never repeating.
fn next_id(last: Uuid) -> Result<Uuid> {
    let mut tail = [0u8; 16];
    getrandom::fill(&mut tail).map_err(|_| "randomness unavailable")?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let candidate = (ms << 80) | (u128::from_be_bytes(tail) >> 48);
    let id = candidate.max(
        last.as_u128()
            .checked_add(1)
            .ok_or("command ids exhausted")?,
    );
    Ok(Uuid::from_u128(id))
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn session_pair() -> (Session, UnixStream) {
        session_pair_with_deadline(110.0)
    }
    pub(crate) fn session_pair_with_deadline(deadline: f64) -> (Session, UnixStream) {
        let (stream, peer) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        let binding = Binding {
            lease_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            revision: 1,
            boot_attempt: Uuid::from_u128(3),
            bundle_digest: "a".repeat(64),
        };
        (
            Session {
                stream,
                out: Vec::new(),
                sent: 0,
                queued: None,
                opened: crate::clock::Clock::now(),
                decoder: GuestDecoder::default(),
                hello: binding,
                revision: 1,
                guest_deadline: deadline,
                phase: Phase::Handshake,
                events: VecDeque::new(),
                event_bytes: 0,
                last_id: Uuid::nil(),
                active: None,
                output_credit_started: false,
                first_command: None,
            },
            peer,
        )
    }
    pub(crate) fn send_ready(session: &Session, peer: &mut UnixStream) {
        peer.write_all(
            &encode(&Guest::Ready {
                version: 1,
                binding: session.hello.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn late_renewal_cannot_revive_expired_guest_authority() {
        for now in [110.0, 110.5] {
            let (mut session, mut peer) = session_pair();
            send_ready(&session, &mut peer);
            assert!(session.pump(109.0).unwrap());
            assert!(session.ready(109.0));
            let mut newer = session.hello.clone();
            newer.revision = 2;
            assert!(session.renew(newer, 130.0, now).is_err());
            assert!(!session.ready(now));
            assert_eq!(session.revision(), 1);
            assert!(session.pump(now).is_err());
        }
    }
    #[test]
    fn timely_renewal_extends_live_guest_authority() {
        let (mut session, mut peer) = session_pair();
        send_ready(&session, &mut peer);
        assert!(session.pump(100.0).unwrap());
        assert!(!session.pump(100.0).unwrap());
        let mut newer = session.hello.clone();
        newer.revision = 2;
        session.renew(newer, 130.0, 109.0).unwrap();
        assert!(session.ready(111.0));
        assert_eq!(session.revision(), 2);
    }
    #[test]
    fn buffered_ready_then_eof_never_publishes_readiness() {
        let (mut session, mut peer) = session_pair();
        send_ready(&session, &mut peer);
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(session.pump(100.0), Err("guest disconnected"));
        assert!(!session.ready(100.0));
    }
    #[test]
    fn buffered_ready_then_invalid_frame_never_publishes_readiness() {
        let (mut session, mut peer) = session_pair();
        send_ready(&session, &mut peer);
        peer.write_all(&0u32.to_be_bytes()).unwrap();
        assert_eq!(session.pump(100.0), Err("guest protocol violation"));
        assert!(!session.ready(100.0));
    }
    #[test]
    fn data_relay_is_a_private_sibling_and_cleanup_removes_both() {
        use std::os::unix::{
            fs::{DirBuilderExt, PermissionsExt},
            net::UnixListener,
        };
        let dir = PathBuf::from(format!(
            "{SOCKET_ROOT}/canaveral-{}",
            crate::random_uuid().unwrap()
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let agent = dir.join("agent.sock");
        let data = dir.join("data.sock");
        let a = UnixListener::bind(&agent).unwrap();
        let d = UnixListener::bind(&data).unwrap();
        for p in [&agent, &data] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let client = connect_data(agent.to_str().unwrap()).unwrap();
        let _peer = d.accept().unwrap();
        drop(client);
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(connect_data(agent.to_str().unwrap()).is_err());
        assert!(connect_data(data.to_str().unwrap()).is_err());
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o600)).unwrap();
        drop((a, d));
        remove_published(agent.to_str().unwrap()).unwrap();
        assert!(!dir.exists());
    }
    #[test]
    fn relay_path_and_remaining_bounds() {
        let id = Uuid::from_u128(77);
        let good = format!("{SOCKET_ROOT}/canaveral-{id}/agent.sock");
        assert!(relay_directory(&good).is_some());
        for bad in [
            good.to_uppercase(),
            good.replace("agent.sock", "other.sock"),
            format!("{SOCKET_ROOT}/canaveral-{id}/../x/agent.sock"),
            format!("/var/tmp/canaveral-{id}/agent.sock"),
            format!("{SOCKET_ROOT}/canaveral-{}/agent.sock", Uuid::nil()),
        ] {
            assert!(relay_directory(&bad).is_none(), "{bad}");
        }
        assert_eq!(remaining_ms(110.0, 100.0).unwrap(), 8000);
        assert!(remaining_ms(102.0, 100.0).is_err());
        assert!(remaining_ms(f64::NAN, 100.0).is_err());
    }
    #[test]
    fn command_ids_strictly_increase() {
        let mut last = Uuid::from_u128(u128::MAX - 2);
        assert_eq!(next_id(last).unwrap().as_u128(), u128::MAX - 1);
        last = Uuid::nil();
        for _ in 0..1000 {
            let id = next_id(last).unwrap();
            assert!(id > last);
            last = id;
        }
    }
}
