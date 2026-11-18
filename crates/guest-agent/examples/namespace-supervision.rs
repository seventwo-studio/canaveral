//! Explicit namespace fixture, not a production CLI mode or microVM acceptance.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../src/data.rs"]
mod data;
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../src/file_executor.rs"]
mod file_executor;
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../src/runtime.rs"]
mod runtime;
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../src/workspace.rs"]
mod workspace;
#[cfg(target_os = "linux")]
use canaveral_guest_agent::Launch;
#[cfg(target_os = "linux")]
fn main() {
    use canaveral_guest_protocol::{encode, Guest, Host};
    use std::{
        fs::File,
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{fs::MetadataExt, net::UnixStream},
        },
        thread,
    };
    use uuid::Uuid;
    assert_eq!(std::process::id(), 1, "fixture requires isolated PID1");
    for (fd, kind, flag) in [
        (3, "pid", libc::CLONE_NEWPID),
        (4, "mnt", libc::CLONE_NEWNS),
        (5, "net", libc::CLONE_NEWNET),
    ] {
        let original = unsafe { File::from_raw_fd(fd) };
        assert_eq!(
            unsafe { libc::ioctl(original.as_raw_fd(), 0xb703) },
            flag,
            "namespace descriptor required"
        ); // NS_GET_NSTYPE
        let current = std::fs::metadata(format!("/proc/self/ns/{kind}")).unwrap();
        assert_ne!(
            original.metadata().unwrap().ino(),
            current.ino(),
            "fixture needs separate namespaces"
        );
    }
    let agent =
        std::fs::canonicalize(std::env::args_os().nth(1).expect("guest binary path")).unwrap();
    let root = std::path::Path::new("/workspace");
    // Never write or mount on the host filesystem: private tmpfs is mandatory.
    unsafe {
        assert_eq!(
            libc::mount(
                std::ptr::null(),
                c"/".as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null()
            ),
            0
        );
        assert_eq!(
            libc::mount(
                c"tmpfs".as_ptr(),
                c"/tmp".as_ptr(),
                c"tmpfs".as_ptr(),
                libc::MS_NOSUID | libc::MS_NODEV,
                c"size=134217728,mode=1777".as_ptr().cast()
            ),
            0
        );
    }
    // Construct /workspace even on VMs without that mountpoint, entirely inside tmpfs.
    let stage = std::path::Path::new("/tmp/fixture-root");
    std::fs::create_dir(stage).unwrap();
    for dir in ["usr", "proc", "dev", "workspace", "sbin"] {
        std::fs::create_dir(stage.join(dir)).unwrap();
    }
    for dir in ["usr", "proc"] {
        assert!(std::process::Command::new("mount")
            .arg("--bind")
            .arg(format!("/{dir}"))
            .arg(stage.join(dir))
            .status()
            .unwrap()
            .success());
    }
    for dir in ["bin", "lib", "lib64"] {
        std::os::unix::fs::symlink(format!("usr/{dir}"), stage.join(dir)).unwrap();
    }
    File::create(stage.join("dev/null")).unwrap();
    assert!(std::process::Command::new("mount")
        .args(["--bind", "/dev/null"])
        .arg(stage.join("dev/null"))
        .status()
        .unwrap()
        .success());
    std::fs::copy(agent, stage.join("sbin/canaveral-guest-agent")).unwrap();
    assert!(std::process::Command::new("ip")
        .args(["link", "set", "lo", "up"])
        .status()
        .unwrap()
        .success());
    std::env::set_current_dir(stage).unwrap();
    unsafe {
        assert_eq!(libc::chroot(c".".as_ptr()), 0);
        assert_eq!(libc::chdir(c"/".as_ptr()), 0);
        assert_eq!(
            libc::mount(
                c"tmpfs".as_ptr(),
                c"/workspace".as_ptr(),
                c"tmpfs".as_ptr(),
                libc::MS_NODEV | libc::MS_NOSUID,
                c"size=16777216,uid=1000,gid=1000".as_ptr().cast()
            ),
            0
        );
    }
    std::os::unix::fs::symlink("/", root.join("escape")).unwrap();
    let manifest = serde_json::from_slice::<canaveral_guest_protocol::bundle::Manifest>(
        include_bytes!("../../guest-protocol/fixtures/canonical.json"),
    )
    .unwrap();
    let launch = Launch {
        binding: canaveral_guest_protocol::Binding {
            lease_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            boot_attempt: Uuid::from_u128(3),
            revision: 1,
            bundle_digest: manifest.digest().unwrap(),
        },
        workspace_bytes: 16777216,
        manifest,
    };
    let (mut host, guest) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    let binding = launch.binding.clone();
    fn read(s: &mut UnixStream) -> Guest {
        let mut n = [0; 4];
        s.read_exact(&mut n).unwrap();
        let mut b = vec![0; u32::from_be_bytes(n) as usize];
        s.read_exact(&mut b).unwrap();
        serde_json::from_slice(&b).unwrap()
    }
    fn send(s: &mut UnixStream, v: Host) {
        s.write_all(&encode(&v).unwrap()).unwrap();
    }
    let driver = thread::spawn(move || {
        send(
            &mut host,
            Host::Hello {
                version: 1,
                binding,
                remaining_ms: 20000,
            },
        );
        assert!(matches!(read(&mut host), Guest::Ready { .. }));
        use base64::Engine;
        use std::net::{TcpListener, TcpStream};
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let address = ("127.0.0.1", port);
        let id = Uuid::from_u128(9);
        let script = "require('http').createServer((q,r)=>r.end(process.getuid()+' '+process.cwd()+' '+q.url)).listen(process.argv[1]*1,'127.0.0.1')";
        send(
            &mut host,
            Host::Credit {
                version: 1,
                bytes: 4096,
            },
        );
        send(
            &mut host,
            Host::Exec {
                version: 1,
                id,
                argv: vec![
                    "/sbin/canaveral-guest-agent".into(),
                    "--preview-service".into(),
                    port.to_string(),
                    "node".into(),
                    "-e".into(),
                    script.into(),
                    port.to_string(),
                ],
                cwd: "/workspace".into(),
                env: Default::default(),
                timeout_ms: 15000,
            },
        );
        let ready = format!("previewReady {port}\n");
        let mut receipt = Vec::new();
        while receipt.len() < ready.len() {
            match read(&mut host) {
                Guest::Output {
                    id: output_id,
                    stream,
                    data,
                    ..
                } if output_id == id && stream == "stdout" => receipt.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .unwrap(),
                ),
                other => panic!("expected preview readiness, received {other:?}"),
            }
        }
        assert_eq!(receipt, ready.as_bytes());
        let path = format!("/fixture-{port}");
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("HTTP/1.1 200 ") || headers.starts_with("HTTP/1.0 200 "));
        assert_eq!(body, format!("1000 /workspace {path}"));
        send(&mut host, Host::Cancel { version: 1, id });
        assert!(
            matches!(read(&mut host), Guest::Exit { id: exit_id, termination_confirmed: true,
            timed_out: false, .. } if exit_id == id)
        );
        assert_eq!(
            TcpStream::connect(address).unwrap_err().kind(),
            std::io::ErrorKind::ConnectionRefused
        );
        println!("previewReady {port}, GET 200 {body}, cancel confirmed, listener refused");
        for (n, program, cwd, script, failed, timeout) in [
            (10,"/missing/program","/workspace","",true,1000),
            (11,"/bin/sh","/workspace/missing","",true,1000),
            (12,"/bin/sh","/workspace/escape","",true,1000),
            (13,"/bin/sh","/workspace","exit 7",false,1000),
            (14,"/bin/sh","/workspace","id -u; setsid /bin/sh -c 'sleep 30' & wait",false,100),
            (15,"/bin/sh","/workspace","i=0; while [ $i -lt 100 ]; do (sleep 0.01 &) ; i=$((i+1)); sleep 0.01; done; sleep 0.1; printf reaped; sleep 2",false,4000),
            (16, "/bin/sh", "/workspace", "sleep 30 & wait", false, 4000),
            (17, "/bin/sh", "/workspace", "printf hello; printf error >&2; exit 7", false, 1000),
        ] {
            if n >= 14 { send(&mut host,Host::Credit{version:1,bytes:65536}); }
            send(&mut host, Host::Exec {version:1,id:Uuid::from_u128(n),argv:vec![program.into(),"-c".into(),script.into()],cwd:cwd.into(),env:Default::default(),timeout_ms:timeout});
            if n == 16 { send(&mut host, Host::Cancel {version:1,id:Uuid::from_u128(n)}); }
            let mut output=String::new();
            loop { match read(&mut host) {
                Guest::SpawnFailed {..} => {assert!(failed); break;},
                Guest::Output{data,..} => { use base64::Engine; output.push_str(&String::from_utf8(base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap());
                    if n==15 && output.contains("reaped") {
                        // The leader is still sleeping. Repeated adopted orphans must
                        // already be gone, not deferred until command completion.
                        let children = std::fs::read_to_string("/proc/1/task/1/children").unwrap();
                        assert_eq!(children.split_whitespace().count(), 1, "orphans accumulated: {children}");
                    }
                },
                Guest::Exit{status,timed_out,termination_confirmed,stdout_bytes,stderr_bytes,..} => { assert!(!failed); assert!(termination_confirmed); if n==17 {assert_eq!(status,Some(7)); assert_eq!((stdout_bytes,stderr_bytes),(5,5)); assert!(output.contains("hello") && output.contains("error"));}
                    if n==13 {assert_eq!(status,Some(7));}
                    if n==16 {assert!(!timed_out);}
                    if n==14 {assert!(timed_out); assert!(output.starts_with("1000\n"));} break; },
                other => panic!("unexpected {other:?}"),
            }}
            // Retried late cancel must not close the session; no output credit for silent exit.
            send(&mut host,Host::Cancel{version:1,id:Uuid::from_u128(n)});
            send(&mut host,Host::Cancel{version:1,id:Uuid::from_u128(999)});
            assert!(matches!(read(&mut host),Guest::Rejected{reason,..} if reason=="unknownCommand"));
        }
        send(
            &mut host,
            Host::Exec {
                version: 1,
                id: Uuid::from_u128(17),
                argv: vec!["/bin/sh".into(), "-c".into(), "exit 0".into()],
                cwd: "/workspace".into(),
                env: Default::default(),
                timeout_ms: 1000,
            },
        );
        assert_eq!(
            host.read(&mut [0; 4]).unwrap(),
            0,
            "replay must close without execution"
        );
    });
    let result = runtime::reactor(File::from(std::os::fd::OwnedFd::from(guest)), &launch, root);
    driver.join().unwrap();
    assert!(result.is_err()); // driver disconnect permanently fences session
                              // Stalled output, zero credit and fragmented input must not stall expiry.
    for mode in 0..3 {
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let binding = launch.binding.clone();
        let driver = thread::spawn(move || {
            send(
                &mut host,
                Host::Hello {
                    version: 1,
                    binding,
                    remaining_ms: 100,
                },
            );
            assert!(matches!(read(&mut host), Guest::Ready { .. }));
            if mode == 2 {
                host.write_all(&[0, 0]).unwrap();
            } else {
                if mode == 1 {
                    send(
                        &mut host,
                        Host::Credit {
                            version: 1,
                            bytes: 1_048_576,
                        },
                    );
                }
                send(
                    &mut host,
                    Host::Exec {
                        version: 1,
                        id: Uuid::from_u128(10),
                        argv: vec![
                            "/bin/sh".into(),
                            "-c".into(),
                            "while :; do printf 1234567890; done".into(),
                        ],
                        cwd: "/workspace".into(),
                        env: Default::default(),
                        timeout_ms: 2000,
                    },
                );
            }
            thread::sleep(std::time::Duration::from_millis(300));
        });
        let start = std::time::Instant::now();
        assert!(
            runtime::reactor(File::from(std::os::fd::OwnedFd::from(guest)), &launch, root).is_err()
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        driver.join().unwrap();
    }
    println!("production namespace supervision fixture passed");
}
#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("GATED: Linux namespaces required");
}
