//! Closed HTTP CONNECT grammar; the satellite must independently validate targets.
use crate::data::ErrorCode;
use std::net::IpAddr;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Address(IpAddr),
    Name(String),
}
pub fn target(input: &str) -> Result<Target, ErrorCode> {
    let invalid = ErrorCode::InvalidTarget;
    if let Ok(ip) = input.parse::<IpAddr>() {
        if (input.contains(':') && input.contains('.')) || ip.to_string() != input {
            return Err(invalid);
        }
        return Ok(Target::Address(ip));
    }
    let name = input.strip_suffix('.').unwrap_or(input);
    if name.len() > 253 || !name.contains('.') || !name.is_ascii() {
        return Err(invalid);
    }
    // inet_aton legacy forms must never reach the resolver.
    let numeric = |s: &str| {
        s.bytes().all(|b| b.is_ascii_digit())
            || s.strip_prefix("0x")
                .is_some_and(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    let lower = name.to_ascii_lowercase();
    if lower.split('.').all(numeric) {
        return Err(invalid);
    }
    for label in lower.split('.') {
        if label.is_empty()
            || label.len() > 63
            || !label.as_bytes()[0].is_ascii_alphanumeric()
            || !label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(invalid);
        }
    }
    for suffix in ["local", "localhost", "internal", "home.arpa", "lan"] {
        if lower == suffix || lower.ends_with(&format!(".{suffix}")) {
            return Err(invalid);
        }
    }
    Ok(Target::Name(format!("{lower}.")))
}
#[derive(Debug, PartialEq, Eq)]
pub enum HeaderError {
    Method,
    Invalid,
    Policy(ErrorCode),
}
/// Caller enforces the five-second header deadline before invoking this parser.
/// Bytes after the single terminator are forbidden; no pipelining or early payload.
pub fn connect(header: &[u8], enabled: bool) -> Result<(Target, u16), HeaderError> {
    let bad = HeaderError::Invalid;
    if header.len() > 8192 || !header.ends_with(b"\r\n\r\n") {
        return Err(bad);
    }
    let text = std::str::from_utf8(header).map_err(|_| HeaderError::Invalid)?;
    if !text.is_ascii() {
        return Err(bad);
    }
    let mut lines = text[..text.len() - 4].split("\r\n");
    let line = lines.next().ok_or(HeaderError::Invalid)?;
    let words: Vec<_> = line.split(' ').collect();
    if words.len() != 3 || words[2] != "HTTP/1.1" || words.iter().any(|w| w.is_empty()) {
        return Err(bad);
    }
    if words[0] != "CONNECT" {
        return Err(HeaderError::Method);
    }
    let authority = words[1];
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once("]:").ok_or(HeaderError::Invalid)?;
        if !host.contains(':') {
            return Err(bad);
        }
        (host, tail)
    } else {
        let (host, port) = authority.split_once(':').ok_or(HeaderError::Invalid)?;
        if host.contains(':') || port.contains(':') {
            return Err(bad);
        }
        (host, port)
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad);
    }
    let parsed: u16 = port.parse().map_err(|_| HeaderError::Invalid)?;
    if parsed.to_string() != port || parsed == 0 {
        return Err(bad);
    }
    let destination = target(host).map_err(HeaderError::Policy)?;
    let mut seen_host = false;
    let mut seen_length = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(HeaderError::Invalid)?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || value.bytes().any(|b| (b < 32 && b != 9) || b == 127)
        {
            return Err(bad);
        }
        match name.to_ascii_lowercase().as_str() {
            "host" => {
                if seen_host || value.trim() != authority {
                    return Err(bad);
                }
                seen_host = true;
            }
            "content-length" => {
                if seen_length || value.trim() != "0" {
                    return Err(bad);
                }
                seen_length = true;
            }
            "transfer-encoding" | "proxy-authorization" => return Err(bad),
            _ => (),
        }
    }
    if parsed != 443 {
        return Err(HeaderError::Policy(ErrorCode::PortDenied));
    }
    if !enabled {
        return Err(HeaderError::Policy(ErrorCode::EgressDenied));
    }
    Ok((destination, parsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_grammar() {
        assert_eq!(
            target("EXAMPLE.COM."),
            Ok(Target::Name("example.com.".into()))
        );
        for value in [
            "example",
            "x.local",
            "home.arpa",
            "x.INTERNAL.",
            "a..b",
            "127.1",
            "0177.0.0.1",
            "0x7f.1",
            "2130706433",
            "127.0.0.256",
            "a_b.com",
            "é.com",
            "a.com..",
            "::ffff:127.0.0.1",
            "FE80::1",
            "fe80::1%en0",
            "[::1]",
        ] {
            assert!(target(value).is_err(), "{value}");
        }
        assert!(target("127.0.0.1").is_ok()); // Syntax only; policy denies it.
        assert!(target("2001:db8::1").is_ok());
    }
    #[test]
    fn connect_grammar_status_and_grant() {
        let good = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
        assert!(connect(good, true).is_ok());
        assert_eq!(
            connect(good, false),
            Err(HeaderError::Policy(ErrorCode::EgressDenied))
        );
        assert_eq!(
            connect(b"CONNECT example.com:22 HTTP/1.1\r\n\r\n", true),
            Err(HeaderError::Policy(ErrorCode::PortDenied))
        );
        assert_eq!(
            connect(b"GET / HTTP/1.1\r\n\r\n", true),
            Err(HeaderError::Method)
        );
        for bad in ["CONNECT example.com:443 HTTP/1.0\r\n\r\n", "CONNECT example.com:443 HTTP/1.1\r\n\r\nx", "CONNECT example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n", "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nHost: example.com:443\r\n\r\n", "CONNECT example.com:443 HTTP/1.1\r\nContent-Length: 1\r\n\r\n", "CONNECT example.com:443 HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", "CONNECT user@example.com:443 HTTP/1.1\r\n\r\n"] {
            assert!(connect(bad.as_bytes(),true).is_err(),"{bad}");
        }
        for (code, status) in [
            (ErrorCode::InvalidTarget, 400),
            (ErrorCode::DestinationDenied, 403),
            (ErrorCode::RouteDenied, 403),
            (ErrorCode::Limit, 503),
            (ErrorCode::ConnectTimeout, 504),
            (ErrorCode::ConnectFailed, 502),
        ] {
            assert_eq!(code.http_status(), status);
        }
    }
}
