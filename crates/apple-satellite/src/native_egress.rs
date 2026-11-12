//! Native primitives only: callers must vet every terminal answer with
//! `Policy::answers` and refresh evidence before and after each connection.
use crate::egress::{Evidence, HostEvidence};
use canaveral_guest_protocol::data::ErrorCode;
use std::{
    ffi::CString,
    mem::{size_of, zeroed},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

pub struct NativeHost;
impl HostEvidence for NativeHost {
    fn evidence(&mut self, address: IpAddr) -> Result<Evidence, ErrorCode> {
        let interfaces = interfaces()?;
        let (prefix, gateway, direct) = route(address)?;
        Ok(Evidence {
            interfaces,
            prefix,
            gateway,
            direct,
        })
    }
}

// The kernel owns the list until freeifaddrs. Null addresses on link-only records
// are normal; malformed IP records or an empty IP list are not complete evidence.
fn interfaces() -> Result<Vec<IpAddr>, ErrorCode> {
    struct List(*mut libc::ifaddrs);
    impl Drop for List {
        fn drop(&mut self) {
            unsafe { libc::freeifaddrs(self.0) }
        }
    }
    let mut head = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Err(ErrorCode::RouteDenied);
    }
    let list = List(head);
    let mut next = list.0;
    let mut result = Vec::new();
    let mut count = 0;
    while !next.is_null() {
        count += 1;
        if count > 65536 {
            return Err(ErrorCode::RouteDenied);
        }
        let entry = unsafe { &*next };
        if !entry.ifa_addr.is_null() {
            let family = unsafe { (*entry.ifa_addr).sa_family as i32 };
            if family == libc::AF_INET || family == libc::AF_INET6 {
                #[cfg(target_os = "macos")]
                if unsafe { (*entry.ifa_addr).sa_len as usize }
                    < if family == libc::AF_INET {
                        size_of::<libc::sockaddr_in>()
                    } else {
                        size_of::<libc::sockaddr_in6>()
                    }
                {
                    return Err(ErrorCode::RouteDenied);
                }
                let ip = unsafe { ip_from_sockaddr(entry.ifa_addr, family) };
                if !result.contains(&ip) {
                    result.push(ip);
                }
            }
        }
        next = entry.ifa_next;
    }
    if result.is_empty() {
        Err(ErrorCode::RouteDenied)
    } else {
        Ok(result)
    }
}

// Callers guarantee a complete sockaddr of the specified IP family.
unsafe fn ip_from_sockaddr(sa: *const libc::sockaddr, family: i32) -> IpAddr {
    if family == libc::AF_INET {
        let sa = unsafe { std::ptr::read_unaligned(sa.cast::<libc::sockaddr_in>()) };
        Ipv4Addr::from(sa.sin_addr.s_addr.to_ne_bytes()).into()
    } else {
        let sa = unsafe { std::ptr::read_unaligned(sa.cast::<libc::sockaddr_in6>()) };
        Ipv6Addr::from(sa.sin6_addr.s6_addr).into()
    }
}

fn sockaddr(address: IpAddr, port: u16) -> (libc::sockaddr_storage, libc::socklen_t) {
    let mut storage: libc::sockaddr_storage = unsafe { zeroed() };
    let len = match address {
        IpAddr::V4(ip) => {
            let mut sa: libc::sockaddr_in = unsafe { zeroed() };
            sa.sin_family = libc::AF_INET as _;
            sa.sin_port = port.to_be();
            sa.sin_addr.s_addr = u32::from_ne_bytes(ip.octets());
            #[cfg(target_os = "macos")]
            {
                sa.sin_len = size_of::<libc::sockaddr_in>() as _;
            }
            unsafe { std::ptr::write((&mut storage as *mut libc::sockaddr_storage).cast(), sa) };
            size_of::<libc::sockaddr_in>()
        }
        IpAddr::V6(ip) => {
            let mut sa: libc::sockaddr_in6 = unsafe { zeroed() };
            sa.sin6_family = libc::AF_INET6 as _;
            sa.sin6_port = port.to_be();
            sa.sin6_addr.s6_addr = ip.octets();
            #[cfg(target_os = "macos")]
            {
                sa.sin6_len = size_of::<libc::sockaddr_in6>() as _;
            }
            unsafe { std::ptr::write((&mut storage as *mut libc::sockaddr_storage).cast(), sa) };
            size_of::<libc::sockaddr_in6>()
        }
    };
    (storage, len as _)
}

