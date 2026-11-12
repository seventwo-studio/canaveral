//! Independent host data execution. Providers must honor deadlines and return bounded evidence.
use crate::{
    clock,
    egress::{HostEvidence, Live, Policy},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use canaveral_guest_protocol::{
    data::{self, Budget, ErrorCode, Flows, Frame, Sender},
    proxy::{target, Target},
};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    net::{IpAddr, Shutdown, TcpStream},
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use uuid::Uuid;
type Connected = (Uuid, std::result::Result<(TcpStream, IpAddr), ErrorCode>);
type Result<T> = canaveral_guest_protocol::Result<T>;
const TURN: usize = 65536;
/// Clone must create an independent evidence/query context. No ambient proxy or DNS at connect.
pub trait Egress: HostEvidence + Clone + Send + 'static {
    fn resolve(
        &mut self,
        name: &str,
        timeout: Duration,
    ) -> std::result::Result<Vec<IpAddr>, ErrorCode>;
    fn connect(
        &mut self,
        address: IpAddr,
        port: u16,
        timeout: Duration,
    ) -> std::result::Result<TcpStream, ErrorCode>;
    /// Native providers require this check. Test transports may explicitly map a vetted IP to loopback.
    fn peer_matches(&self, stream: &TcpStream, address: IpAddr, port: u16) -> bool {
        stream
            .peer_addr()
            .is_ok_and(|p| p.ip() == address && p.port() == port)
    }
}
/// Production remains denied until a native provider is explicitly installed.
#[derive(Clone)]
pub struct Deny;
impl HostEvidence for Deny {
    fn evidence(&mut self, _: IpAddr) -> std::result::Result<crate::egress::Evidence, ErrorCode> {
        Err(ErrorCode::RouteDenied)
    }
}
impl Egress for Deny {
    fn resolve(&mut self, _: &str, _: Duration) -> std::result::Result<Vec<IpAddr>, ErrorCode> {
        Err(ErrorCode::EgressDenied)
    }
    fn connect(
        &mut self,
        _: IpAddr,
        _: u16,
        _: Duration,
    ) -> std::result::Result<TcpStream, ErrorCode> {
        Err(ErrorCode::EgressDenied)
    }
}
#[derive(Clone)]
pub struct Authority {
    deadline_ms: Arc<AtomicU64>,
    revoked: Arc<AtomicBool>,
}
impl Authority {
    pub fn new(deadline: Duration) -> Self {
        Self {
            deadline_ms: Arc::new(AtomicU64::new(
                deadline.as_millis().min(u64::MAX as u128) as u64
            )),
            revoked: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn renew(&self, deadline: Duration) {
        self.deadline_ms.store(
            deadline.as_millis().min(u64::MAX as u128) as u64,
            Ordering::Release,
        );
    }
    pub fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }
    pub fn permits(&self) -> bool {
        !self.revoked.load(Ordering::Acquire)
            && clock::now().as_millis() < self.deadline_ms.load(Ordering::Acquire) as u128
    }
}
/// Positive evidence only after the reactor and every connect worker have joined.
#[derive(Clone, Copy, Debug, Default)]
pub struct Closed {
    pub sockets: bool,
    pub workers: bool,
    pub relay: bool,
}
impl Closed {
    pub fn complete(self) -> bool {
        self.sockets && self.workers && self.relay
    }
}
pub struct Handle {
    pub authority: Authority,
    requests: SyncSender<Frame>,
    cancel: SyncSender<Frame>,
    pub receipts: Receiver<Frame>,
    pub ready: Arc<AtomicBool>,
    worker: Option<JoinHandle<Closed>>,
}
impl Handle {
    /// Internal assignment routing seam; no local consumer listener is exposed.
    pub fn send_transfer(&self, frame: Frame) -> Result<()> {
        frame.validate(Sender::Host)?;
        match frame {
            Frame::TransferCancel { .. } => self
                .cancel
                .try_send(frame)
                .map_err(|_| "cancel slot occupied".into()),
            Frame::TransferRequest { .. } => self
                .requests
                .try_send(frame)
                .map_err(|_| "transfer slot occupied".into()),
            _ => Err("not a transfer command".into()),
        }
    }
    pub fn shutdown(&mut self) -> Closed {
        self.authority.revoke();
        let start = std::time::Instant::now();
        while self.worker.as_ref().is_some_and(|w| !w.is_finished())
            && start.elapsed() < Duration::from_secs(2)
        {
            thread::sleep(Duration::from_millis(2));
        }
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished) {
            self.worker.take().unwrap().join().unwrap_or_default()
        } else {
            self.worker.take(); // detach once; Drop must not wait another two seconds
            Closed::default()
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.shutdown();
        }
    }
}
struct Socket {
    stream: Option<TcpStream>,
    pending: VecDeque<u8>,
    credit: u64,
    seq: u64,
    read_eof: bool,
    write_eof: bool,
    progress: clock::Clock,
}
struct Output {
    bytes: Vec<u8>,
    offset: usize,
    decoded: u64,
}
pub struct Reactor<E: Egress> {
    relay: UnixStream,
    decoder: data::Decoder,
    provider: E,
    policy: Arc<Policy>,
    enabled: bool,
    authority: Authority,
    flows: Flows,
    sockets: BTreeMap<Uuid, Socket>,
    live: Live,
    receipt_tx: Option<SyncSender<Frame>>,
    transfer: Option<(Uuid, u64)>,
    budget: Budget,
    output: VecDeque<Output>,
    workers: Vec<JoinHandle<()>>,
    workers_ok: bool,
    turn: usize,
    connected_tx: SyncSender<Connected>,
    connected: Receiver<Connected>,
}
impl<E: Egress> Reactor<E> {
    pub fn new(
        relay: UnixStream,
        provider: E,
        policy: Policy,
        enabled: bool,
        authority: Authority,
    ) -> Result<Self> {
        relay.set_nonblocking(true)?;
        let (connected_tx, connected) = mpsc::sync_channel(16);
        let mut budget = Budget::default();
        budget.reserve(TURN as u64, data::MAX_FRAME + 4)?; // bounded receipt lane and parser
        Ok(Self {
            relay,
            decoder: Default::default(),
            provider,
            policy: Arc::new(policy),
            enabled,
            authority,
            flows: Default::default(),
            sockets: BTreeMap::new(),
            live: Default::default(),
            receipt_tx: None,
            transfer: None,
            budget,
            output: VecDeque::new(),
            workers: Vec::new(),
            workers_ok: true,
            turn: 0,
            connected_tx,
            connected,
        })
    }
    fn queue(&mut self, frame: Frame, decoded: u64) -> Result<()> {
        let bytes = data::encode(&frame, Sender::Host)?;
        // Leave a complete control frame available independently of payload accounting.
        let used: usize = self.output.iter().map(|o| o.bytes.len()).sum();
        if used + bytes.len() > data::ENCODED_BUDGET - data::MAX_FRAME - 4 {
            return Err("encoded queue full".into());
        }
        self.budget.reserve(decoded, bytes.len())?;
        self.output.push_back(Output {
            bytes,
            offset: 0,
            decoded,
        });
        Ok(())
    }
    fn retire(&mut self, id: Uuid, error: Option<ErrorCode>) -> Result<()> {
        if self.flows.close(id, &mut self.budget)? {
            if let Some(s) = self.sockets.remove(&id).and_then(|s| s.stream) {
                let _ = s.shutdown(Shutdown::Both);
            }
            self.live.remove(id);
            self.queue(
                match error {
                    Some(code) => Frame::Error {
                        version: 1,
                        id,
                        code,
                    },
                    None => Frame::Close { version: 1, id },
                },
                0,
            )?;
        }
        Ok(())
    }
    fn frame(&mut self, frame: Frame) -> Result<()> {
        match frame {
            Frame::Open { id, host, port, .. } => {
                self.flows.open(id)?;
                self.sockets.insert(
                    id,
                    Socket {
                        stream: None,
                        pending: VecDeque::new(),
                        credit: 0,
                        seq: 0,
                        read_eof: false,
                        write_eof: false,
                        progress: clock::Clock::now(),
                    },
                );
                let refusal = if !self.enabled || !self.authority.permits() {
                    Some(ErrorCode::EgressDenied)
                } else if port != 443 {
                    Some(ErrorCode::PortDenied)
                } else {
                    target(&host).err()
                };
                if let Some(code) = refusal {
                    return self.retire(id, Some(code));
                }
                // Bound both live and retired-but-still-running connection workers.
                self.reap();
                if self.workers.len() >= 16 {
                    return self.retire(id, Some(ErrorCode::Limit));
                }
                let (mut provider, policy, authority, tx) = (
                    self.provider.clone(),
                    self.policy.clone(),
                    self.authority.clone(),
                    self.connected_tx.clone(),
                );
                self.workers.push(thread::spawn(move || {
                    let result = connect(&mut provider, &policy, &authority, &host, port);
                    let _ = tx.try_send((id, result));
                }));
            }
            Frame::Data { id, seq, data, .. } => {
                let bytes = data::payload(&data, false)?;
                self.flows.direction(id, Sender::Guest)?; // opened and ID validation
                let s = self.sockets.get_mut(&id).ok_or("unknown flow")?;
                self.flows
                    .direction(id, Sender::Guest)?
                    .receive(seq, bytes.len() as u64)?;
                s.pending.extend(bytes);
            }
            Frame::Credit { id, bytes, .. } => {
                self.flows.direction(id, Sender::Host)?;
                let s = self.sockets.get_mut(&id).ok_or("unknown flow")?;
                s.credit = s
                    .credit
                    .checked_add(bytes)
                    .filter(|n| *n <= data::MAX_CREDIT)
                    .ok_or("excess credit")?;
                if s.read_eof {
                    return Err("credit after half close".into());
                }
            }
            Frame::HalfClose { id, .. } => {
                self.flows.direction(id, Sender::Guest)?;
                self.flows
                    .direction(id, Sender::Guest)?
                    .half_close(&mut self.budget)?;
            }
            Frame::Close { id, .. } => {
                self.retire(id, None)?;
            }
            Frame::TransferReceipt { id, step, .. } => {
                if self.transfer != Some((id, step)) {
                    return Err("unexpected transfer receipt".into());
                }
                self.receipt_tx
                    .as_ref()
                    .ok_or("receipt handler missing")?
                    .try_send(frame)
                    .map_err(|_| "receipt handler full")?;
                self.transfer = None;
            }
            _ => return Err("unexpected data frame".into()),
        }
        Ok(())
    }
    fn reap(&mut self) {
        let mut i = 0;
        while i < self.workers.len() {
            if self.workers[i].is_finished() {
                self.workers_ok &= self.workers.swap_remove(i).join().is_ok();
            } else {
                i += 1;
            }
        }
    }
    pub fn step(&mut self) -> Result<()> {
        if !self.authority.permits() {
            return Err("authority lost".into());
        }
        self.reap();
        for (id, code) in self.live.revalidate(
            clock::now().as_millis().min(u64::MAX as u128) as u64,
            &self.policy,
            &mut self.provider,
        ) {
            self.retire(id, Some(code))?;
        }
        while let Ok((id, result)) = self.connected.try_recv() {
            if !self.sockets.contains_key(&id) {
                continue;
            }
            match result {
                Ok((stream, ip)) => {
                    if !self.authority.permits() {
                        return Err("authority lost".into());
                    }
                    if self.policy.recheck(ip, &mut self.provider).is_err() {
                        self.retire(id, Some(ErrorCode::RouteDenied))?;
                        continue;
                    }
                    stream.set_nonblocking(true)?;
                    self.live.pin(id, ip).map_err(|_| "live limit")?;
                    self.flows.opened(id)?;
                    let s = self.sockets.get_mut(&id).unwrap();
                    s.stream = Some(stream);
                    s.progress = clock::Clock::now();
                    self.flows
                        .direction(id, Sender::Guest)?
                        .grant(TURN as u64, &mut self.budget)?;
                    self.queue(Frame::Opened { version: 1, id }, 0)?;
                    self.queue(
                        Frame::Credit {
                            version: 1,
                            id,
                            bytes: TURN as u64,
                        },
                        0,
                    )?;
                }
                Err(code) => self.retire(id, Some(code))?,
            }
        }
        let mut buf = [0; TURN];
        let mut remaining = TURN;
        while remaining > 0 {
            let want = self.decoder.needed().min(remaining);
            match self.relay.read(&mut buf[..want]) {
                Ok(0) => return Err("data lost".into()),
                Ok(n) => {
                    remaining -= n;
                    if let Some(f) = self.decoder.feed(&buf[..n], Sender::Guest)? {
                        self.frame(f)?;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        // One bounded turn per live flow, even when another flow has no credit.
        let mut ids: Vec<_> = self.sockets.keys().copied().collect();
        if !ids.is_empty() {
            let start = self.turn % ids.len();
            ids.rotate_left(start);
            self.turn = self.turn.wrapping_add(1);
        }
        for id in ids {
            let s = self.sockets.get_mut(&id).unwrap();
            if s.progress.elapsed()
                >= Duration::from_secs(if s.stream.is_some() { 120 } else { 10 })
            {
                let code = if s.stream.is_some() {
                    ErrorCode::IdleTimeout
                } else {
                    ErrorCode::ConnectTimeout
                };
                self.retire(id, Some(code))?;
                continue;
            }
            let Some(stream) = s.stream.as_mut() else {
                continue;
            };
            let mut frames = Vec::new();
            let mut failed = false;
            let mut payload_remaining = TURN;
            if !s.pending.is_empty() {
                let bytes = s.pending.make_contiguous();
                let end = bytes.len().min(TURN);
                match stream.write(&bytes[..end]) {
                    Ok(0) => failed = true,
                    Ok(n) => {
                        payload_remaining -= n;
                        s.pending.drain(..n);
                        self.flows
                            .direction(id, Sender::Guest)?
                            .consumed(n as u64, &mut self.budget)?;
                        s.progress = clock::Clock::now();
                        if !self.flows.direction(id, Sender::Guest)?.drained() && !s.write_eof {
                            // half-closed directions cannot receive new credit
                            if self
                                .flows
                                .direction(id, Sender::Guest)?
                                .grant(n as u64, &mut self.budget)
                                .is_ok()
                            {
                                frames.push(Frame::Credit {
                                    version: 1,
                                    id,
                                    bytes: n as u64,
                                });
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => failed = true,
                }
            }
            if self.flows.direction(id, Sender::Guest)?.drained() && !s.write_eof {
                stream.shutdown(Shutdown::Write)?;
                s.write_eof = true;
            }
            if !s.read_eof
                && s.credit > 0
                && payload_remaining > 0
                && self.budget.reserve(TURN as u64, 0).is_ok()
            {
                let want = payload_remaining.min(s.credit as usize);
                match stream.read(&mut buf[..want]) {
                    Ok(0) => {
                        s.read_eof = true;
                        frames.push(Frame::HalfClose { version: 1, id });
                    }
                    Ok(n) => {
                        s.credit -= n as u64;
                        frames.push(Frame::Data {
                            version: 1,
                            id,
                            seq: s.seq,
                            data: STANDARD.encode(&buf[..n]),
                        });
                        s.seq += 1;
                        s.progress = clock::Clock::now();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => failed = true,
                }
                self.budget.release(TURN as u64, 0)?;
            }
            let done = s.write_eof && s.read_eof;
            for f in frames {
                let n = if let Frame::Data { ref data, .. } = f {
                    data::payload(data, false)?.len() as u64
                } else {
                    0
                };
                self.queue(f, n)?;
            }
            if failed || done {
                self.retire(id, failed.then_some(ErrorCode::ConnectFailed))?;
            }
        }
        let mut remaining = TURN;
        while let Some(o) = self.output.front_mut() {
            if remaining == 0 {
                break;
            }
            match self
                .relay
                .write(&o.bytes[o.offset..o.bytes.len().min(o.offset + remaining)])
            {
                Ok(0) => return Err("data lost".into()),
                Ok(n) => {
                    o.offset += n;
                    remaining -= n;
                    if o.offset == o.bytes.len() {
                        let o = self.output.pop_front().unwrap();
                        self.budget.release(o.decoded, o.bytes.len())?;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
    fn close(mut self) -> Closed {
        for s in self.sockets.values_mut() {
            if let Some(stream) = s.stream.take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        self.sockets.clear();
        let _ = self.relay.shutdown(Shutdown::Both);
        // Late connects observe revoked authority and drop their sockets. Joining is
        // bounded by Handle, which reports incomplete evidence if a provider stalls.
        self.authority.revoke();
        for worker in self.workers.drain(..) {
            if worker.join().is_err() {
                return Closed::default();
            }
        }
        while self.connected.try_recv().is_ok() {}
        Closed {
            sockets: true,
            workers: self.workers_ok,
            relay: true,
        }
    }
}
fn connect<E: Egress>(
    provider: &mut E,
    policy: &Policy,
    authority: &Authority,
    host: &str,
    port: u16,
) -> std::result::Result<(TcpStream, IpAddr), ErrorCode> {
    let start = clock::Clock::now();
    let remaining = || {
        Duration::from_secs(10)
            .checked_sub(start.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or(ErrorCode::ConnectTimeout)
    };
    let answers = match target(host)? {
        Target::Address(ip) => vec![ip],
        Target::Name(name) => provider.resolve(&name, remaining()?)?,
    };
    let answers = policy.answers(host, port, true, authority.permits(), &answers, provider)?;
    let mut error = ErrorCode::ConnectFailed;
    for ip in answers {
        if !authority.permits() {
            return Err(ErrorCode::EgressDenied);
        }
        policy.recheck(ip, provider)?;
        match provider.connect(ip, port, remaining()?) {
            Ok(stream) => {
                remaining()?;
                if !authority.permits() {
                    return Err(ErrorCode::EgressDenied);
                }
                if !provider.peer_matches(&stream, ip, port) {
                    return Err(ErrorCode::ConnectFailed);
                }
                policy.recheck(ip, provider)?;
                return Ok((stream, ip));
            }
            Err(e) => error = e,
        }
    }
    Err(error)
}
/// Runs the authenticated session and reactor on a separate thread from supervision.
pub fn spawn<E: Egress>(
    mut session: crate::data::Session,
    provider: E,
    policy: Policy,
    enabled: bool,
    authority: Authority,
) -> Handle {
    session.enable_handoff();
    let (requests, rx) = mpsc::sync_channel(1);
    let (cancel, cx) = mpsc::sync_channel(1);
    let (tx, receipts) = mpsc::sync_channel(1);
    let ready = Arc::new(AtomicBool::new(false));
    let flag = ready.clone();
    let auth = authority.clone();
    let worker = thread::spawn(move || {
        while auth.permits() && !session.ready() {
            if session.pump().is_err() {
                return Closed {
                    sockets: true,
                    workers: true,
                    relay: true,
                };
            }
            thread::sleep(Duration::from_millis(2));
        }
        if !auth.permits() {
            return Closed {
                sockets: true,
                workers: true,
                relay: true,
            };
        }
        let Some(stream) = session.take_ready_stream() else {
            return Closed::default();
        };
        let Ok(mut reactor) = Reactor::new(stream, provider, policy, enabled, auth) else {
            return Closed::default();
        };

        reactor.receipt_tx = Some(tx);
        loop {
            if let Ok(f) = cx.try_recv() {
                let bytes = match data::encode(&f, Sender::Host) {
                    Ok(b) => b,
                    Err(_) => break,
                };
                // A cancel can bypass queued payload, but never a partially written frame.
                let pos = usize::from(reactor.output.front().is_some_and(|o| o.offset > 0));
                if reactor.budget.reserve(0, bytes.len()).is_err() {
                    break;
                }
                reactor.output.insert(
                    pos,
                    Output {
                        bytes,
                        offset: 0,
                        decoded: 0,
                    },
                );
            }
            if let Ok(f) = rx.try_recv() {
                if reactor.transfer.is_some() {
                    break;
                }
                if let Frame::TransferRequest { id, step, .. } = &f {
                    reactor.transfer = Some((*id, *step));
                }
                if reactor.queue(f, 0).is_err() {
                    break;
                }
            }
            if reactor.step().is_err() {
                break;
            }
            flag.store(true, Ordering::Release);
            thread::sleep(Duration::from_millis(2));
        }
        reactor.close()
    });
    Handle {
        authority,
        requests,
        cancel,
        receipts,
        ready,
        worker: Some(worker),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::egress::Evidence;
    use std::net::TcpListener;
    #[derive(Clone)]
    struct Fake {
        listener: Arc<TcpListener>,
        denied: Arc<AtomicBool>,
        resolves: Arc<AtomicU64>,
    }
    impl HostEvidence for Fake {
        fn evidence(&mut self, _: IpAddr) -> std::result::Result<Evidence, ErrorCode> {
            if self.denied.load(Ordering::Acquire) {
                return Err(ErrorCode::RouteDenied);
            }
            Ok(Evidence {
                interfaces: vec!["127.0.0.1".parse().unwrap()],
                prefix: 0,
                gateway: true,
                direct: false,
            })
        }
    }
    impl Egress for Fake {
        fn resolve(&mut self, _: &str, _: Duration) -> std::result::Result<Vec<IpAddr>, ErrorCode> {
            self.resolves.fetch_add(1, Ordering::Relaxed);
            Ok(vec!["8.8.8.8".parse().unwrap()])
        }
        fn connect(
            &mut self,
            _: IpAddr,
            _: u16,
            timeout: Duration,
        ) -> std::result::Result<TcpStream, ErrorCode> {
            TcpStream::connect_timeout(&self.listener.local_addr().unwrap(), timeout)
                .map_err(|_| ErrorCode::ConnectFailed)
        }
        fn peer_matches(&self, _: &TcpStream, _: IpAddr, _: u16) -> bool {
            true
        }
    }
    fn setup(enabled: bool) -> (Reactor<Fake>, UnixStream, Fake) {
        let (host, peer) = UnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        let fake = Fake {
            listener: Arc::new(TcpListener::bind("127.0.0.1:0").unwrap()),
            denied: Arc::new(AtomicBool::new(false)),
            resolves: Arc::new(AtomicU64::new(0)),
        };
        let r = Reactor::new(
            host,
            fake.clone(),
            Policy::new(&[]).unwrap(),
            enabled,
            Authority::new(clock::now() + Duration::from_secs(300)),
        )
        .unwrap();
        (r, peer, fake)
    }
    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }
    fn open(r: &mut Reactor<Fake>, n: u128) {
        r.frame(Frame::Open {
            version: 1,
            id: id(n),
            host: "8.8.8.8".into(),
            port: 443,
        })
        .unwrap();
        for _ in 0..100 {
            r.step().unwrap();
            if r.sockets.get(&id(n)).is_some_and(|s| s.stream.is_some()) {
                return;
            }
            thread::sleep(Duration::from_millis(1));
        }
        panic!("connect did not finish");
    }
    fn collect(peer: &mut UnixStream) -> Vec<Frame> {
        let mut decoder = data::Decoder::default();
        let mut result = Vec::new();
        let mut buf = [0; TURN];
        loop {
            let want = decoder.needed().min(TURN);
            match peer.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(f) = decoder.feed(&buf[..n], Sender::Host).unwrap() {
                        result.push(f);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("{e}"),
            }
        }
        result
    }
    #[test]
    fn grant_port_answers_sequence_and_budget_fail_closed() {
        let (mut r, _, _) = setup(false);
        r.frame(Frame::Open {
            version: 1,
            id: id(1),
            host: "8.8.8.8".into(),
            port: 443,
        })
        .unwrap();
        assert!(matches!(
            serde_json::from_slice::<Frame>(&r.output[0].bytes[4..]).unwrap(),
            Frame::Error {
                code: ErrorCode::EgressDenied,
                ..
            }
        ));
        let (mut r, mut peer, _) = setup(true);
        r.frame(Frame::Open {
            version: 1,
            id: id(1),
            host: "8.8.8.8".into(),
            port: 80,
        })
        .unwrap();
        r.step().unwrap();
        assert!(matches!(
            collect(&mut peer)[0],
            Frame::Error {
                code: ErrorCode::PortDenied,
                ..
            }
        ));
        open(&mut r, 2);
        assert!(r
            .frame(Frame::Data {
                version: 1,
                id: id(2),
                seq: 1,
                data: STANDARD.encode(b"x")
            })
            .is_err());
        assert!(r
            .frame(Frame::Credit {
                version: 1,
                id: id(2),
                bytes: data::MAX_CREDIT + 1
            })
            .is_err());
        assert!(r.budget.reserve(data::DECODED_BUDGET, 0).is_err());
        assert!(r.budget.reserve(0, data::ENCODED_BUDGET).is_err());
        assert!(r.close().complete());
    }
    #[test]
    fn real_tcp_echo_half_close_and_live_route_denial() {
        let (mut r, mut peer, fake) = setup(true);
        open(&mut r, 1);
        assert_eq!(fake.resolves.load(Ordering::Relaxed), 0); // literals never resolve
        let (mut tcp, _) = fake.listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        r.frame(Frame::Credit {
            version: 1,
            id: id(1),
            bytes: TURN as u64,
        })
        .unwrap();
        r.frame(Frame::Data {
            version: 1,
            id: id(1),
            seq: 0,
            data: STANDARD.encode(b"hello"),
        })
        .unwrap();
        r.frame(Frame::HalfClose {
            version: 1,
            id: id(1),
        })
        .unwrap();
        r.step().unwrap();
        let mut body = Vec::new();
        tcp.read_to_end(&mut body).unwrap();
        assert_eq!(body, b"hello");
        tcp.write_all(&body).unwrap();
        tcp.shutdown(Shutdown::Write).unwrap();
        let mut frames = collect(&mut peer);
        for _ in 0..20 {
            r.step().unwrap();
            frames.extend(collect(&mut peer));
            if !r.sockets.contains_key(&id(1)) {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert!(frames
            .iter()
            .any(|f| matches!(f, Frame::Data { data, .. } if data == &STANDARD.encode(b"hello"))));
        assert!(frames.iter().any(|f| matches!(f, Frame::HalfClose { .. })));
        assert!(r.sockets.is_empty());
        open(&mut r, 2);
        fake.denied.store(true, Ordering::Release);
        clock::advance(Duration::from_secs(2));
        r.step().unwrap();
        clock::advance(Duration::ZERO);
        assert!(r.sockets.is_empty());
        assert!(collect(&mut peer).iter().any(|f| matches!(
            f,
            Frame::Error {
                code: ErrorCode::RouteDenied,
                ..
            }
        )));
        assert!(r.close().complete());
    }
    #[test]
    fn fairness_credit_stall_idle_retired_and_disconnect() {
        let (mut r, mut peer, fake) = setup(true);
        open(&mut r, 1);
        let (mut a, _) = fake.listener.accept().unwrap();
        open(&mut r, 2);
        let (mut b, _) = fake.listener.accept().unwrap();
        a.write_all(b"stalled").unwrap();
        b.write_all(b"progress").unwrap();
        r.frame(Frame::Credit {
            version: 1,
            id: id(2),
            bytes: TURN as u64,
        })
        .unwrap();
        for _ in 0..10 {
            r.step().unwrap();
            thread::sleep(Duration::from_millis(1));
        }
        let frames = collect(&mut peer);
        assert!(frames
            .iter()
            .any(|f| matches!(f, Frame::Data { id: i, .. } if *i == id(2))));
        assert!(!frames
            .iter()
            .any(|f| matches!(f, Frame::Data { id: i, .. } if *i == id(1))));
        clock::advance(Duration::from_secs(121));
        r.step().unwrap();
        clock::advance(Duration::ZERO);
        assert!(r.sockets.is_empty());
        r.frame(Frame::Close {
            version: 1,
            id: id(2),
        })
        .unwrap();
        assert!(r
            .frame(Frame::Close {
                version: 1,
                id: id(99)
            })
            .is_err());
        drop(peer);
        assert!(r.step().is_err());
        assert!(r.close().complete());
    }
}
