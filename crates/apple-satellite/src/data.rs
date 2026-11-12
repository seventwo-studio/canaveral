//! Nonblocking, single-use host data handshake. A data failure never owns control fencing.
//!
//! Authenticated streams move to the independent reactor after dataReady.
use crate::{clock::Clock, guest, Result};
use canaveral_guest_protocol::{
    data::{encode, Decoder, Frame, Sender},
    Binding,
};
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    time::Duration,
};

const TURN_BYTES: usize = 65536;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);

/// Per-boot readiness latch. Data is attempted once and never reconnected.
#[derive(Default)]
pub(crate) struct Lane {
    attempted: bool,
    initial_ready: bool,
    session: Option<Session>,
    worker: Option<crate::reactor::Handle>,
    options: Option<(bool, Vec<String>, Duration)>,
}
impl Lane {
    pub(crate) fn authority(&self) -> Option<crate::reactor::Authority> {
        self.worker.as_ref().map(|w| w.authority.clone())
    }
    pub(crate) fn configure(&mut self, enabled: bool, denied: Vec<String>, deadline: Duration) {
        if let Some(worker) = &self.worker {
            worker.authority.renew(deadline);
        }
        self.options = Some((enabled, denied, deadline));
    }
    pub(crate) fn shutdown(&mut self) -> crate::reactor::Closed {
        if let Some(mut worker) = self.worker.take() {
            worker.shutdown()
        } else {
            if let Some(mut s) = self.session.take() {
                s.close();
            }
            crate::reactor::Closed {
                sockets: true,
                workers: true,
                relay: true,
            }
        }
    }
    pub(crate) fn start(&mut self, path: &str, binding: Binding, nonce: String) {
        if !self.attempted {
            self.attempted = true;
            if let Ok(session) = Session::open(path, binding, nonce) {
                if let Some((enabled, denied, deadline)) = &self.options {
                    if let Ok(policy) = crate::egress::Policy::new(denied) {
                        self.worker = Some(crate::reactor::spawn(
                            session,
                            crate::reactor::Native,
                            policy,
                            *enabled,
                            crate::reactor::Authority::new(*deadline),
                        ));
                    }
                } else {
                    self.session = Some(session);
                }
            }
        }
    }
    pub(crate) fn pump(&mut self) {
        if let Some(worker) = &self.worker {
            self.initial_ready |= worker.ready.load(std::sync::atomic::Ordering::Acquire);
        }
        if let Some(session) = self.session.as_mut() {
            if session.pump().is_err() {
                self.session = None;
            } else {
                self.initial_ready |= session.ready();
            }
        }
    }
    pub(crate) fn commands_ready(&self, required: bool) -> bool {
        !required || self.initial_ready
    }
}