fn socket(domain: i32, kind: i32, protocol: i32) -> Result<OwnedFd, ErrorCode> {
    let fd = unsafe { libc::socket(domain, kind, protocol) };
    if fd < 0 {
        return Err(ErrorCode::ConnectFailed);
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(ErrorCode::ConnectFailed);
    }
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(ErrorCode::ConnectFailed);
    }
    Ok(fd)
}

fn wait(fd: &OwnedFd, events: i16, deadline: Instant) -> Result<(), ErrorCode> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(ErrorCode::ConnectTimeout)?;
        let millis = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events,
            revents: 0,
        };
        let n = unsafe { libc::poll(&mut poll, 1, millis) };
        if n > 0 {
            if poll.revents & libc::POLLNVAL != 0 {
                return Err(ErrorCode::ConnectFailed);
            }
            return if Instant::now() < deadline {
                Ok(())
            } else {
                Err(ErrorCode::ConnectTimeout)
            };
        }
        if n < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err(ErrorCode::ConnectFailed);
        }
    }
}

/// Connects only to this sockaddr; returns a blocking stream with TCP_NODELAY.
/// The caller supplies the remaining shared resolution/connect budget and must
/// apply policy checks before this call and after it, before exposing the stream.
pub fn connect(address: IpAddr, port: u16, timeout: Duration) -> Result<TcpStream, ErrorCode> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(ErrorCode::ConnectTimeout)?;
    if timeout.is_zero() {
        return Err(ErrorCode::ConnectTimeout);
    }
    let fd = socket(
        if address.is_ipv4() {
            libc::AF_INET
        } else {
            libc::AF_INET6
        },
        libc::SOCK_STREAM,
        0,
    )?;
    let (sa, len) = sockaddr(address, port);
    if unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&sa as *const libc::sockaddr_storage).cast(),
            len,
        )
    } != 0
    {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EINPROGRESS) | Some(libc::EINTR) => wait(&fd, libc::POLLOUT, deadline)?,
            Some(libc::ETIMEDOUT) => return Err(ErrorCode::ConnectTimeout),
            _ => return Err(ErrorCode::ConnectFailed),
        }
        let mut error: i32 = 0;
        let mut len = size_of::<i32>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut i32).cast(),
                &mut len,
            )
        } != 0
            || error != 0
        {
            return Err(if error == libc::ETIMEDOUT {
                ErrorCode::ConnectTimeout
            } else {
                ErrorCode::ConnectFailed
            });
        }
    }
    let stream = TcpStream::from(fd);
    // peer_addr is getpeername, including the port and IPv6 scope/flow fields.
    if stream.peer_addr().map_err(|_| ErrorCode::ConnectFailed)? != SocketAddr::new(address, port) {
        return Err(ErrorCode::ConnectFailed);
    }
    stream
        .set_nodelay(true)
        .map_err(|_| ErrorCode::ConnectFailed)?;
    stream
        .set_nonblocking(false)
        .map_err(|_| ErrorCode::ConnectFailed)?;
    if Instant::now() >= deadline {
        return Err(ErrorCode::ConnectTimeout);
    }
    Ok(stream)
}

static LOOKUPS: std::sync::LazyLock<Arc<AtomicUsize>> =
    std::sync::LazyLock::new(|| Arc::new(AtomicUsize::new(0)));
