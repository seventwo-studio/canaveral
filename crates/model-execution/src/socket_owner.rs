#[cfg(target_os = "macos")]
pub fn owned(pid: u32, port: u16) -> bool {
    unsafe extern "C" {
        fn canaveral_model_socket_owned(pid: i32, port: u16) -> i32;
    }
    unsafe { canaveral_model_socket_owned(pid as i32, port) == 1 }
}
#[cfg(target_os = "linux")]
pub fn owned(pid: u32, port: u16) -> bool {
    let Ok(table) = std::fs::read_to_string(format!("/proc/{pid}/net/tcp")) else {
        return false;
    };
    let inodes: Vec<_> = table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<_> = line.split_whitespace().collect();
            if f.get(1) == Some(&format!("0100007F:{port:04X}").as_str()) && f.get(3) == Some(&"0A")
            {
                f.get(9).copied()
            } else {
                None
            }
        })
        .collect();
    let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    fds.flatten().any(|fd| {
        std::fs::read_link(fd.path()).ok().is_some_and(|path| {
            inodes
                .iter()
                .any(|inode| path.as_os_str() == std::ffi::OsStr::new(&format!("socket:[{inode}]")))
        })
    })
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn owned(_: u32, _: u16) -> bool {
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_another_process_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(super::owned(std::process::id(), port));
        assert!(!super::owned(1, port));
        assert!(!super::owned(u32::MAX, port));
    }
}