impl Drop for Lane {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub struct Session {
    stream: Option<UnixStream>,
    decoder: Decoder,
    hello: Binding,
    nonce: String,
    output: Vec<u8>,
    sent: usize,
    started: Clock,
    ready: bool,
    handoff: bool,
}
impl Session {
    /// Connect once, after control connection begins, using the launch binding,
    /// never a subsequently renewed binding. Ownership checks match control.
    pub fn open(agent_path: &str, binding: Binding, nonce: String) -> Result<Self> {
        Self::new(guest::connect_data(agent_path)?, binding, nonce)
    }
    pub(crate) fn new(stream: UnixStream, binding: Binding, nonce: String) -> Result<Self> {
        let output = encode(
            &Frame::DataHello {
                version: 1,
                binding: binding.clone(),
                nonce: nonce.clone(),
            },
            Sender::Host,
        )
        .map_err(|_| "invalid data hello")?;
        stream
            .set_nonblocking(true)
            .map_err(|_| "data relay unavailable")?;
        Ok(Self {
            stream: Some(stream),
            decoder: Decoder::default(),
            hello: binding,
            nonce,
            output,
            sent: 0,
            started: Clock::now(),
            ready: false,
            handoff: false,
        })
    }
    pub(crate) fn enable_handoff(&mut self) {
        self.handoff = true;
    }
    pub(crate) fn take_ready_stream(&mut self) -> Option<UnixStream> {
        if self.ready {
            self.stream.take()
        } else {
            None
        }
    }
    pub fn ready(&self) -> bool {
        self.ready && self.stream.is_some()
    }
    /// Closing drops the owned descriptor synchronously; there are no workers yet.
    pub fn close(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        self.ready = false;
        self.output.clear();
        self.decoder = Decoder::default();
    }
    /// Bounded work: at most 64 KiB written and 64 KiB read per supervision turn.
    /// Errors poison only this data session. The caller must continue control.
    pub fn pump(&mut self) -> Result<()> {
        let result = self.step();
        if result.is_err() {
            self.close();
        }
        result
    }
    fn step(&mut self) -> Result<()> {
        if !self.ready && self.started.elapsed() >= HANDSHAKE_TIMEOUT {
            return Err("data handshake timeout");
        }
        let stream = self.stream.as_mut().ok_or("data session closed")?;
        if self.sent < self.output.len() {
            let end = self.output.len().min(self.sent + TURN_BYTES);
            match stream.write(&self.output[self.sent..end]) {
                Ok(0) => return Err("data relay closed"),
                Ok(n) => self.sent += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Err("data relay failed"),
            }
            if self.sent == self.output.len() {
                self.output.clear();
                self.sent = 0;
            } else if self.started.elapsed() >= WRITE_TIMEOUT {
                return Err("data hello write stalled");
            }
        }
        let mut buf = [0; TURN_BYTES];
        let mut remaining = TURN_BYTES;
        // A prefix/body pair consumes at least four bytes, bounding frame work too.
        while remaining > 0 {
            let want = self.decoder.needed().min(remaining);
            match stream.read(&mut buf[..want]) {
                Ok(0) => return Err("data disconnected"),
                Ok(n) => {
                    remaining -= n;
                    if let Some(frame) = self
                        .decoder
                        .feed(&buf[..n], Sender::Guest)
                        .map_err(|_| "data protocol violation")?
                    {
                        match frame {
                            Frame::DataReady { binding, nonce, .. }
                                if !self.ready
                                    && self.output.is_empty()
                                    && binding == self.hello
                                    && nonce == self.nonce =>
                            {
                                self.ready = true;
                                if self.handoff {
                                    return Ok(());
                                }
                            }
                            _ => return Err("unexpected data frame"),
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return Err("data relay failed"),
            }
        }
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    fn pair() -> (Session, UnixStream) {
        let (host, peer) = UnixStream::pair().unwrap();
        let binding = Binding {
            lease_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            revision: 1,
            boot_attempt: Uuid::from_u128(3),
            bundle_digest: "a".repeat(64),
        };
        (Session::new(host, binding, "b".repeat(64)).unwrap(), peer)
    }
    fn ready(s: &Session) -> Frame {
        Frame::DataReady {
            version: 1,
            binding: s.hello.clone(),
            nonce: s.nonce.clone(),
        }
    }
    fn send(peer: &mut UnixStream, frame: &Frame) {
        peer.write_all(&encode(frame, Sender::Guest).unwrap())
            .unwrap();
    }
    #[test]
    fn hello_is_initial_binding_and_ready_must_echo_exactly() {
        let (mut s, mut peer) = pair();
        s.pump().unwrap();
        let mut prefix = [0; 4];
        peer.read_exact(&mut prefix).unwrap();
        let mut bytes = vec![0; u32::from_be_bytes(prefix) as usize];
        peer.read_exact(&mut bytes).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            serde_json::json!({"type":"dataHello","version":1,"binding":s.hello,"nonce":s.nonce})
        );
        assert!(!s.ready());
        send(&mut peer, &ready(&s));
        s.pump().unwrap();
        assert!(s.ready());
        s.close();
        assert!(!s.ready());
        assert!(s.stream.is_none());
        assert!(s.pump().is_err());
    }
    #[test]
    fn mismatch_duplicate_ready_and_wrong_direction_poison_only_data() {
        for variant in 0..4 {
            let (mut s, mut peer) = pair();
            let mut frame = ready(&s);
            if let Frame::DataReady { binding, nonce, .. } = &mut frame {
                match variant {
                    0 => binding.revision += 1,
                    1 => *nonce = "c".repeat(64),
                    _ => {}
                }
            }
            send(&mut peer, &frame);
            if variant == 2 {
                send(&mut peer, &frame);
            } else if variant == 3 {
                peer.write_all(&0u32.to_be_bytes()).unwrap();
            }
            assert!(s.pump().is_err());
            assert!(!s.ready());
            assert!(s.stream.is_none());
        }
    }
    #[test]
    fn fragmented_ready_and_data_loss_leave_control_live_and_renewable() {
        let (mut control, mut control_peer) = guest::tests::session_pair();
        guest::tests::send_ready(&control, &mut control_peer);
        assert!(control.pump(100.0).unwrap());
        let (mut s, mut peer) = pair();
        let bytes = encode(&ready(&s), Sender::Guest).unwrap();
        for byte in bytes {
            peer.write_all(&[byte]).unwrap();
            s.pump().unwrap();
        }
        assert!(s.ready());
        drop(peer);
        assert!(s.pump().is_err());
        assert!(!s.ready());
        assert!(control.ready(101.0));
        // The data binding remains the initial revision even as control renews.
        let mut newer = s.hello.clone();
        newer.revision = 2;
        control.renew(newer, 130.0, 101.0).unwrap();
        control.pump(101.0).unwrap();
        assert!(control.ready(111.0));
    }
    #[test]
    fn timeout_and_buffered_ready_then_eof_never_publish_readiness() {
        let (mut s, _peer) = pair();
        crate::clock::advance(Duration::from_secs(31));
        assert_eq!(s.pump(), Err("data handshake timeout"));
        crate::clock::advance(Duration::ZERO);
        let (mut s, mut peer) = pair();
        send(&mut peer, &ready(&s));
        peer.shutdown(Shutdown::Write).unwrap();
        assert!(s.pump().is_err());
        assert!(!s.ready());
    }
    #[test]
    fn initial_readiness_requires_data_but_later_loss_does_not_withdraw_commands() {
        let mut lane = Lane::default();
        assert!(lane.commands_ready(false)); // v1 has no data handshake.
        assert!(!lane.commands_ready(true));
        let (s, mut peer) = pair();
        send(&mut peer, &ready(&s));
        lane.attempted = true;
        lane.session = Some(s);
        lane.pump();
        assert!(lane.commands_ready(true));
        drop(peer);
        lane.pump();
        assert!(lane.session.is_none());
        assert!(lane.commands_ready(true));
        lane.start(
            "/invalid/agent.sock",
            pair().0.hello.clone(),
            "b".repeat(64),
        );
        assert!(lane.session.is_none()); // No reconnect after loss.
    }
}
