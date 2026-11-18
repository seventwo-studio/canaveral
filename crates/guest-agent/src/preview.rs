//! Unprivileged foreground wrapper inside the PID1 command's process group.
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn endpoint(value: &str) -> Result<SocketAddr> {
    let port: u16 = value.parse()?;
    if port == 0 || port.to_string() != value {
        return Err("expected a decimal port in 1..65535".into());
    }
    Ok((Ipv4Addr::LOCALHOST, port).into())
}

fn http_ready(address: SocketAddr) -> bool {
    let timeout = Duration::from_millis(200);
    let probe = || -> std::io::Result<bool> {
        let mut stream = TcpStream::connect_timeout(&address, timeout)?;
        stream.set_write_timeout(Some(timeout))?;
        write!(
            stream,
            "GET / HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )?;
        let deadline = Instant::now() + timeout;
        let mut line = Vec::new();
        while line.len() < 1024 {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            stream.set_read_timeout(Some(left))?;
            let mut byte = [0];
            stream.read_exact(&mut byte)?;
            line.push(byte[0]);
            if line.ends_with(b"\r\n") {
                return Ok(
                    (line.starts_with(b"HTTP/1.1 ") || line.starts_with(b"HTTP/1.0 "))
                        && matches!(line.get(9), Some(b'2'..=b'5'))
                        && line
                            .get(10..12)
                            .is_some_and(|s| s.iter().all(u8::is_ascii_digit))
                        && matches!(line.get(12), Some(b' ' | b'\r')),
                );
            }
        }
        Ok(false)
    };
    probe().unwrap_or(false)
}

fn supervise(args: &[String], mut receipt: impl Write) -> Result<i32> {
    let [port, program, argv @ ..] = args else {
        return Err("expected PORT PROGRAM [ARG ...]".into());
    };
    let address = endpoint(port)?;
    // Refuse an already occupied endpoint before executing tenant code.
    drop(TcpListener::bind(address)?);
    let mut child = Command::new(program)
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait()?.is_some() {
            return Err("service exited before readiness".into());
        }
        if http_ready(address) && child.try_wait()?.is_none() {
            writeln!(receipt, "previewReady {port}")?;
            receipt.flush()?;
            return Ok(child.wait()?.code().unwrap_or(1));
        }
        if Instant::now() >= deadline {
            return Err("HTTP readiness timed out".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn run(args: &[String]) -> Result<i32> {
    if !cfg!(target_os = "linux")
        || unsafe { libc::geteuid() } != 1000
        || std::env::current_dir()? != std::path::Path::new("/workspace")
        || unsafe { libc::getppid() } != 1
        || unsafe { libc::getpgrp() } != unsafe { libc::getpid() }
    {
        return Err("preview requires the supervised Linux guest workspace".into());
    }
    supervise(args, std::io::stdout().lock())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_foreground_receipt_and_exit() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        drop(listener);
        let mut receipt = Vec::new();
        let args = [port.clone(), "node".into(), "-e".into(),
            format!("const s=require('http').createServer((q,r)=>{{r.end();s.close(()=>setTimeout(()=>process.exit(7),250))}});s.listen({port},'127.0.0.1')")];
        assert_eq!(supervise(&args, &mut receipt).unwrap(), 7);
        assert_eq!(receipt, format!("previewReady {port}\n").as_bytes());
    }
    #[test]
    fn occupied_or_invalid_port_refused_before_spawn() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("started");
        for port in [
            "0".into(),
            "65536".into(),
            listener.local_addr().unwrap().port().to_string(),
        ] {
            let args = [port, "touch".into(), marker.to_str().unwrap().into()];
            assert!(supervise(&args, Vec::new()).is_err());
            assert!(!marker.exists());
        }
    }
}
