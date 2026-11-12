//! Serialized file lane. The reactor owns replay; the worker owns descriptors.
//! Worker shutdown never joins a possibly blocked filesystem syscall.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use crate::runtime::now;
use canaveral_guest_protocol::{
    data::{CancelReason, Frame, Receipt, Request, Step},
    Result,
};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    mpsc, Arc,
};
use uuid::Uuid;

use sha2::{Digest, Sha256};

fn request_digest(request: &Request) -> Result<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(request)?).into())
}
#[derive(Default)]
struct Replay {
    step: u64,
    digest: Option<[u8; 32]>,
    receipt: Option<Receipt>,
    cancelled: bool,
}
impl Replay {
    fn begin(
        &mut self,
        id: Uuid,
        step: u64,
        request: Request,
        remaining: u64,
        now: u64,
    ) -> Result<Step<'_>> {
        request.validate()?;
        if id.is_nil()
            || step == 0
            || step > canaveral_guest_protocol::MAX_SAFE
            || remaining == 0
            || remaining > canaveral_guest_protocol::MAX_SAFE
        {
            return Err("invalid transfer step".into());
        }
        now.checked_add(remaining).ok_or("deadline overflow")?;
        let digest = request_digest(&request)?;
        if step == self.step {
            if self.digest != Some(digest) {
                return Err("changed transfer replay".into());
            }
            return self
                .receipt
                .as_ref()
                .map(Step::Replay)
                .ok_or_else(|| "step still in flight".into());
        }
        if self.cancelled || step != self.step + 1 || (self.step != 0 && self.receipt.is_none()) {
            return Err("transfer gap/cancelled".into());
        }
        self.step = step;
        self.digest = Some(digest);
        self.receipt = None;
        Ok(Step::Execute)
    }
    fn cancel(&mut self, _: Uuid) {
        self.cancelled = true;
    }
    fn complete(&mut self, receipt: Receipt) -> Result<()> {
        receipt.validate()?;
        if self.step == 0 || self.receipt.is_some() {
            return Err("no pending transfer step".into());
        }
        self.receipt = Some(receipt);
        Ok(())
    }
}

