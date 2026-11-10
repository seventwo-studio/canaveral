//! Descriptor-confined file and owned PTY adapter. Private bounded JSON-lines stdio only.
#[cfg(unix)]
mod owned_process;
#[cfg(unix)]
mod unix {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::ffi::{CStr, CString};
    use std::fs::{File, Metadata};
    use std::io::{self, BufRead, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    use std::time::{Duration, Instant};

    type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
    fn fail<T>(message: &str) -> Result<T> {
        Err(message.into())
    }
    fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
        v[key]
            .as_str()
            .ok_or_else(|| format!("Missing string {key}").into())
    }
    fn number(v: &Value, key: &str) -> Result<u64> {
        v[key]
            .as_u64()
            .ok_or_else(|| format!("Invalid integer {key}").into())
    }
    fn name(value: &str) -> Result<CString> {
        if value.is_empty()
            || value == "."
            || value == ".."
            || value.contains('/')
            || value.contains('\\')
        {
            return fail("Invalid relative component");
        }
        Ok(CString::new(value)?)
    }
    fn opened(fd: libc::c_int) -> Result<File> {
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn open_at(parent: &File, component: &str, flags: i32) -> Result<File> {
        let component = name(component)?;
        opened(unsafe {
            libc::openat(
                parent.as_raw_fd(),
                component.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        })
    }
    fn root(path: &str) -> Result<File> {
        if !path.starts_with('/') {
            return fail("Container root must be absolute");
        }
        let mut dir = opened(unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        for part in path.split('/').filter(|s| !s.is_empty()) {
            dir = open_at(&dir, part, libc::O_RDONLY | libc::O_DIRECTORY)?;
        }
        Ok(dir)
    }
    fn identity(meta: &Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
        (
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    }
    fn same_inode(a: &Metadata, b: &Metadata) -> bool {
        a.dev() == b.dev() && a.ino() == b.ino() && a.is_file() && b.is_file()
    }
    fn exists(parent: &File, component: &str) -> Result<bool> {
        let component = name(component)?;
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                component.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Ok(false);
        }
        Err(error.into())
    }
    struct Stage {
        file: File,
        parent: File,
        name: String,
        published: bool,
        written: u64,
        synced: Option<Metadata>,
    }
    impl Stage {
        fn write(&mut self, data: &[u8]) -> Result<usize> {
            if self.published {
                return fail("Stage already published");
            }
            self.synced = None;
            let count = self.file.write(data)?;
            self.written += count as u64;
            Ok(count)
        }
        fn sync(&mut self) -> Result<()> {
            self.file.sync_all()?;
            let metadata = self.file.metadata()?;
            if !metadata.is_file() || metadata.len() != self.written {
                return fail("Stage length differs from received bytes");
            }
            self.synced = Some(metadata);
            Ok(())
        }
        fn verified(&self) -> Result<bool> {
            Ok(!self.published
                && self.owned()?
                && self.synced.as_ref().is_some_and(|meta| {
                    self.file
                        .metadata()
                        .is_ok_and(|current| identity(meta) == identity(&current))
                }))
        }
        fn owned(&self) -> Result<bool> {
            match open_at(&self.parent, &self.name, libc::O_RDONLY) {
                Ok(file) => Ok(same_inode(&self.file.metadata()?, &file.metadata()?)),
                Err(_) => Ok(false),
            }
        }
        fn rename(&mut self, destination: &str) -> Result<()> {
            if !self.verified()? {
                return fail("Staged inode was replaced");
            }
            let from = name(&self.name)?;
            let to = name(destination)?;
            if unsafe {
                libc::renameat(
                    self.parent.as_raw_fd(),
                    from.as_ptr(),
                    self.parent.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(io::Error::last_os_error().into());
            }
            self.published = true;
            let published = open_at(&self.parent, destination, libc::O_RDONLY)?;
            if !same_inode(&self.file.metadata()?, &published.metadata()?) {
                return fail("Published inode differs from owned stage");
            }
            Ok(())
        }
        fn cleanup(&self) -> Result<()> {
            if self.owned()? {
                let n = name(&self.name)?;
                if unsafe { libc::unlinkat(self.parent.as_raw_fd(), n.as_ptr(), 0) } != 0 {
                    return Err(io::Error::last_os_error().into());
                }
            }
            Ok(())
        }
        fn publish(&mut self, destination: &str, replace: bool) -> Result<&'static str> {
            if replace {
                self.rename(destination)?;
                return Ok("published");
            }
            if !self.verified()? {
                return fail("Staged inode was replaced");
            }
            let from = name(&self.name)?;
            let to = name(destination)?;
            if unsafe {
                libc::linkat(
                    self.parent.as_raw_fd(),
                    from.as_ptr(),
                    self.parent.as_raw_fd(),
                    to.as_ptr(),
                    0,
                )
            } != 0
            {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::AlreadyExists {
                    return Ok("exists");
                }
                return Err(error.into());
            }
            self.published = true;
            let published = open_at(&self.parent, destination, libc::O_RDONLY)?;
            if !same_inode(&self.file.metadata()?, &published.metadata()?) {
                return fail("Published inode differs from owned stage");
            }
            self.cleanup()?;
            Ok("published")
        }
    }
    struct Download {
        file: File,
        parent: File,
        name: String,
        initial: Metadata,
    }
    impl Download {
        fn verify(&self) -> Result<()> {
            let current = open_at(&self.parent, &self.name, libc::O_RDONLY)?;
            if !current.metadata()?.is_file()
                || identity(&self.file.metadata()?) != identity(&self.initial)
                || identity(&current.metadata()?) != identity(&self.initial)
            {
                return fail("Download inode, path or nanosecond metadata changed");
            }
            Ok(())
        }
    }
    fn list(parent: &File) -> Result<Value> {
        let fd = unsafe { libc::dup(parent.as_raw_fd()) };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let dir = unsafe { libc::fdopendir(fd) };
        if dir.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(io::Error::last_os_error().into());
        }
        struct Directory(*mut libc::DIR);
        impl Drop for Directory {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let _guard = Directory(dir);
        unsafe {
            libc::rewinddir(dir);
        }
        let mut entries = vec![];
        loop {
            let entry = unsafe { libc::readdir(dir) };
            if entry.is_null() {
                break;
            }
            let n = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str()?;
            if n == "." || n == ".." {
                continue;
            }
            let c = name(n)?;
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    c.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(io::Error::last_os_error().into());
            }
            let metadata = unsafe { metadata.assume_init() };
            entries.push(json!({"name":n,"kind":if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {"directory"} else {"file"}}));
            if entries.len() == 2001 {
                break;
            }
        }
        Ok(json!(entries))
    }
    struct Pty {
        master: File,
        pid: Option<libc::pid_t>,
        exit_code: Option<i32>,
    }
    impl Pty {
        fn open(argv: &[String]) -> Result<Self> {
            if argv.is_empty() {
                return fail("PTY argv is empty");
            }
            let strings = argv
                .iter()
                .map(|s| CString::new(s.as_str()))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut pointers: Vec<*const libc::c_char> =
                strings.iter().map(|s| s.as_ptr()).collect();
            pointers.push(std::ptr::null());
            let mut master = -1;
            let mut winsize = libc::winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            let pid = unsafe {
                libc::forkpty(
                    &mut master,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut winsize,
                )
            };
            if pid < 0 {
                return Err(io::Error::last_os_error().into());
            }
            if pid == 0 {
                unsafe {
                    libc::execvp(strings[0].as_ptr(), pointers.as_ptr());
                    libc::_exit(127);
                }
            }
            let file = opened(master)?;
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
            if flags < 0
                || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                    < 0
            {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                return Err(io::Error::last_os_error().into());
            }
            unsafe {
                libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
            }
            Ok(Self {
                master: file,
                pid: Some(pid),
                exit_code: None,
            })
        }
        fn reap(&mut self) -> Result<()> {
            if let Some(pid) = self.pid {
                let mut status = 0;
                let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
                if result == pid {
                    self.pid = None;
                    self.exit_code = Some(if libc::WIFEXITED(status) {
                        libc::WEXITSTATUS(status)
                    } else {
                        -1
                    });
                } else if result < 0 {
                    return Err(io::Error::last_os_error().into());
                }
            }
            Ok(())
        }
        fn read(&mut self) -> Result<Value> {
            let mut buffer = vec![0u8; 65536];
            let count = match self.master.read(&mut buffer) {
                Ok(n) => n,
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        || e.raw_os_error() == Some(libc::EIO) =>
                {
                    0
                }
                Err(e) => return Err(e.into()),
            };
            buffer.truncate(count);
            self.reap()?;
            Ok(
                json!({"data":STANDARD.encode(buffer),"exited":self.pid.is_none(),"exitCode":self.exit_code}),
            )
        }
        fn write(&mut self, data: &[u8]) -> Result<()> {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut offset = 0;
            while offset < data.len() {
                if Instant::now() >= deadline {
                    return fail("PTY write timed out");
                }
                match self.master.write(&data[offset..]) {
                    Ok(0) => return fail("PTY write refused"),
                    Ok(n) => offset += n,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(())
        }
        fn resize(&self, rows: u64, cols: u64) -> Result<()> {
            if !(1..=500).contains(&rows) || !(1..=500).contains(&cols) {
                return fail("Invalid PTY dimensions");
            }
            let size = libc::winsize {
                ws_row: rows as u16,
                ws_col: cols as u16,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
                return Err(io::Error::last_os_error().into());
            }
            Ok(())
        }
    }
    impl Drop for Pty {
        fn drop(&mut self) {
            let _ = self.reap();
            if let Some(pid) = self.pid {
                // This is our unreaped direct child. Never signal a PID recovered from a receipt.
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
                let deadline = Instant::now() + Duration::from_secs(2);
                while self.pid.is_some() && Instant::now() < deadline {
                    let _ = self.reap();
                    std::thread::sleep(Duration::from_millis(10));
                }
                if self.pid.is_some() {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                        libc::waitpid(pid, std::ptr::null_mut(), 0);
                    }
                    self.pid = None;
                }
            }
        }
    }
    #[derive(Default)]
    struct Server {
        next: u64,
        dirs: HashMap<u64, File>,
        stages: HashMap<u64, Stage>,
        downloads: HashMap<u64, Download>,
        pty: Option<Pty>,
        process: crate::owned_process::OwnedProcess,
    }
    impl Server {
        fn id(&mut self) -> u64 {
            self.next += 1;
            self.next
        }
        fn dir(&self, v: &Value) -> Result<&File> {
            self.dirs
                .get(&number(v, "directory")?)
                .ok_or_else(|| "Unknown owned directory".into())
        }
        fn handle(&mut self, v: &Value, mode: &str) -> Result<Value> {
            let op = field(v, "op")?;
            if op == "shutdown" {
                return Ok(json!({}));
            }
            if mode == "process" {
                return self.process.handle(v);
            }
            if mode == "pty" {
                return match op {
                    "ptyOpen" => {
                        if self.pty.is_some() {
                            return fail("PTY already opened");
                        }
                        let argv = v["argv"]
                            .as_array()
                            .ok_or("Missing argv")?
                            .iter()
                            .map(|x| x.as_str().map(String::from).ok_or("Invalid argv"))
                            .collect::<std::result::Result<Vec<_>, _>>()?;
                        if argv.len() > 100 || argv.iter().any(|s| s.len() > 4096) {
                            return fail("PTY argv exceeds envelope");
                        }
                        self.pty = Some(Pty::open(&argv)?);
                        Ok(json!({}))
                    }
                    "ptyRead" => self.pty.as_mut().ok_or("PTY not opened")?.read(),
                    "ptyWrite" => {
                        let data = STANDARD.decode(field(v, "data")?)?;
                        if data.len() > 65536 {
                            return fail("PTY input exceeds envelope");
                        }
                        self.pty.as_mut().ok_or("PTY not opened")?.write(&data)?;
                        Ok(json!({}))
                    }
                    "ptyResize" => {
                        self.pty
                            .as_ref()
                            .ok_or("PTY not opened")?
                            .resize(number(v, "rows")?, number(v, "cols")?)?;
                        Ok(json!({}))
                    }
                    _ => fail("Invalid PTY operation"),
                };
            }
            match op {
                "directory" => {
                    let file = open_at(
                        self.dir(v)?,
                        field(v, "name")?,
                        libc::O_RDONLY | libc::O_DIRECTORY,
                    )?;
                    let id = self.id();
                    self.dirs.insert(id, file);
                    Ok(json!({"id":id}))
                }
                "closeDirectory" => {
                    self.dirs
                        .remove(&number(v, "directory")?)
                        .ok_or("Unknown directory")?;
                    Ok(json!({}))
                }
                "list" => list(self.dir(v)?),
                "exists" => Ok(json!({"exists":exists(self.dir(v)?,field(v,"name")?)?})),
                "syncDirectory" => {
                    self.dir(v)?.sync_all()?;
                    Ok(json!({}))
                }
                "create" => {
                    let n = field(v, "name")?.to_owned();
                    let parent = self.dir(v)?.try_clone()?;
                    let file = open_at(&parent, &n, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
                    let id = self.id();
                    self.stages.insert(
                        id,
                        Stage {
                            file,
                            parent,
                            name: n,
                            published: false,
                            written: 0,
                            synced: None,
                        },
                    );
                    Ok(json!({"id":id}))
                }
                "stageWrite" => {
                    let data = STANDARD.decode(field(v, "data")?)?;
                    if data.len() > 65536 {
                        return fail("Stage chunk exceeds envelope");
                    }
                    let stage = self
                        .stages
                        .get_mut(&number(v, "stage")?)
                        .ok_or("Unknown stage")?;
                    if stage.published {
                        return fail("Stage already published");
                    }
                    let n = stage.write(&data)?;
                    Ok(json!({"count":n}))
                }
                "stageSync" => {
                    self.stages
                        .get_mut(&number(v, "stage")?)
                        .ok_or("Unknown stage")?
                        .sync()?;
                    Ok(json!({}))
                }
                "stageClose" => {
                    if !self.stages.contains_key(&number(v, "stage")?) {
                        return fail("Unknown stage");
                    }
                    Ok(json!({}))
                }
                "rename" => {
                    self.stages
                        .get_mut(&number(v, "stage")?)
                        .ok_or("Unknown stage")?
                        .rename(field(v, "name")?)?;
                    Ok(json!({}))
                }
                "publish" => {
                    let replace = v["replace"]
                        .as_bool()
                        .ok_or("Explicit replacement required")?;
                    let state = self
                        .stages
                        .get_mut(&number(v, "stage")?)
                        .ok_or("Unknown stage")?
                        .publish(field(v, "name")?, replace)?;
                    Ok(json!({"state":state}))
                }
                "removeStage" => {
                    if let Some(stage) = self.stages.remove(&number(v, "stage")?) {
                        stage.cleanup()?;
                    }
                    Ok(json!({}))
                }
                "download" => {
                    let n = field(v, "name")?.to_owned();
                    let parent = self.dir(v)?.try_clone()?;
                    let file = open_at(&parent, &n, libc::O_RDONLY)?;
                    let initial = file.metadata()?;
                    if !initial.is_file() || initial.len() > 9007199254740991 {
                        return fail("Download requires a regular file with safe length");
                    }
                    let size = initial.len();
                    let id = self.id();
                    self.downloads.insert(
                        id,
                        Download {
                            file,
                            parent,
                            name: n,
                            initial,
                        },
                    );
                    Ok(json!({"id":id,"size":size}))
                }
                "downloadRead" => {
                    let count = number(v, "count")?;
                    if count == 0 || count > 65536 {
                        return fail("Invalid download read size");
                    }
                    let item = self
                        .downloads
                        .get_mut(&number(v, "download")?)
                        .ok_or("Unknown download")?;
                    item.verify()?;
                    let mut data = vec![0; count as usize];
                    let n = item.file.read(&mut data)?;
                    data.truncate(n);
                    Ok(json!({"data":STANDARD.encode(data)}))
                }
                "downloadVerify" => {
                    self.downloads
                        .get(&number(v, "download")?)
                        .ok_or("Unknown download")?
                        .verify()?;
                    Ok(json!({}))
                }
                "downloadClose" => {
                    self.downloads.remove(&number(v, "download")?);
                    Ok(json!({}))
                }
                _ => fail("Unknown scoped file operation"),
            }
        }
    }
    pub fn main() -> Result<()> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mode = args
            .first()
            .map(String::as_str)
            .ok_or("Choose files or pty mode")?;
        if mode == "clock" && args.len() == 1 {
            println!("{}", elapsed()?);
            return Ok(());
        }
        let mut server = Server::default();
        if mode == "files" && args.len() == 2 {
            server.dirs.insert(0, root(&args[1])?);
        } else if !["pty", "process"].contains(&mode) || args.len() != 1 {
            return fail("Invalid scoped helper invocation");
        }
        let stdin = io::stdin();
        let mut input = io::BufReader::new(stdin.lock());
        let stdout = io::stdout();
        let mut output = stdout.lock();
        loop {
            if mode == "process" && input.buffer().is_empty() {
                let mut fd = libc::pollfd {
                    fd: 0,
                    events: libc::POLLIN,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut fd, 1, 20000) } <= 0 {
                    break;
                }
            }
            let mut line = vec![];
            let count = (&mut input).take(1048577).read_until(b'\n', &mut line)?;
            if count == 0 {
                break;
            }
            if count > 1048576 || line.last() != Some(&b'\n') {
                return fail("Private request exceeds envelope");
            }
            let value: Value = serde_json::from_slice(&line)?;
            let seq = number(&value, "seq")?;
            let result = match server.handle(&value, mode) {
                Ok(body) => json!({"seq":seq,"ok":true,"body":body}),
                Err(_) => {
                    json!({"seq":seq,"ok":false,"error":"Native operation failed; inspect before retrying"})
                }
            };
            serde_json::to_writer(&mut output, &result)?;
            output.write_all(b"\n")?;
            output.flush()?;
            if value["op"] == "shutdown" {
                break;
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn elapsed() -> Result<f64> {
        #[repr(C)]
        struct Timebase {
            numer: u32,
            denom: u32,
        }
        unsafe extern "C" {
            fn mach_continuous_time() -> u64;
            fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
        }
        let mut scale = Timebase { numer: 0, denom: 0 };
        if unsafe { mach_timebase_info(&mut scale) } != 0 || scale.numer == 0 || scale.denom == 0 {
            return fail("Continuous native clock unavailable");
        }
        Ok(
            unsafe { mach_continuous_time() } as f64 * f64::from(scale.numer)
                / f64::from(scale.denom)
                / 1_000_000_000.0,
        )
    }
    #[cfg(target_os = "linux")]
    fn elapsed() -> Result<f64> {
        let mut stamp = std::mem::MaybeUninit::<libc::timespec>::uninit();
        if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, stamp.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        let stamp = unsafe { stamp.assume_init() };
        Ok(stamp.tv_sec as f64 + stamp.tv_nsec as f64 / 1_000_000_000.0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn elapsed() -> Result<f64> {
        fail("Continuous native clock unsupported")
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;
        use std::path::PathBuf;
        fn temporary() -> PathBuf {
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "canaveral-mobile-native-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&p).unwrap();
            std::fs::canonicalize(p).unwrap()
        }
        #[test]
        fn confinement_and_owned_stage_publication() {
            let p = temporary();
            let dir = root(p.to_str().unwrap()).unwrap();
            assert!(open_at(&dir, "..", libc::O_RDONLY).is_err());
            symlink("/", p.join("escape")).unwrap();
            assert!(open_at(&dir, "escape", libc::O_RDONLY | libc::O_DIRECTORY).is_err());
            let file = open_at(&dir, "stage", libc::O_RDWR | libc::O_CREAT | libc::O_EXCL).unwrap();
            let mut s = Stage {
                file,
                parent: dir,
                name: "stage".into(),
                published: false,
                written: 0,
                synced: None,
            };
            s.write(b"new").unwrap();
            s.sync().unwrap();
            s.rename("target").unwrap();
            s.parent.sync_all().unwrap();
            s.cleanup().unwrap();
            assert_eq!(std::fs::read(p.join("target")).unwrap(), b"new");
            std::fs::remove_dir_all(p).unwrap();
        }
        #[test]
        fn foreign_stage_replacement_is_never_removed() {
            let p = temporary();
            let dir = root(p.to_str().unwrap()).unwrap();
            let file = open_at(&dir, "stage", libc::O_RDWR | libc::O_CREAT | libc::O_EXCL).unwrap();
            let mut s = Stage {
                file,
                parent: dir,
                name: "stage".into(),
                published: false,
                written: 0,
                synced: None,
            };
            std::fs::rename(p.join("stage"), p.join("original")).unwrap();
            std::fs::write(p.join("stage"), b"foreign").unwrap();
            assert!(s.rename("target").is_err());
            s.cleanup().unwrap();
            assert_eq!(std::fs::read(p.join("stage")).unwrap(), b"foreign");
            std::fs::remove_dir_all(p).unwrap();
        }
        #[test]
        fn download_identity_rejects_path_replacement() {
            let p = temporary();
            std::fs::write(p.join("file"), b"abc").unwrap();
            let parent = root(p.to_str().unwrap()).unwrap();
            let file = open_at(&parent, "file", libc::O_RDONLY).unwrap();
            let d = Download {
                initial: file.metadata().unwrap(),
                file,
                parent,
                name: "file".into(),
            };
            d.verify().unwrap();
            std::fs::rename(p.join("file"), p.join("old")).unwrap();
            std::fs::write(p.join("file"), b"abc").unwrap();
            assert!(d.verify().is_err());
            std::fs::remove_dir_all(p).unwrap();
        }
        #[test]
        fn real_disposable_pty_has_dimensions_and_owned_exit() {
            let mut p = Pty::open(&[
                "/bin/sh".into(),
                "-c".into(),
                "stty size; printf fixture".into(),
            ])
            .unwrap();
            p.resize(35, 91).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut data = vec![];
            while Instant::now() < deadline {
                let v = p.read().unwrap();
                data.extend(STANDARD.decode(v["data"].as_str().unwrap()).unwrap());
                if v["exited"] == true {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(String::from_utf8_lossy(&data).contains("fixture"));
            assert!(p.pid.is_none());
        }
    }
}
#[cfg(unix)]
fn main() {
    if unix::main().is_err() {
        eprintln!("Scoped mobile helper failed; inspect private state before retrying.");
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("Mobile native helper requires macOS or Linux.");
    std::process::exit(1);
}