struct LookupPermit(Arc<AtomicUsize>);
impl Drop for LookupPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
fn bounded_lookup<F>(
    timeout: Duration,
    count: Arc<AtomicUsize>,
    lookup: F,
) -> Result<Vec<IpAddr>, ErrorCode>
where
    F: FnOnce() -> Result<Vec<IpAddr>, ErrorCode> + Send + 'static,
{
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(ErrorCode::ConnectTimeout)?;
    if timeout.is_zero() {
        return Err(ErrorCode::ConnectTimeout);
    }
    let mut current = count.load(Ordering::Acquire);
    loop {
        if current >= 4 {
            return Err(ErrorCode::Limit);
        }
        match count.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
    let permit = LookupPermit(count);
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("egress-dns".into())
        .spawn(move || {
            let _permit = permit; // Retained even after the caller times out.
            let _ = tx.send(lookup());
        })
        .map_err(|_| ErrorCode::Limit)?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or(ErrorCode::ConnectTimeout)?;
    let result = rx.recv_timeout(remaining).map_err(|e| match e {
        mpsc::RecvTimeoutError::Timeout => ErrorCode::ConnectTimeout,
        _ => ErrorCode::DestinationDenied,
    })?;
    if Instant::now() >= deadline {
        return Err(ErrorCode::ConnectTimeout);
    }
    result
}

/// Resolves a validated lowercase FQDN as an absolute name, without AI_ADDRCONFIG.
/// At most four libc workers exist, including timed-out, detached lookups. libc
/// cannot be safely cancelled: a stuck worker retains its slot until it exits.
/// This returns untrusted terminal answers; vet all of them with Policy::answers.
pub fn resolve(name: &str, timeout: Duration) -> Result<Vec<IpAddr>, ErrorCode> {
    let name = absolute_name(name)?;
    bounded_lookup(timeout, LOOKUPS.clone(), move || lookup(&name))
}
fn absolute_name(name: &str) -> Result<CString, ErrorCode> {
    let name = name.strip_suffix('.').unwrap_or(name);
    // Defense in depth; the upstream target parser is authoritative.
    if name.is_empty()
        || name.ends_with('.')
        || name
            .bytes()
            .any(|b| !(b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.'))
    {
        return Err(ErrorCode::DestinationDenied);
    }
    match canaveral_guest_protocol::proxy::target(name) {
        Ok(canaveral_guest_protocol::proxy::Target::Name(absolute)) => {
            CString::new(absolute).map_err(|_| ErrorCode::DestinationDenied)
        }
        _ => Err(ErrorCode::DestinationDenied),
    }
}
fn lookup(name: &CString) -> Result<Vec<IpAddr>, ErrorCode> {
    struct Addresses(*mut libc::addrinfo);
    impl Drop for Addresses {
        fn drop(&mut self) {
            unsafe { libc::freeaddrinfo(self.0) }
        }
    }
    let mut hints: libc::addrinfo = unsafe { zeroed() };
    hints.ai_family = libc::AF_UNSPEC;
    hints.ai_socktype = libc::SOCK_STREAM;
    let mut head = std::ptr::null_mut();
    if unsafe { libc::getaddrinfo(name.as_ptr(), std::ptr::null(), &hints, &mut head) } != 0 {
        return Err(ErrorCode::DestinationDenied);
    }
    let list = Addresses(head);
    // The list remains owned by Addresses throughout traversal.
    unsafe { collect_answers(list.0) }
}
unsafe fn collect_answers(mut next: *const libc::addrinfo) -> Result<Vec<IpAddr>, ErrorCode> {
    let mut result = Vec::new();
    let mut count = 0;
    while !next.is_null() {
        count += 1;
        if count > 4096 {
            return Err(ErrorCode::DestinationDenied);
        }
        let ai = unsafe { &*next };
        let expected = match ai.ai_family {
            libc::AF_INET => size_of::<libc::sockaddr_in>(),
            libc::AF_INET6 => size_of::<libc::sockaddr_in6>(),
            _ => return Err(ErrorCode::DestinationDenied),
        };
        if ai.ai_addr.is_null()
            || ai.ai_addrlen as usize != expected
            || unsafe { (*ai.ai_addr).sa_family as i32 } != ai.ai_family
        {
            return Err(ErrorCode::DestinationDenied);
        }
        let ip = unsafe { ip_from_sockaddr(ai.ai_addr, ai.ai_family) };
        if !result.contains(&ip) {
            result.push(ip);
        }
        if result.len() > 64 {
            return Err(ErrorCode::DestinationDenied);
        }
        next = ai.ai_next;
    }
    if result.is_empty() {
        Err(ErrorCode::DestinationDenied)
    } else {
        Ok(result)
    }
}

#[cfg(not(target_os = "macos"))]
fn route(_: IpAddr) -> Result<(u8, bool, bool), ErrorCode> {
    Err(ErrorCode::RouteDenied)
}

#[cfg(target_os = "macos")]
fn route(address: IpAddr) -> Result<(u8, bool, bool), ErrorCode> {
    route_query(address).map_err(|_| ErrorCode::RouteDenied)
}
#[cfg(target_os = "macos")]
fn route_query(address: IpAddr) -> Result<(u8, bool, bool), ErrorCode> {
    static SEQUENCE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(1);
    let deadline = Instant::now() + Duration::from_secs(1);
    let fd = socket(libc::PF_ROUTE, libc::SOCK_RAW, 0)?;
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = unsafe { libc::getpid() };
    let (sa, len) = sockaddr(address, 0);
    let mut header: libc::rt_msghdr = unsafe { zeroed() };
    header.rtm_msglen = (size_of::<libc::rt_msghdr>() + len as usize) as _;
    header.rtm_version = libc::RTM_VERSION as _;
    header.rtm_type = libc::RTM_GET as _;
    header.rtm_addrs = libc::RTA_DST;
    header.rtm_seq = seq;
    header.rtm_pid = pid;
    let mut request = Vec::new();
    request.extend_from_slice(unsafe {
        std::slice::from_raw_parts(
            (&header as *const libc::rt_msghdr).cast::<u8>(),
            size_of::<libc::rt_msghdr>(),
        )
    });
    request.extend_from_slice(unsafe {
        std::slice::from_raw_parts(
            (&sa as *const libc::sockaddr_storage).cast::<u8>(),
            len as usize,
        )
    });
    if unsafe { libc::send(fd.as_raw_fd(), request.as_ptr().cast(), request.len(), 0) }
        != request.len() as isize
    {
        return Err(ErrorCode::RouteDenied);
    }
    wait(&fd, libc::POLLIN, deadline)?;
    let mut reply = [0u8; 8192];
    let n = unsafe { libc::recv(fd.as_raw_fd(), reply.as_mut_ptr().cast(), reply.len(), 0) };
    if n <= 0 || n as usize == reply.len() {
        return Err(ErrorCode::RouteDenied);
    }
    parse_route(&reply[..n as usize], address, seq, pid)
}

#[cfg(target_os = "macos")]
fn parse_route(
    bytes: &[u8],
    address: IpAddr,
    seq: i32,
    pid: i32,
) -> Result<(u8, bool, bool), ErrorCode> {
    let deny = ErrorCode::RouteDenied;
    if bytes.len() < size_of::<libc::rt_msghdr>() {
        return Err(deny);
    }
    let header = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<libc::rt_msghdr>()) };
    if header.rtm_msglen as usize != bytes.len()
        || header.rtm_version as i32 != libc::RTM_VERSION
        || header.rtm_type as i32 != libc::RTM_GET
        || header.rtm_seq != seq
        || header.rtm_pid != pid
        || header.rtm_errno != 0
        || header.rtm_flags & libc::RTF_UP == 0
        || header.rtm_flags
            & (libc::RTF_REJECT | libc::RTF_BLACKHOLE | libc::RTF_DEAD | libc::RTF_CONDEMNED)
            != 0
        || header.rtm_addrs & !((1 << libc::RTAX_MAX) - 1) != 0
    {
        return Err(deny);
    }
    let mut offset = size_of::<libc::rt_msghdr>();
    let mut slots = [None; libc::RTAX_MAX as usize];
    for (i, slot) in slots.iter_mut().enumerate() {
        if header.rtm_addrs & (1 << i) == 0 {
            continue;
        }
        let len = *bytes.get(offset).ok_or(deny)? as usize;
        // Darwin routing sockaddrs use 32-bit alignment, including on arm64.
        let padded = if len == 0 { 4 } else { (len + 3) & !3 };
        let end = offset
            .checked_add(padded)
            .filter(|end| *end <= bytes.len())
            .ok_or(deny)?;
        if len == 1 {
            return Err(deny);
        }
        *slot = Some(&bytes[offset..offset + len]);
        offset = end;
    }
    if offset != bytes.len() {
        return Err(deny);
    }
    let dst = route_ip(slots[libc::RTAX_DST as usize].ok_or(deny)?, address)?;
    let width = if address.is_ipv4() { 32 } else { 128 };
    let prefix = match slots[libc::RTAX_NETMASK as usize] {
        Some(mask) => mask_prefix(mask, address)?,
        None if header.rtm_flags & libc::RTF_HOST != 0 => width,
        None => return Err(deny),
    };
    if header.rtm_flags & libc::RTF_HOST != 0 && prefix != width {
        return Err(deny);
    }
    let (dst, target) = match (dst, address) {
        (IpAddr::V4(a), IpAddr::V4(b)) => (u32::from(a) as u128, u32::from(b) as u128),
        (IpAddr::V6(a), IpAddr::V6(b)) => (u128::from(a), u128::from(b)),
        _ => return Err(deny),
    };
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (width - prefix)
    };
    if dst & mask != target & mask || dst & !mask != 0 {
        return Err(deny);
    }
    let gateway = header.rtm_flags & libc::RTF_GATEWAY != 0;
    if gateway {
        let ip = route_ip(slots[libc::RTAX_GATEWAY as usize].ok_or(deny)?, address)?;
        if ip.is_unspecified() {
            return Err(deny);
        }
    }
    let direct = !gateway
        || header.rtm_flags
            & (libc::RTF_HOST | libc::RTF_LLINFO | libc::RTF_WASCLONED | libc::RTF_LOCAL)
            != 0;
    Ok((prefix, gateway, direct))
}
#[cfg(target_os = "macos")]
fn route_ip(bytes: &[u8], address: IpAddr) -> Result<IpAddr, ErrorCode> {
    let (family, size) = if address.is_ipv4() {
        (libc::AF_INET, size_of::<libc::sockaddr_in>())
    } else {
        (libc::AF_INET6, size_of::<libc::sockaddr_in6>())
    };
    if bytes.len() != size || bytes[1] as i32 != family {
        return Err(ErrorCode::RouteDenied);
    }
    Ok(unsafe { ip_from_sockaddr(bytes.as_ptr().cast(), family) })
}
#[cfg(target_os = "macos")]
fn mask_prefix(bytes: &[u8], address: IpAddr) -> Result<u8, ErrorCode> {
    let (family, offset, width, size) = if address.is_ipv4() {
        (libc::AF_INET, 4, 4, size_of::<libc::sockaddr_in>())
    } else {
        (libc::AF_INET6, 8, 16, size_of::<libc::sockaddr_in6>())
    };
    if !bytes.is_empty()
        && (bytes.len() < 2
            || bytes.len() > size
            || (bytes[1] != 0
                && bytes[1] as i32 != family
                && !(address.is_ipv4() && bytes == [8, 255, 255, 255, 255, 255, 255, 255])))
    {
        return Err(ErrorCode::RouteDenied);
    }
    let mut prefix = 0;
    let mut zero = false;
    for i in 0..width {
        let byte = bytes.get(offset + i).copied().unwrap_or(0);
        for bit in (0..8).rev() {
            if byte & (1 << bit) == 0 {
                zero = true;
            } else if zero {
                return Err(ErrorCode::RouteDenied);
            } else {
                prefix += 1;
            }
        }
    }
    Ok(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[test]
    fn absolute_names_and_no_search_fallback() {
        for name in ["example.com", "example.com."] {
            assert_eq!(absolute_name(name).unwrap().to_bytes(), b"example.com.");
        }
        for name in [
            "localhost",
            "example.com..",
            "Example.com",
            "127.0.0.1",
            "host.local",
            "a..com",
            "bad\0.example",
        ] {
            assert_eq!(
                absolute_name(name).unwrap_err(),
                ErrorCode::DestinationDenied
            );
        }
    }

    #[test]
    fn terminal_answers_dedupe_overflow_and_incomplete_records() {
        let addresses: Vec<_> = (0..65)
            .map(|n| sockaddr(Ipv4Addr::new(8, 8, 8, n).into(), 0))
            .collect();
        let mut records: Vec<libc::addrinfo> = (0..65).map(|_| unsafe { zeroed() }).collect();
        let base = records.as_mut_ptr();
        for (i, record) in records.iter_mut().enumerate() {
            record.ai_family = libc::AF_INET;
            record.ai_addrlen = addresses[i].1;
            record.ai_addr = (&addresses[i].0 as *const libc::sockaddr_storage)
                .cast_mut()
                .cast();
            if i + 1 < 65 {
                record.ai_next = unsafe { base.add(i + 1) };
            }
        }
        assert_eq!(
            unsafe { collect_answers(base) },
            Err(ErrorCode::DestinationDenied)
        );
        records[63].ai_next = std::ptr::null_mut();
        assert_eq!(unsafe { collect_answers(base) }.unwrap().len(), 64);
        records[1].ai_addr = records[0].ai_addr;
        assert_eq!(unsafe { collect_answers(base) }.unwrap().len(), 63);
        records[1].ai_addrlen = 1;
        assert_eq!(
            unsafe { collect_answers(base) },
            Err(ErrorCode::DestinationDenied)
        );
        records[1].ai_addrlen = addresses[1].1;
        records[1].ai_addr = std::ptr::null_mut();
        assert_eq!(
            unsafe { collect_answers(base) },
            Err(ErrorCode::DestinationDenied)
        );
        assert_eq!(
            unsafe { collect_answers(std::ptr::null()) },
            Err(ErrorCode::DestinationDenied)
        );
    }

    #[test]
    fn lookup_timeouts_keep_all_four_slots_until_workers_exit() {
        let count = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = mpsc::channel();
        let mut releases = Vec::new();
        for _ in 0..4 {
            let (tx, rx) = mpsc::channel();
            releases.push(tx);
            let done = done_tx.clone();
            assert_eq!(
                bounded_lookup(Duration::from_millis(20), count.clone(), move || {
                    rx.recv().unwrap();
                    done.send(()).unwrap();
                    Ok(vec![Ipv4Addr::LOCALHOST.into()])
                }),
                Err(ErrorCode::ConnectTimeout)
            );
        }
        assert_eq!(count.load(Ordering::Acquire), 4);
        assert_eq!(
            bounded_lookup(Duration::from_secs(1), count.clone(), || panic!(
                "over capacity"
            )),
            Err(ErrorCode::Limit)
        );
        for release in releases {
            release.send(()).unwrap();
        }
        for _ in 0..4 {
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        while count.load(Ordering::Acquire) != 0 {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert_eq!(
            bounded_lookup(Duration::from_secs(1), count.clone(), || Err(
                ErrorCode::DestinationDenied
            )),
            Err(ErrorCode::DestinationDenied)
        );
        assert_eq!(
            bounded_lookup(Duration::ZERO, count, || panic!("zero timeout")),
            Err(ErrorCode::ConnectTimeout)
        );
    }

    #[test]
    fn loopback_connect_peer_nodelay_refusal_and_timeout() {
        for ip in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ] {
            let listener = TcpListener::bind(SocketAddr::new(ip, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let mut stream = connect(ip, address.port(), Duration::from_secs(1)).unwrap();
            assert_eq!(stream.peer_addr().unwrap(), address);
            assert!(stream.nodelay().unwrap());
            let (mut accepted, _) = listener.accept().unwrap();
            accepted.write_all(b"ok").unwrap();
            let mut bytes = [0; 2];
            stream.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"ok");
            drop(listener);
            assert_eq!(
                connect(ip, address.port(), Duration::from_secs(1)).unwrap_err(),
                ErrorCode::ConnectFailed
            );
            assert_eq!(
                connect(ip, address.port(), Duration::ZERO).unwrap_err(),
                ErrorCode::ConnectTimeout
            );
        }
        // An idle socket pair deterministically exercises the same poll deadline
        // used by an EINPROGRESS connection, without sending off-host traffic.
        let (idle, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let idle: OwnedFd = idle.into();
        assert_eq!(
            wait(
                &idle,
                libc::POLLIN,
                Instant::now() + Duration::from_millis(10)
            ),
            Err(ErrorCode::ConnectTimeout)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fresh_interfaces_and_kernel_route_evidence() {
        let assigned = interfaces().unwrap();
        assert!(assigned.contains(&Ipv4Addr::LOCALHOST.into()));
        assert!(assigned.contains(&Ipv6Addr::LOCALHOST.into()));
        let evidence = NativeHost.evidence(Ipv4Addr::LOCALHOST.into()).unwrap();
        assert!(evidence.prefix > 0 && evidence.direct && !evidence.gateway);
        assert!(crate::egress::Policy::new(&[])
            .unwrap()
            .address(Ipv4Addr::LOCALHOST.into(), &evidence)
            .is_err());
        // RTM_GET is a local kernel query, not an internet probe. A cloned or
        // scoped host route may be refused, but must never masquerade as default.
        match NativeHost.evidence("1.1.1.1".parse().unwrap()) {
            Ok(e) => assert_eq!((e.prefix, e.gateway, e.direct), (0, true, false)),
            Err(e) => assert_eq!(e, ErrorCode::RouteDenied),
        }
    }

    #[cfg(target_os = "macos")]
    fn reply(dst: IpAddr, mask: &[u8], flags: i32) -> Vec<u8> {
        let mut header: libc::rt_msghdr = unsafe { zeroed() };
        header.rtm_version = libc::RTM_VERSION as _;
        header.rtm_type = libc::RTM_GET as _;
        header.rtm_flags = libc::RTF_UP | flags;
        header.rtm_addrs = libc::RTA_DST | libc::RTA_NETMASK | libc::RTA_GATEWAY;
        header.rtm_seq = 7;
        header.rtm_pid = 9;
        let mut bytes = vec![0; size_of::<libc::rt_msghdr>()];
        let (sa, len) = sockaddr(dst, 0);
        bytes.extend_from_slice(unsafe {
            std::slice::from_raw_parts(
                (&sa as *const libc::sockaddr_storage).cast::<u8>(),
                len as usize,
            )
        });
        let (gateway, len) = sockaddr(
            if dst.is_ipv4() {
                "192.0.2.1".parse().unwrap()
            } else {
                "2001:db8::1".parse().unwrap()
            },
            0,
        );
        bytes.extend_from_slice(unsafe {
            std::slice::from_raw_parts(
                (&gateway as *const libc::sockaddr_storage).cast::<u8>(),
                len as usize,
            )
        });
        bytes.extend_from_slice(mask);
        bytes.resize((bytes.len() + 3) & !3, 0);
        if mask.is_empty() {
            bytes.extend_from_slice(&[0; 4]);
        }
        header.rtm_msglen = bytes.len() as _;
        unsafe { std::ptr::write_unaligned(bytes.as_mut_ptr().cast::<libc::rt_msghdr>(), header) };
        bytes
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn route_parser_defaults_specific_cloned_and_malformed() {
        for (dst, target) in [("0.0.0.0", "1.1.1.1"), ("::", "2606:4700:4700::1111")] {
            let target: IpAddr = target.parse().unwrap();
            let bytes = reply(dst.parse().unwrap(), &[], libc::RTF_GATEWAY);
            assert_eq!(parse_route(&bytes, target, 7, 9), Ok((0, true, false)));
            assert_eq!(
                parse_route(&bytes, target, 8, 9),
                Err(ErrorCode::RouteDenied)
            );
            assert_eq!(
                parse_route(&bytes, target, 7, 10),
                Err(ErrorCode::RouteDenied)
            );
            for end in 0..bytes.len() {
                assert!(parse_route(&bytes[..end], target, 7, 9).is_err());
            }
        }
        let ip: IpAddr = "1.1.1.1".parse().unwrap();
        let bytes = reply(
            "1.1.1.0".parse().unwrap(),
            &[7, 0, 0, 0, 255, 255, 255],
            libc::RTF_GATEWAY,
        );
        assert_eq!(parse_route(&bytes, ip, 7, 9), Ok((24, true, false)));
        assert!(parse_route(&bytes, "1.1.2.1".parse().unwrap(), 7, 9).is_err());
        let bytes = reply(
            ip,
            &[8, 0, 0, 0, 255, 255, 255, 255],
            libc::RTF_HOST | libc::RTF_LLINFO | libc::RTF_WASCLONED,
        );
        assert_eq!(parse_route(&bytes, ip, 7, 9), Ok((32, false, true)));
        // Darwin emits this all-ones compact sockaddr for a local IPv4 host mask.
        let bytes = reply(
            ip,
            &[8, 255, 255, 255, 255, 255, 255, 255],
            libc::RTF_LLINFO,
        );
        assert_eq!(parse_route(&bytes, ip, 7, 9), Ok((32, false, true)));
        let bytes = reply(ip, &[8, 0, 0, 0, 255, 0, 255, 0], libc::RTF_GATEWAY);
        assert!(parse_route(&bytes, ip, 7, 9).is_err());
        for flags in [
            libc::RTF_GATEWAY | libc::RTF_REJECT,
            libc::RTF_GATEWAY | libc::RTF_BLACKHOLE,
        ] {
            let bytes = reply("0.0.0.0".parse().unwrap(), &[], flags);
            assert!(parse_route(&bytes, ip, 7, 9).is_err());
        }
    }
}