pub(crate) struct Authority {
    cancelled: AtomicU8,
    deadline: u64,
}
impl Authority {
    fn check(&self) -> std::result::Result<(), &'static str> {
        match self.cancelled.load(Ordering::SeqCst) {
            1 => Err("authorization_lost"),
            2 => Err("deadline"),
            3 => Err("data_channel_lost"),
            _ if now() >= self.deadline => Err("deadline"),
            _ => Ok(()),
        }
    }
}
struct Job {
    id: Uuid,
    request: Request,
    authority: Arc<Authority>,
    reply: bool,
}
struct Pending {
    id: Uuid,
    step: u64,
    digest: [u8; 32],
    authority: Arc<Authority>,
}
pub(crate) struct Lane {
    replay: std::collections::BTreeMap<Uuid, Replay>,
    pending: Option<Pending>,
    active: Option<Uuid>,
    unknown: bool,
    ended: std::collections::VecDeque<Uuid>,
    send: mpsc::SyncSender<Job>,
    receive: mpsc::Receiver<Receipt>,
}
impl Lane {
    #[cfg(test)]
    pub fn start(
        executor: impl FnMut(Uuid, &Request, &Authority) -> Receipt + Send + 'static,
    ) -> Self {
        let (send, jobs) = mpsc::sync_channel::<Job>(1);
        let (done, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut executor = executor;
            while let Ok(job) = jobs.recv() {
                let receipt = executor(job.id, &job.request, &job.authority);
                if job.reply && done.send(receipt).is_err() {
                    break;
                }
            }
        });
        Self {
            replay: Default::default(),
            pending: None,
            active: None,
            unknown: false,
            ended: Default::default(),
            send,
            receive,
        }
    }
    pub fn dispatch(&mut self, frame: Frame) -> Result<Option<Frame>> {
        match frame {
            Frame::TransferCancel { id, reason, .. } => {
                if let Some(replay) = self.replay.get_mut(&id) {
                    replay.cancel(id);
                }
                if let Some(p) = &self.pending {
                    if p.id == id {
                        p.authority.cancelled.store(
                            match reason {
                                CancelReason::Deadline => 2,
                                CancelReason::AuthorizationLost => 1,
                                CancelReason::Stop => 3,
                            },
                            Ordering::SeqCst,
                        );
                    }
                } else if self.active == Some(id) {
                    self.active = None;
                    self.ended.push_back(id);
                    self.send.try_send(Job {
                        id,
                        request: Request::Abort,
                        authority: Arc::new(Authority {
                            cancelled: AtomicU8::new(0),
                            deadline: u64::MAX,
                        }),
                        reply: false,
                    })?;
                }
                Ok(None)
            }
            Frame::TransferRequest {
                id,
                step,
                request,
                remaining_ms,
                ..
            } => {
                if let Some(p) = &self.pending {
                    if p.id == id && p.step == step && p.digest == request_digest(&request)? {
                        return Ok(None);
                    }
                    return Err("changed replay or concurrent transfer step".into());
                }
                if self.active.is_some_and(|active| active != id) {
                    return Err("transfer lane busy".into());
                }
                if self.replay.len() >= 128 && !self.replay.contains_key(&id) {
                    let oldest = self
                        .ended
                        .pop_front()
                        .ok_or("transfer replay retention limit")?;
                    self.replay.remove(&oldest);
                }
                let accepted_at = now();
                match self.replay.entry(id).or_default().begin(
                    id,
                    step,
                    request.clone(),
                    remaining_ms,
                    accepted_at,
                )? {
                    Step::Replay(receipt) => Ok(Some(Frame::TransferReceipt {
                        version: 1,
                        id,
                        step,
                        receipt: receipt.clone(),
                    })),
                    Step::Execute => {
                        if self.ended.contains(&id) {
                            return Err("transfer already ended".into());
                        }
                        if self.unknown {
                            return Err("unknown transfer blocks file lane".into());
                        }
                        self.active = Some(id);
                        let authority = Arc::new(Authority {
                            cancelled: AtomicU8::new(0),
                            deadline: accepted_at
                                .checked_add(remaining_ms)
                                .ok_or("deadline overflow")?,
                        });
                        self.send.try_send(Job {
                            id,
                            request: request.clone(),
                            authority: authority.clone(),
                            reply: true,
                        })?;
                        self.pending = Some(Pending {
                            id,
                            step,
                            digest: request_digest(&request)?,
                            authority,
                        });
                        Ok(None)
                    }
                }
            }
            _ => Err("not a transfer frame".into()),
        }
    }
    pub fn poll(&mut self) -> Result<Option<Frame>> {
        match self.receive.try_recv() {
            Ok(mut receipt) => {
                let p = self.pending.take().ok_or("unexpected file completion")?;
                if matches!(receipt, Receipt::Writing { .. } | Receipt::Reading { .. }) {
                    if let Err(code) = p.authority.check() {
                        receipt = failed(code);
                        self.send.try_send(Job {
                            id: p.id,
                            request: Request::Abort,
                            authority: Arc::new(Authority {
                                cancelled: AtomicU8::new(0),
                                deadline: u64::MAX,
                            }),
                            reply: false,
                        })?;
                    }
                }
                self.unknown |= matches!(receipt, Receipt::Unknown { .. });
                if matches!(
                    receipt,
                    Receipt::Failed { .. }
                        | Receipt::Unknown { .. }
                        | Receipt::Aborted
                        | Receipt::Committed { .. }
                        | Receipt::Verified { .. }
                ) {
                    self.active = None;
                    self.ended.push_back(p.id);
                }
                self.replay
                    .get_mut(&p.id)
                    .ok_or("missing replay")?
                    .complete(receipt.clone())?;
                Ok(Some(Frame::TransferReceipt {
                    version: 1,
                    id: p.id,
                    step: p.step,
                    receipt,
                }))
            }
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(_) => Err("file worker stopped".into()),
        }
    }
}
impl Drop for Lane {
    fn drop(&mut self) {
        if let Some(p) = &self.pending {
            p.authority.cancelled.store(3, Ordering::SeqCst);
        }
    }
}
fn failed(code: &str) -> Receipt {
    Receipt::Failed { code: code.into() }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use super::*;
    use crate::workspace::{
        confined::{identity, lookup, Root},
        Identity,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use canaveral_guest_protocol::data::{self, Cursor};
    use std::{
        ffi::CString,
        fs::File,
        io::{Read, Seek, SeekFrom, Write},
        os::fd::AsRawFd,
    };

    struct Copy {
        file: File,
        initial: Identity,
        cursor: Cursor,
        offset: u64,
        upload: Option<Upload>,
    }
    struct Upload {
        parent: File,
        staging: File,
        name: CString,
        path: String,
        stage: CString,
        replace: bool,
    }
    impl Drop for Upload {
        fn drop(&mut self) {
            unsafe {
                libc::unlinkat(self.staging.as_raw_fd(), self.stage.as_ptr(), 0);
            }
        }
    }
    pub fn start(root: Root) -> Result<Lane> {
        // Raw syscalls affect only this dedicated thread. libc setgroups wrappers
        // can signal all threads; never use those in PID1. No fsuid restoration.
        let (ready, ack) = mpsc::sync_channel(1);
        let (go, jobs) = mpsc::sync_channel::<Job>(1);
        let (done, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let credentials = unsafe {
                libc::syscall(libc::SYS_setgroups, 0usize, std::ptr::null::<libc::gid_t>()) == 0
                    && {
                        libc::setfsgid(1000);
                        libc::setfsgid(!0) == 1000
                    }
                    && {
                        libc::setfsuid(1000);
                        libc::setfsuid(!0) == 1000
                    }
            };
            let _ = ready.send(credentials);
            if !credentials {
                return;
            }
            let mut copy = None;
            while let Ok(job) = jobs.recv() {
                let receipt = execute(&root, &mut copy, job.id, &job.request, &job.authority);
                if job.reply && done.send(receipt).is_err() {
                    break;
                }
            }
        });
        if !ack.recv()? {
            return Err("file worker credential drop failed".into());
        }
        Ok(Lane {
            replay: Default::default(),
            pending: None,
            active: None,
            unknown: false,
            ended: Default::default(),
            send: go,
            receive,
        })
    }
    fn error(e: &(dyn std::error::Error + 'static)) -> &'static str {
        if let Some(e) = e.downcast_ref::<std::io::Error>() {
            match e.raw_os_error() {
                Some(libc::ENOENT) => "not_found",
                Some(libc::ENOSPC) | Some(libc::EDQUOT) => "disk_full",
                Some(libc::EEXIST) => "destination_exists",
                Some(libc::ELOOP) | Some(libc::EXDEV) | Some(libc::EACCES) | Some(libc::EPERM)
                | Some(libc::ENOTDIR) => "path_denied",
                _ => "io_error",
            }
        } else {
            "io_error"
        }
    }
    fn eligible(root: &Root, file: &File) -> std::result::Result<Identity, &'static str> {
        let i = identity(file).map_err(|_| "io_error")?;
        if !i.regular {
            return Err("not_regular");
        }
        if i.links != 1 {
            return Err("hardlink_denied");
        }
        if i.uid != 1000 || i.device != root.device {
            return Err("path_denied");
        }
        Ok(i)
    }
    // Inspect the directory entry without opening or following the destination.
    // Replacing a hardlink only removes that entry; it does not write its inode.
    fn replacement_allowed(parent: &File, name: &CString) -> std::result::Result<(), &'static str> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            let e = std::io::Error::last_os_error();
            return if e.raw_os_error() == Some(libc::ENOENT) {
                Ok(())
            } else {
                Err(error(&e))
            };
        }
        let stat = unsafe { stat.assume_init() };
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFREG => Ok(()),
            libc::S_IFLNK => Err("path_denied"),
            _ => Err("not_regular"),
        }
    }
    fn execute(
        root: &Root,
        copy: &mut Option<Copy>,
        id: Uuid,
        request: &Request,
        authority: &Authority,
    ) -> Receipt {
        let mut receipt = match perform(root, copy, id, request, authority) {
            Ok(r) => r,
            Err(code) => failed(code),
        };
        if matches!(receipt, Receipt::Writing { .. } | Receipt::Reading { .. }) {
            if let Err(code) = authority.check() {
                receipt = failed(code);
            }
        }
        if matches!(
            receipt,
            Receipt::Failed { .. }
                | Receipt::Unknown { .. }
                | Receipt::Aborted
                | Receipt::Committed { .. }
                | Receipt::Verified { .. }
        ) {
            *copy = None;
        }
        receipt
    }
    fn perform(
        root: &Root,
        copy: &mut Option<Copy>,
        id: Uuid,
        request: &Request,
        authority: &Authority,
    ) -> std::result::Result<Receipt, &'static str> {
        authority.check()?;
        if let Request::Abort = request {
            *copy = None;
            return Ok(Receipt::Aborted);
        }
        if let Request::BeginDownload { path } = request {
            if copy.is_some() {
                return Err("io_error");
            }
            data::path(path).map_err(|_| "path_denied")?;
            let file =
                lookup(&root.root, path, libc::O_RDONLY, 0).map_err(|e| error(e.as_ref()))?;
            let initial = eligible(root, &file)?;
            let receipt = Receipt::Reading {
                offset: 0,
                bytes: Some(initial.bytes),
                data: None,
            };
            let mut cursor = Cursor::default();
            cursor.receipt(request, &receipt).map_err(|_| "io_error")?;
            *copy = Some(Copy {
                file,
                initial,
                cursor,
                offset: 0,
                upload: None,
            });
            return Ok(receipt);
        }
        if let Request::BeginUpload { path, replace, .. } = request {
            if copy.is_some() {
                return Err("io_error");
            }
            data::path(path).map_err(|_| "path_denied")?;
            let parent_name = path.rsplit_once('/').map_or(".", |(p, _)| p);
            let parent = lookup(
                &root.root,
                parent_name,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )
            .map_err(|e| error(e.as_ref()))?;
            let staging = lookup(
                &root.root,
                ".canaveral/transfers",
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )
            .map_err(|e| error(e.as_ref()))?;
            let stage = CString::new(id.to_string()).map_err(|_| "io_error")?;
            let file = lookup(
                &staging,
                &id.to_string(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
            .map_err(|e| error(e.as_ref()))?;
            let upload = Upload {
                parent,
                staging,
                name: CString::new(path.rsplit('/').next().unwrap()).map_err(|_| "path_denied")?,
                path: path.clone(),
                stage,
                replace: *replace,
            };
            let initial = eligible(root, &file)?;
            let receipt = Receipt::Writing { offset: 0 };
            let mut cursor = Cursor::default();
            cursor.receipt(request, &receipt).map_err(|_| "io_error")?;
            *copy = Some(Copy {
                file,
                initial,
                cursor,
                offset: 0,
                upload: Some(upload),
            });
            return Ok(receipt);
        }
        let c = copy.as_mut().ok_or("io_error")?;
        c.cursor.request(request).map_err(|_| match request {
            Request::Finish { bytes, .. } if *bytes != c.offset => "size_mismatch",
            Request::Finish { .. } => "digest_mismatch",
            _ => "size_mismatch",
        })?;
        let before = eligible(root, &c.file)?;
        if c.upload.is_some() && (before.inode != c.initial.inode || before.bytes != c.offset) {
            return Err("source_changed");
        }
        if c.upload.is_none() && !c.initial.unchanged(&before) {
            return Err("source_changed");
        }
        match request {
            Request::Write { data, .. } => {
                let bytes = data::payload(data, false).map_err(|_| "io_error")?;
                c.file.write_all(&bytes).map_err(|e| error(&e))?;
                let after = eligible(root, &c.file)?;
                if before.inode != after.inode || after.bytes != c.offset + bytes.len() as u64 {
                    return Err("source_changed");
                }
                c.offset += bytes.len() as u64;
                let receipt = Receipt::Writing { offset: c.offset };
                c.cursor
                    .receipt(request, &receipt)
                    .map_err(|_| "io_error")?;
                authority.check()?;
                Ok(receipt)
            }
            Request::Read { max_bytes, .. } => {
                let mut bytes =
                    vec![0; (*max_bytes).min(c.initial.bytes.saturating_sub(c.offset)) as usize];
                c.file.read_exact(&mut bytes).map_err(|e| error(&e))?;
                if !before.unchanged(&eligible(root, &c.file)?) {
                    return Err("source_changed");
                }
                c.offset += bytes.len() as u64;
                let receipt = Receipt::Reading {
                    offset: c.offset,
                    bytes: None,
                    data: Some(STANDARD.encode(bytes)),
                };
                c.cursor
                    .receipt(request, &receipt)
                    .map_err(|_| "source_changed")?;
                authority.check()?;
                Ok(receipt)
            }
            Request::Finish { bytes, sha256 } => {
                // Reuse the protocol's SHA-256 cursor for a second independent pass.
                let mut verify = Cursor::default();
                verify
                    .receipt(
                        &Request::BeginDownload {
                            path: "verify".into(),
                        },
                        &Receipt::Reading {
                            offset: 0,
                            bytes: Some(*bytes),
                            data: None,
                        },
                    )
                    .map_err(|_| "io_error")?;
                c.file.seek(SeekFrom::Start(0)).map_err(|e| error(&e))?;
                let mut offset = 0;
                let mut buffer = [0; data::MAX_CHUNK];
                while offset < *bytes {
                    authority.check()?;
                    let n = ((*bytes - offset) as usize).min(buffer.len());
                    c.file
                        .read_exact(&mut buffer[..n])
                        .map_err(|_| "source_changed")?;
                    verify
                        .receipt(
                            &Request::Read {
                                offset,
                                max_bytes: n as u64,
                            },
                            &Receipt::Reading {
                                offset: offset + n as u64,
                                bytes: None,
                                data: Some(STANDARD.encode(&buffer[..n])),
                            },
                        )
                        .map_err(|_| "source_changed")?;
                    offset += n as u64;
                }
                verify.request(request).map_err(|_| {
                    if c.upload.is_some() {
                        "digest_mismatch"
                    } else {
                        "source_changed"
                    }
                })?;
                if !before.unchanged(&eligible(root, &c.file)?) {
                    return Err("source_changed");
                }
                authority.check()?;
                if let Some(u) = &c.upload {
                    c.file.sync_all().map_err(|e| error(&e))?;
                    root.parent_reachable(&u.path, &u.parent)
                        .map_err(|_| "path_denied")?;
                    authority.check()?;
                    if !before.unchanged(&eligible(root, &c.file)?) {
                        return Err("source_changed");
                    }
                    let staged = lookup(
                        &root.root,
                        &format!(".canaveral/transfers/{id}"),
                        libc::O_RDONLY,
                        0,
                    )
                    .map_err(|e| error(e.as_ref()))?;
                    if !before.unchanged(&eligible(root, &staged)?) {
                        return Err("source_changed");
                    }
                    // The CAS marks the publication race window. Cancellation that
                    // wins first prevents rename; cancellation inside yields unknown.
                    authority.check()?;
                    authority
                        .cancelled
                        .compare_exchange(0, 4, Ordering::SeqCst, Ordering::SeqCst)
                        .map_err(|_| "authorization_lost")?;
                    let status = if u.replace {
                        replacement_allowed(&u.parent, &u.name)?;
                        unsafe {
                            libc::renameat(
                                u.staging.as_raw_fd(),
                                u.stage.as_ptr(),
                                u.parent.as_raw_fd(),
                                u.name.as_ptr(),
                            ) as libc::c_long
                        }
                    } else {
                        unsafe {
                            libc::syscall(
                                libc::SYS_renameat2,
                                u.staging.as_raw_fd(),
                                u.stage.as_ptr(),
                                u.parent.as_raw_fd(),
                                u.name.as_ptr(),
                                libc::RENAME_NOREPLACE,
                            )
                        }
                    };
                    if status != 0 {
                        let e = std::io::Error::last_os_error();
                        if e.raw_os_error() == Some(libc::EIO) || authority.check().is_err() {
                            return Ok(Receipt::Unknown {
                                code: "publication_unknown".into(),
                            });
                        }
                        return Err(error(&e));
                    }
                    let durable = u.parent.sync_all().and_then(|()| u.staging.sync_all());
                    if durable.is_err() || authority.check().is_err() {
                        return Ok(Receipt::Unknown {
                            code: "publication_unknown".into(),
                        });
                    }
                    Ok(Receipt::Committed {
                        bytes: *bytes,
                        sha256: sha256.clone(),
                        durable: true,
                    })
                } else {
                    Ok(Receipt::Verified {
                        bytes: *bytes,
                        sha256: sha256.clone(),
                    })
                }
            }
            _ => Err("io_error"),
        }
    }
    #[cfg(test)]
    mod syscall_tests {
        use super::*;
        use std::os::unix::fs::{symlink, MetadataExt};
        #[test]
        fn symlinked_parent_and_swapped_staging_fail_closed() {
            let dir = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            symlink(outside.path(), dir.path().join("parent")).unwrap();
            let root = File::open(dir.path()).unwrap();
            assert!(lookup(&root, "parent/file", libc::O_RDWR | libc::O_CREAT, 0o600).is_err());
            std::fs::create_dir_all(dir.path().join(".canaveral/transfers")).unwrap();
            let staging = lookup(
                &root,
                ".canaveral/transfers",
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )
            .unwrap();
            std::fs::rename(
                dir.path().join(".canaveral/transfers"),
                dir.path().join(".canaveral/old"),
            )
            .unwrap();
            symlink(outside.path(), dir.path().join(".canaveral/transfers")).unwrap();
            assert!(lookup(
                &root,
                ".canaveral/transfers/file",
                libc::O_RDWR | libc::O_CREAT,
                0o600
            )
            .is_err());
            let _file = lookup(
                &staging,
                "file",
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
            .unwrap();
            assert!(!outside.path().join("file").exists());
        }
        #[test]
        fn replacement_inspects_entry_without_following() {
            let dir = tempfile::tempdir().unwrap();
            let root = File::open(dir.path()).unwrap();
            let name = CString::new("entry").unwrap();
            assert_eq!(replacement_allowed(&root, &name), Ok(()));
            std::fs::write(dir.path().join("entry"), b"old").unwrap();
            std::fs::hard_link(dir.path().join("entry"), dir.path().join("alias")).unwrap();
            assert_eq!(replacement_allowed(&root, &name), Ok(()));
            std::fs::remove_file(dir.path().join("entry")).unwrap();
            symlink("alias", dir.path().join("entry")).unwrap();
            assert_eq!(replacement_allowed(&root, &name), Err("path_denied"));
            std::fs::remove_file(dir.path().join("entry")).unwrap();
            std::fs::create_dir(dir.path().join("entry")).unwrap();
            assert_eq!(replacement_allowed(&root, &name), Err("not_regular"));
        }
        #[test]
        fn cross_device_mount_fails_closed_when_available() {
            let root = File::open("/").unwrap();
            let dev = File::open("/dev").unwrap();
            if root.metadata().unwrap().dev() != dev.metadata().unwrap().dev() {
                assert!(lookup(&root, "dev", libc::O_RDONLY | libc::O_DIRECTORY, 0).is_err());
            }
        }
        #[test]
        fn strict_lookup_rejects_symlink_and_identifies_fifo_hardlink() {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("regular"), b"bytes").unwrap();
            symlink("regular", dir.path().join("symlink")).unwrap();
            std::fs::hard_link(dir.path().join("regular"), dir.path().join("hardlink")).unwrap();
            let fifo =
                CString::new(dir.path().join("fifo").as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            let root = File::open(dir.path()).unwrap();
            assert!(lookup(&root, "symlink", libc::O_RDONLY, 0).is_err());
            assert!(lookup(&root, "../outside", libc::O_RDONLY, 0).is_err());
            let file = lookup(&root, "hardlink", libc::O_RDONLY, 0).unwrap();
            let i = identity(&file).unwrap();
            assert_eq!(i.links, 2);
            assert!(i.eligible(i.device).is_err());
            let fifo = lookup(&root, "fifo", libc::O_RDONLY, 0).unwrap();
            assert!(!identity(&fifo).unwrap().regular);
            let device = File::open("/dev/null").unwrap();
            assert!(!identity(&device).unwrap().regular);
            // CI normally mounts /dev separately. Explicitly test NO_XDEV when so.
            let system = File::open("/").unwrap();
            if system.metadata().unwrap().dev() != device.metadata().unwrap().dev() {
                assert!(lookup(&system, "dev/null", libc::O_RDONLY, 0).is_err());
            }
        }
        #[test]
        fn syscall_failure_codes_are_closed() {
            for (errno, code) in [
                (libc::ENOSPC, "disk_full"),
                (libc::ENOENT, "not_found"),
                (libc::EEXIST, "destination_exists"),
                (libc::EXDEV, "path_denied"),
                (libc::ELOOP, "path_denied"),
                (libc::EIO, "io_error"),
            ] {
                assert_eq!(error(&std::io::Error::from_raw_os_error(errno)), code);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn terminal_retention_evicts_oldest_at_bound() {
        let mut lane = Lane::start(|_, _, _| Receipt::Aborted);
        for id in 1..=129 {
            lane.dispatch(request(id, 1)).unwrap();
            completion(&mut lane);
        }
        assert_eq!(lane.replay.len(), 128);
        assert_eq!(lane.ended.len(), 128);
        assert!(!lane.replay.contains_key(&Uuid::from_u128(1)));
        assert!(lane.dispatch(request(129, 1)).unwrap().is_some());
    }
    fn request(id: u128, step: u64) -> Frame {
        Frame::TransferRequest {
            version: 1,
            id: Uuid::from_u128(id),
            step,
            request: Request::Abort,
            remaining_ms: 5000,
        }
    }
    fn completion(lane: &mut Lane) -> Frame {
        let limit = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if let Some(frame) = lane.poll().unwrap() {
                return frame;
            }
            assert!(
                std::time::Instant::now() < limit,
                "worker completion timed out"
            );
            std::thread::yield_now();
        }
    }
    #[test]
    fn exact_replay_executes_once_and_each_transfer_retains_receipt() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let mut lane = Lane::start(move |_, _, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            Receipt::Aborted
        });
        lane.dispatch(request(1, 1)).unwrap();
        let receipt = completion(&mut lane);
        assert_eq!(
            serde_json::to_value(lane.dispatch(request(1, 1)).unwrap()).unwrap(),
            serde_json::to_value(Some(receipt)).unwrap()
        );
        lane.dispatch(request(2, 1)).unwrap();
        completion(&mut lane);
        assert!(lane.dispatch(request(1, 1)).unwrap().is_some());
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(lane.dispatch(request(2, 3)).is_err());
        let mut changed = request(2, 1);
        if let Frame::TransferRequest { request, .. } = &mut changed {
            *request = Request::BeginDownload { path: "x".into() };
        }
        assert!(lane.dispatch(changed).is_err());
    }
    #[test]
    fn cancellation_during_work_prevents_publication_and_replay_cannot_extend_deadline() {
        let (entered, entered_rx) = mpsc::sync_channel(1);
        let (resume, resume_rx) = mpsc::sync_channel(1);
        let published = Arc::new(AtomicBoolForTest::new(false));
        let observed = published.clone();
        let mut lane = Lane::start(move |_, _, authority| {
            entered.send(authority.deadline).unwrap();
            resume_rx.recv().unwrap();
            if let Err(code) = authority.check() {
                return failed(code);
            }
            observed.store(true, Ordering::SeqCst);
            Receipt::Aborted
        });
        lane.dispatch(request(1, 1)).unwrap();
        let deadline = entered_rx.recv().unwrap();
        let mut replay = request(1, 1);
        if let Frame::TransferRequest { remaining_ms, .. } = &mut replay {
            *remaining_ms = 500000;
        }
        assert!(lane.dispatch(replay).unwrap().is_none());
        assert_eq!(lane.pending.as_ref().unwrap().authority.deadline, deadline);
        lane.dispatch(Frame::TransferCancel {
            version: 1,
            id: Uuid::from_u128(1),
            reason: CancelReason::AuthorizationLost,
        })
        .unwrap();
        resume.send(()).unwrap();
        assert!(
            matches!(completion(&mut lane), Frame::TransferReceipt { receipt: Receipt::Failed { code }, .. } if code == "authorization_lost")
        );
        assert!(!published.load(Ordering::SeqCst));
    }
    type AtomicBoolForTest = std::sync::atomic::AtomicBool;
    #[test]
    fn expired_authority_and_unknown_block_new_effects() {
        assert_eq!(
            Authority {
                deadline: 0,
                cancelled: AtomicU8::new(0)
            }
            .check(),
            Err("deadline")
        );
        let mut lane = Lane::start(|_, _, _| Receipt::Unknown {
            code: "publication_unknown".into(),
        });
        lane.dispatch(request(1, 1)).unwrap();
        let receipt = completion(&mut lane);
        assert_eq!(
            serde_json::to_value(lane.dispatch(request(1, 1)).unwrap()).unwrap(),
            serde_json::to_value(Some(receipt)).unwrap()
        );
        assert!(lane.dispatch(request(2, 1)).is_err());
    }
}
