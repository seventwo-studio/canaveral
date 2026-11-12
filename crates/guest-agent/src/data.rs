//! Independent bounded data plane. No error here may close the control stream.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use crate::runtime::{nonblock, now};
use base64::{engine::general_purpose::STANDARD, Engine};
use canaveral_guest_protocol::{
    bundle::WorkspaceLaunch,
    data::{self, Budget, Decoder, Direction, Flows, Frame, Receipt, Replay, Sender, Step},
    proxy::{self, HeaderError, Target},
    Result,
};
use std::{
    collections::VecDeque,
    fs::File,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    os::fd::AsRawFd,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use uuid::Uuid;

/// Temporary dispatch seam: remove when the confined file executor is connected.
/// Satellite v2 admission must remain disabled while this is true.
const FILE_EXECUTOR_NOT_IMPLEMENTED: bool = true;

fn dispatch(replay: &mut Replay, frame: Frame) -> Result<Option<Frame>> {
    match frame {
        Frame::TransferRequest {
            id,
            step,
            request,
            remaining_ms,
            ..
        } => {
            let receipt = match replay.begin(id, step, request, remaining_ms, now())? {
                Step::Replay(receipt) => receipt.clone(),
                Step::Execute if FILE_EXECUTOR_NOT_IMPLEMENTED => {
                    let receipt = Receipt::Failed {
                        code: "io_error".into(),
                    };
                    replay.complete(receipt.clone())?;
                    receipt
                }
                Step::Execute => return Err("file executor missing".into()),
            };
            Ok(Some(Frame::TransferReceipt {
                version: 1,
                id,
                step,
                receipt,
            }))
        }
        Frame::TransferCancel { id, .. } => {
            replay.cancel(id);
            Ok(None)
        }
        _ => Err("not a transfer frame".into()),
    }
}
pub(crate) fn handshake(frame: Frame, launch: &WorkspaceLaunch) -> Result<Frame> {
    frame.validate(Sender::Host)?;
    match frame {
        Frame::DataHello { binding, nonce, .. }
            if binding == launch.binding && nonce == launch.data.nonce =>
        {
            Ok(Frame::DataReady {
                version: 1,
                binding,
                nonce,
            })
        }
        _ => Err("data launch binding or nonce mismatch".into()),
    }
}
fn response(status: u16, code: &str) -> Vec<u8> {
    let reason = match status {
        200 => "Connection Established",
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Bad Gateway",
    };
    if status == 200 {
        return format!("HTTP/1.1 {status} {reason}\r\n\r\n").into_bytes();
    }
    format!(
        "HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{code}",
        code.len()
    )
    .into_bytes()
}
fn header_error(error: HeaderError) -> Vec<u8> {
    match error {
        HeaderError::Method => response(405, "method_not_allowed"),
        HeaderError::Invalid => response(400, "invalid_target"),
        HeaderError::Policy(code) => error_response(code),
    }
}
fn error_response(code: data::ErrorCode) -> Vec<u8> {
    let code_text = serde_json::to_string(&code).expect("fixed error code");
    response(code.http_status(), code_text.trim_matches('"'))
}
struct Client {
    socket: TcpStream,
    header: Vec<u8>,
    id: Option<Uuid>,
    opened: bool,
    response: Vec<u8>,
    response_sent: usize,
    terminal: bool,
    received: Vec<u8>,
    delivered: usize,
    receive: Direction,
    send_credit: u64,
    send_sequence: u64,
    local_eof: bool,
    remote_eof: bool,
    send_turn: bool,
    started: u64,
    progress: u64,
}
impl Client {
    fn new(socket: TcpStream) -> Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self {
            socket,
            header: Vec::new(),
            id: None,
            opened: false,
            response: Vec::new(),
            response_sent: 0,
            terminal: false,
            received: Vec::new(),
            delivered: 0,
            receive: Direction::default(),
            send_credit: 0,
            send_sequence: 0,
            local_eof: false,
            remote_eof: false,
            send_turn: false,
            started: now(),
            progress: now(),
        })
    }
}
/// One payload frame and one reserved control frame are retained. The latter can
/// progress even when all proxy receive credit is committed.
struct Output {
    bytes: Vec<u8>,
    offset: usize,
    control: Option<Vec<u8>>,
}
impl Output {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            offset: 0,
            control: None,
        }
    }
    fn idle(&self) -> bool {
        self.bytes.is_empty() && self.control.is_none()
    }
    fn queue(&mut self, frame: Frame) -> Result<()> {
        let bytes = data::encode(&frame, Sender::Guest)?;
        if !self.bytes.is_empty() {
            if self.control.is_some() || matches!(frame, Frame::Data { .. }) {
                return Err("data output slots occupied".into());
            }
            self.control = Some(bytes);
        } else {
            self.bytes = bytes;
            self.offset = 0;
        }
        Ok(())
    }
    fn flush(&mut self, socket: &mut File) -> Result<()> {
        if self.idle() {
            return Ok(());
        }
        match socket.write(&self.bytes[self.offset..]) {
            Ok(0) => return Err("data disconnected".into()),
            Ok(n) => self.offset += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
            Err(e) => return Err(e.into()),
        }
        if self.offset == self.bytes.len() {
            self.bytes = self.control.take().unwrap_or_default();
            self.offset = 0;
        }
        Ok(())
    }
}
/// Set only after dataReady is fully written. Cleared on every exit, including
/// parser errors. The boot latch is separate: later loss must not revoke commands.
pub(crate) struct Readiness {
    pub files: AtomicBool,
    pub initial: AtomicBool,
    pub stop: AtomicBool,
}
impl Readiness {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            files: AtomicBool::new(false),
            initial: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        })
    }
}
pub(crate) fn session(
    mut socket: File,
    proxy: TcpListener,
    launch: &WorkspaceLaunch,
    ready: &Readiness,
) -> Result<()> {
    struct Withdraw<'a>(&'a Readiness);
    impl Drop for Withdraw<'_> {
        fn drop(&mut self) {
            self.0.files.store(false, Ordering::Release);
        }
    }
    let _withdraw = Withdraw(ready);
    nonblock(socket.as_raw_fd())?;
    proxy.set_nonblocking(true)?;
    let mut decoder = Decoder::default();
    let mut output = Output::new();
    let mut clients = VecDeque::<Client>::new();
    let mut flows = Flows::default();
    let mut budget = Budget::default();
    // Fixed parser/output slots plus all 16 bounded HTTP headers remain far
    // below the 8 MiB ceiling, independently of the 4 MiB decoded budget.
    budget.reserve(
        2 * data::MAX_CHUNK as u64,
        4 * (data::MAX_FRAME + 4) + 16 * 8192,
    )?;
    let mut replay = Replay::default();
    let mut hello = false;
    let mut next_id = 0u128;
    let connected = now();
    loop {
        if ready.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if !hello && now() - connected >= 5000 {
            return Err("data hello deadline".into());
        }
        output.flush(&mut socket)?;
        if hello && output.idle() && !ready.initial.load(Ordering::Acquire) {
            ready.files.store(true, Ordering::Release);
            ready.initial.store(true, Ordering::Release);
        }
        // Read with the reserved response slot free, even if a payload write
        // is stalled, so cancellation never depends on producer credit.
        if output.control.is_none() {
            let mut buffer = [0; 65536];
            let wanted = decoder.needed().min(buffer.len());
            match socket.read(&mut buffer[..wanted]) {
                Ok(0) => return Err("data disconnected".into()),
                Ok(n) => {
                    if let Some(frame) = decoder.feed(&buffer[..n], Sender::Host)? {
                        if !hello {
                            output.queue(handshake(frame, launch)?)?;
                            hello = true;
                        } else {
                            match frame {
                                Frame::TransferRequest { .. } | Frame::TransferCancel { .. } => {
                                    if let Some(receipt) = dispatch(&mut replay, frame)? {
                                        output.queue(receipt)?;
                                    }
                                }
                                Frame::Close { id, .. } => {
                                    if flows.close(id, &mut budget)? {
                                        if let Some(c) =
                                            clients.iter_mut().find(|c| c.id == Some(id))
                                        {
                                            if !c.remote_eof {
                                                c.receive.half_close(&mut budget)?;
                                            }
                                            c.receive.consumed(
                                                (c.received.len() - c.delivered) as u64,
                                                &mut budget,
                                            )?;
                                        }
                                        clients.retain(|c| c.id != Some(id));
                                        output.queue(Frame::Close { version: 1, id })?;
                                    }
                                }
                                Frame::Error { id, code, .. } => {
                                    if flows.close(id, &mut budget)? {
                                        let c = clients
                                            .iter_mut()
                                            .find(|c| c.id == Some(id))
                                            .ok_or("unknown client")?;
                                        // Direction owns the decoded credit, separate from ID registry.
                                        if !c.remote_eof {
                                            c.receive.half_close(&mut budget)?;
                                        }
                                        c.receive.consumed(
                                            (c.received.len() - c.delivered) as u64,
                                            &mut budget,
                                        )?;
                                        c.received.clear();
                                        c.delivered = 0;
                                        c.id = None;
                                        if c.opened {
                                            c.terminal = true;
                                            c.response.clear();
                                        } else {
                                            c.response = error_response(code);
                                            c.terminal = true;
                                        }
                                    }
                                }
                                Frame::Opened { id, .. } => {
                                    flows.opened(id)?;
                                    let c = clients
                                        .iter_mut()
                                        .find(|c| c.id == Some(id))
                                        .ok_or("unknown client")?;
                                    c.opened = true;
                                    c.response = response(200, "");
                                }
                                Frame::Credit { id, bytes, .. } => {
                                    flows.direction(id, Sender::Guest)?;
                                    let c = clients
                                        .iter_mut()
                                        .find(|c| c.id == Some(id))
                                        .ok_or("unknown client")?;
                                    if c.local_eof || c.send_credit + bytes > data::MAX_CREDIT {
                                        return Err("invalid send credit".into());
                                    }
                                    c.send_credit += bytes;
                                }
                                Frame::Data { id, seq, data, .. } => {
                                    flows.direction(id, Sender::Host)?;
                                    let c = clients
                                        .iter_mut()
                                        .find(|c| c.id == Some(id))
                                        .ok_or("unknown client")?;
                                    let bytes = data::payload(&data, false)?;
                                    c.receive.receive(seq, bytes.len() as u64)?;
                                    c.received.extend(bytes);
                                    c.progress = now();
                                }
                                Frame::HalfClose { id, .. } => {
                                    flows.direction(id, Sender::Host)?;
                                    let c = clients
                                        .iter_mut()
                                        .find(|c| c.id == Some(id))
                                        .ok_or("unknown client")?;
                                    c.receive.half_close(&mut budget)?;
                                    c.remote_eof = true;
                                }
                                _ => return Err("unexpected data frame".into()),
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(e) => return Err(e.into()),
            }
        }
        if ready.initial.load(Ordering::Acquire) && clients.len() < 16 {
            match proxy.accept() {
                Ok((socket, _)) => clients.push_back(Client::new(socket)?),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(e) => return Err(e.into()),
            }
        }
        // A rotating cursor ensures each flow moves at most 64 KiB each turn.
        let turns = clients.len().min(1);
        for _ in 0..turns {
            let mut c = clients.pop_front().unwrap();
            let mut retire = false;
            c.send_turn = !c.send_turn;
            let mut moved = 0;
            if c.response_sent < c.response.len() {
                match c.socket.write(&c.response[c.response_sent..]) {
                    Ok(0) => retire = true,
                    Ok(n) => c.response_sent += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                    Err(_) => retire = true,
                }
            } else if c.terminal {
                retire = true;
            } else if output.idle() {
                if let Some(id) = c.id {
                    if (!c.opened && now() - c.started >= 10000) || now() - c.progress >= 120000 {
                        if !c.opened {
                            c.response = response(504, "connect_timeout");
                            c.response_sent = 0;
                            c.terminal = true;
                        } else {
                            retire = true;
                        }
                        if !retire {
                            flows.close(id, &mut budget)?;
                            output.queue(Frame::Close { version: 1, id })?;
                            c.id = None;
                        }
                    } else if c.opened {
                        // Deliver first, returning credit only after bytes leave memory.
                        let remaining = c.received.len() - c.delivered;
                        if remaining != 0 && !(c.send_turn && c.send_credit != 0 && !c.local_eof) {
                            let end = c.delivered + remaining.min(data::MAX_CHUNK);
                            match c.socket.write(&c.received[c.delivered..end]) {
                                Ok(0) => retire = true,
                                Ok(n) => {
                                    moved += n;
                                    c.delivered += n;
                                    c.progress = now();
                                    c.receive.consumed(n as u64, &mut budget)?;
                                    if !c.remote_eof {
                                        c.receive.grant(n as u64, &mut budget)?;
                                        output.queue(Frame::Credit {
                                            version: 1,
                                            id,
                                            bytes: n as u64,
                                        })?;
                                    }
                                    c.received.drain(..c.delivered);
                                    c.delivered = 0;
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                                Err(_) => retire = true,
                            }
                        } else if c.remote_eof && remaining == 0 {
                            let _ = c.socket.shutdown(Shutdown::Write);
                            if c.local_eof {
                                retire = true;
                            }
                        } else {
                            // Start with one 64 KiB receive window per flow.
                            // Subsequent credit is returned by the delivery path.
                            if c.received.capacity() == 0 {
                                c.receive.grant(data::MAX_CHUNK as u64, &mut budget)?;
                                c.received.reserve_exact(data::MAX_CHUNK);
                                output.queue(Frame::Credit {
                                    version: 1,
                                    id,
                                    bytes: data::MAX_CHUNK as u64,
                                })?;
                            }
                        }
                        if !retire
                            && moved == 0
                            && output.idle()
                            && !c.local_eof
                            && c.send_credit != 0
                        {
                            let mut bytes = [0; data::MAX_CHUNK];
                            let count = (c.send_credit as usize).min(bytes.len());
                            match c.socket.read(&mut bytes[..count]) {
                                Ok(0) => {
                                    c.local_eof = true;
                                    output.queue(Frame::HalfClose { version: 1, id })?;
                                }
                                Ok(n) => {
                                    c.send_credit -= n as u64;
                                    c.progress = now();
                                    output.queue(Frame::Data {
                                        version: 1,
                                        id,
                                        seq: c.send_sequence,
                                        data: STANDARD.encode(&bytes[..n]),
                                    })?;
                                    c.send_sequence += 1;
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                                Err(_) => retire = true,
                            }
                        }
                    }
                } else if c.header.len() == 8192 || now() - c.started >= 5000 {
                    c.response = response(400, "invalid_target");
                    c.terminal = true;
                } else {
                    let mut bytes = [0; 8192];
                    let count = bytes.len() - c.header.len();
                    match c.socket.read(&mut bytes[..count]) {
                        Ok(0) => retire = true,
                        Ok(n) => {
                            c.header.extend_from_slice(&bytes[..n]);
                            if c.header.windows(4).any(|w| w == b"\r\n\r\n") {
                                match proxy::connect(&c.header, launch.egress.enabled) {
                                    Ok((target, port)) => {
                                        next_id =
                                            next_id.checked_add(1).ok_or("flow ID exhausted")?;
                                        let id = Uuid::from_u128(next_id);
                                        flows.open(id)?;
                                        let host = match target {
                                            Target::Address(ip) => ip.to_string(),
                                            Target::Name(name) => name,
                                        };
                                        output.queue(Frame::Open {
                                            version: 1,
                                            id,
                                            host,
                                            port,
                                        })?;
                                        c.id = Some(id);
                                        c.started = now();
                                    }
                                    Err(error) => {
                                        c.response = header_error(error);
                                        c.terminal = true;
                                    }
                                }
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                        Err(_) => retire = true,
                    }
                }
            }
            if retire && c.id.is_some() && !output.idle() {
                // Keep ownership until the terminal frame can be queued.
                c.terminal = true;
                clients.push_back(c);
            } else if retire {
                if let Some(id) = c.id {
                    if !c.remote_eof {
                        c.receive.half_close(&mut budget)?;
                    }
                    c.receive
                        .consumed((c.received.len() - c.delivered) as u64, &mut budget)?;
                    flows.close(id, &mut budget)?;
                    output.queue(Frame::Close { version: 1, id })?;
                }
            } else {
                clients.push_back(c);
            }
        }
        // Polling is independent of control and bounded at 10ms. Writable
        // sockets are tried once per turn, avoiding a POLLOUT busy loop.
        let mut poll = libc::pollfd {
            fd: socket.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 10) } < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::Interrupted {
                return Err(e.into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::fd::{FromRawFd, IntoRawFd},
        os::unix::net::UnixStream,
        time::Duration,
    };
    fn launch() -> WorkspaceLaunch {
        serde_json::from_slice(include_bytes!(
            "../../guest-protocol/fixtures/launch-v2.json"
        ))
        .unwrap()
    }
    fn send(socket: &mut impl Write, frame: Frame) {
        socket
            .write_all(&data::encode(&frame, Sender::Host).unwrap())
            .unwrap();
    }
    fn receive(socket: &mut impl Read) -> Frame {
        let mut decoder = Decoder::default();
        loop {
            let mut bytes = vec![0; decoder.needed()];
            socket.read_exact(&mut bytes).unwrap();
            if let Some(frame) = decoder.feed(&bytes, Sender::Guest).unwrap() {
                return frame;
            }
        }
    }
    #[test]
    fn exact_initial_handshake() {
        let launch = launch();
        let hello = || Frame::DataHello {
            version: 1,
            binding: launch.binding.clone(),
            nonce: launch.data.nonce.clone(),
        };
        assert!(
            matches!(handshake(hello(), &launch).unwrap(), Frame::DataReady { binding, nonce, .. } if binding == launch.binding && nonce == launch.data.nonce)
        );
        let mut wrong = launch.clone();
        wrong.binding.revision += 1;
        assert!(handshake(hello(), &wrong).is_err());
        wrong = launch.clone();
        wrong.data.nonce = "f".repeat(64);
        assert!(handshake(hello(), &wrong).is_err());
        assert!(handshake(
            Frame::Close {
                version: 1,
                id: Uuid::from_u128(1)
            },
            &launch
        )
        .is_err());
    }
    #[test]
    fn header_grammar_and_fixed_statuses() {
        for (header, enabled, status) in [
            ("GET / HTTP/1.1\r\n\r\n", true, 405),
            ("CONNECT example.com:22 HTTP/1.1\r\n\r\n", true, 403),
            ("CONNECT example.com:443 HTTP/1.1\r\n\r\n", false, 403),
            ("CONNECT user@example.com:443 HTTP/1.1\r\n\r\n", true, 400),
            (
                "CONNECT example.com:443 HTTP/1.1\r\nHost: other.com:443\r\n\r\n",
                true,
                400,
            ),
        ] {
            let result = header_error(proxy::connect(header.as_bytes(), enabled).unwrap_err());
            assert!(String::from_utf8(result)
                .unwrap()
                .starts_with(&format!("HTTP/1.1 {status} ")));
        }
        for (code, status) in [
            (data::ErrorCode::Limit, 503),
            (data::ErrorCode::ConnectFailed, 502),
            (data::ErrorCode::ConnectTimeout, 504),
        ] {
            assert!(String::from_utf8(error_response(code))
                .unwrap()
                .starts_with(&format!("HTTP/1.1 {status} ")));
        }
        assert!(proxy::connect(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", true).is_ok());
    }
    fn pair(
        enabled: bool,
    ) -> (
        UnixStream,
        std::net::SocketAddr,
        Arc<Readiness>,
        std::thread::JoinHandle<String>,
    ) {
        let (host, guest) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = proxy.local_addr().unwrap();
        let ready = Readiness::new();
        let state = ready.clone();
        let mut launch = launch();
        launch.egress.enabled = enabled;
        let worker = std::thread::spawn(move || {
            let file = unsafe { File::from_raw_fd(guest.into_raw_fd()) };
            session(file, proxy, &launch, &state)
                .unwrap_err()
                .to_string()
        });
        (host, address, ready, worker)
    }
    fn hello(host: &mut UnixStream) {
        let launch = launch();
        send(
            host,
            Frame::DataHello {
                version: 1,
                binding: launch.binding,
                nonce: launch.data.nonce,
            },
        );
        assert!(matches!(receive(host), Frame::DataReady { .. }));
    }
    fn tunnel(address: std::net::SocketAddr) -> TcpStream {
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        client
    }
    #[test]
    fn relay_credit_half_close_and_data_loss() {
        let (mut host, address, ready, worker) = pair(true);
        hello(&mut host);
        let mut client = tunnel(address);
        let id = match receive(&mut host) {
            Frame::Open { id, port: 443, .. } => id,
            _ => panic!(),
        };
        send(&mut host, Frame::Opened { version: 1, id });
        let mut header = [0; 39];
        let expected = b"HTTP/1.1 200 Connection Established\r\n\r\n";
        client.read_exact(&mut header[..expected.len()]).unwrap();
        assert_eq!(&header[..expected.len()], expected);
        assert!(matches!(
            receive(&mut host),
            Frame::Credit { bytes: 65536, .. }
        ));
        send(
            &mut host,
            Frame::Data {
                version: 1,
                id,
                seq: 0,
                data: STANDARD.encode(b"host"),
            },
        );
        let mut payload = [0; 4];
        client.read_exact(&mut payload).unwrap();
        assert_eq!(&payload, b"host");
        assert!(matches!(receive(&mut host), Frame::Credit { bytes: 4, .. }));
        send(
            &mut host,
            Frame::Credit {
                version: 1,
                id,
                bytes: 4,
            },
        );
        client.write_all(b"guest").unwrap();
        assert!(
            matches!(receive(&mut host), Frame::Data { seq: 0, data, .. } if data == STANDARD.encode(b"gues"))
        );
        send(&mut host, Frame::HalfClose { version: 1, id });
        assert_eq!(client.read(&mut payload).unwrap(), 0);
        drop(host);
        assert!(worker.join().unwrap().contains("disconnected"));
        assert!(!ready.files.load(Ordering::Acquire));
        assert!(ready.initial.load(Ordering::Acquire));
    }
    #[test]
    fn sequence_violation_withdraws_only_data_readiness() {
        let (mut host, address, ready, worker) = pair(true);
        // An independent control socket remains usable across data failure.
        let (mut control, mut control_peer) = UnixStream::pair().unwrap();
        hello(&mut host);
        let _client = tunnel(address);
        let id = match receive(&mut host) {
            Frame::Open { id, .. } => id,
            _ => panic!(),
        };
        send(&mut host, Frame::Opened { version: 1, id });
        assert!(matches!(receive(&mut host), Frame::Credit { .. }));
        send(
            &mut host,
            Frame::Data {
                version: 1,
                id,
                seq: 1,
                data: STANDARD.encode(b"x"),
            },
        );
        assert!(worker.join().unwrap().contains("sequence"));
        assert!(!ready.files.load(Ordering::Acquire));
        control.write_all(b"ok").unwrap();
        let mut bytes = [0; 2];
        control_peer.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ok");
    }
    #[test]
    fn two_ready_producers_both_progress() {
        let (mut host, address, _, worker) = pair(true);
        hello(&mut host);
        let mut a = tunnel(address);
        let mut b = tunnel(address);
        let mut ids = Vec::new();
        for _ in 0..2 {
            match receive(&mut host) {
                Frame::Open { id, .. } => ids.push(id),
                _ => panic!(),
            }
        }
        assert!(ids[0] < ids[1]);
        for id in &ids {
            send(
                &mut host,
                Frame::Opened {
                    version: 1,
                    id: *id,
                },
            );
        }
        for _ in 0..2 {
            assert!(matches!(receive(&mut host), Frame::Credit { .. }));
        }
        for id in &ids {
            send(
                &mut host,
                Frame::Credit {
                    version: 1,
                    id: *id,
                    bytes: 65536,
                },
            );
        }
        a.write_all(&[1; 65536]).unwrap();
        b.write_all(&[2; 65536]).unwrap();
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..2 {
            match receive(&mut host) {
                Frame::Data { id, data, .. } => {
                    assert!(data::payload(&data, false).unwrap().len() <= 65536);
                    seen.insert(id);
                }
                _ => panic!(),
            }
        }
        assert_eq!(seen.len(), 2);
        drop(host);
        assert!(worker.join().unwrap().contains("disconnected"));
    }
    #[test]
    fn credit_budget_and_retired_id_bounds() {
        let mut budget = Budget::default();
        let mut directions: Vec<Direction> = (0..16).map(|_| Direction::default()).collect();
        for d in &mut directions {
            d.grant(data::MAX_CREDIT, &mut budget).unwrap();
        }
        assert!(Direction::default().grant(1, &mut budget).is_err());
        assert!(directions[0]
            .receive(0, data::MAX_CHUNK as u64 + 1)
            .is_err());
        assert!(directions[0].grant(1, &mut budget).is_err());
        directions[0].receive(0, 1).unwrap();
        directions[0].consumed(1, &mut budget).unwrap();
        directions[0].half_close(&mut budget).unwrap();
        assert!(directions[0].receive(1, 1).is_err());
        let mut flows = Flows::default();
        for n in 1..=16 {
            flows.open(Uuid::from_u128(n)).unwrap();
        }
        assert!(flows.open(Uuid::from_u128(17)).is_err());
        let id = Uuid::from_u128(1);
        assert!(flows.close(id, &mut budget).unwrap());
        assert!(!flows.close(id, &mut budget).unwrap());
        flows.open(Uuid::from_u128(17)).unwrap();
        assert!(flows.close(id, &mut budget).is_err());
        assert!(flows.open(id).is_err());
    }
    #[test]
    fn denied_grant_opens_no_flow() {
        let (mut host, address, _, worker) = pair(false);
        hello(&mut host);
        let mut client = tunnel(address);
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 403 "));
        assert!(response.ends_with("egress_denied"));
        drop(host);
        assert!(worker.join().unwrap().contains("disconnected"));
    }
    #[test]
    fn dispatch_seam_replays_and_rejects_changed_request() {
        let mut replay = Replay::default();
        let id = Uuid::from_u128(1);
        let frame = || Frame::TransferRequest {
            version: 1,
            id,
            step: 1,
            request: data::Request::Abort,
            remaining_ms: 1000,
        };
        assert!(
            matches!(dispatch(&mut replay, frame()).unwrap(), Some(Frame::TransferReceipt { receipt: Receipt::Failed { code }, .. }) if code == "io_error")
        );
        assert!(dispatch(&mut replay, frame()).unwrap().is_some());
        assert!(dispatch(
            &mut replay,
            Frame::TransferRequest {
                version: 1,
                id,
                step: 3,
                request: data::Request::Abort,
                remaining_ms: 1000
            }
        )
        .is_err());
    }
}
