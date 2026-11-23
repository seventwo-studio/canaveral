//! Archive extraction feeds the same verified package store as per-file releases.
use crate::{
    private::{self, Directory},
    runtime_backend::Backend,
    runtime_package::{self as package, invalid, parts, RuntimePackage, FILE_BYTES, PACKAGE_BYTES},
    PackageReferences, Result,
};
use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, Instant},
};

pub(super) const MANIFEST: &str = ".canaveral-package.json";
const DOWNLOAD: &str = ".canaveral-download";
const ENTRIES: usize = 4096;
const MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const RATIO: u64 = 128;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Format {
    #[serde(rename = "tar.gz")]
    TarGz,
    Zip,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pin {
    pub backend: Backend,
    pub version: String,
    os: String,
    arch: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    format: Format,
    #[serde(default)]
    strip_prefix: Option<String>,
    entrypoint: String,
    #[serde(default)]
    executables: Vec<String>,
    #[serde(default)]
    materialize_links: bool,
    tree_sha256: String,
    pub qualified: bool,
    retrieved: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    pins: Vec<Pin>,
    unavailable: Vec<Unavailable>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unavailable {
    backend: Backend,
    available: bool,
    blocker: String,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("runtime-pins.json")).expect("compiled runtime catalog")
});

pub(super) fn unavailable(backend: Backend) -> Option<&'static str> {
    CATALOG
        .unavailable
        .iter()
        .find(|item| item.backend == backend && !item.available)
        .map(|item| item.blocker.as_str())
}

pub(super) fn host_pin(backend: Backend) -> Option<&'static Pin> {
    CATALOG.pins.iter().find(|pin| {
        pin.backend == backend
            && pin.os == std::env::consts::OS
            && pin.arch == std::env::consts::ARCH
    })
}

pub(super) fn catalog_version(backend: Backend) -> Option<&'static str> {
    CATALOG
        .pins
        .iter()
        .find(|pin| pin.backend == backend)
        .map(|pin| pin.version.as_str())
}

pub(super) fn version_valid(version: &str) -> bool {
    (1..=80).contains(&version.len())
        && version.as_bytes()[0].is_ascii_alphanumeric()
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
}

fn cache_name(backend: Backend, version: &str, tree_sha256: &str) -> String {
    let identity = format!(
        "archive-v1\n{}\n{version}\n{tree_sha256}",
        backend.adapter()
    );
    format!("runtime-package.{:x}", Sha256::digest(identity))
}

impl Pin {
    pub fn cache(&self) -> String {
        cache_name(self.backend, &self.version, &self.tree_sha256)
    }

    fn validate(&self, test_loopback: bool) -> Result<()> {
        let url = package::https_url(&self.url, test_loopback)?;
        if url.path().ends_with('/')
            || self.retrieved.len() != 10
            || !self.retrieved.bytes().enumerate().all(|(i, byte)| {
                if matches!(i, 4 | 7) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit()
                }
            })
            || !version_valid(&self.version)
            || !package::hash_valid(&self.sha256)
            || !package::hash_valid(&self.tree_sha256)
            || !(1..=PACKAGE_BYTES).contains(&self.bytes)
            || !matches!(self.os.as_str(), "macos" | "linux")
            || !matches!(self.arch.as_str(), "aarch64" | "x86_64")
        {
            return Err(invalid());
        }
        archive_parts(&self.entrypoint)?;
        if let Some(prefix) = &self.strip_prefix {
            archive_parts(prefix)?;
        }
        for executable in &self.executables {
            archive_parts(executable)?;
        }
        Ok(())
    }

    fn package(&self, files: BTreeMap<String, String>) -> RuntimePackage {
        RuntimePackage {
            os: self.os.clone(),
            arch: self.arch.clone(),
            root: "/".into(),
            base_url: None,
            entrypoint: self.entrypoint.clone(),
            files,
            executables: self.executables.clone(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub backend: Backend,
    pub version: String,
    package: RuntimePackage,
}

fn tree_digest(package: &RuntimePackage) -> Result<String> {
    Ok(package::identity(package)?
        .trim_start_matches("runtime-package.")
        .to_owned())
}

pub(super) fn manifest_bytes(root: &File) -> Result<Option<Vec<u8>>> {
    let name = private::name(MANIFEST.as_ref())?;
    if !private::exists_at(root, &name)? {
        return Ok(None);
    }
    let file = private::openat(root, &name, libc::O_RDONLY)?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o400
        || metadata.len() > MANIFEST_BYTES
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 > MANIFEST_BYTES {
        return Err(invalid());
    }
    Ok(Some(bytes))
}

impl Manifest {
    pub fn decode(cache: &str, bytes: &[u8]) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        package::validate_package(&manifest.package, false)?;
        if manifest.package.root != Path::new("/")
            || manifest.package.base_url.is_some()
            || !version_valid(&manifest.version)
            || cache
                != cache_name(
                    manifest.backend,
                    &manifest.version,
                    &tree_digest(&manifest.package)?,
                )
        {
            return Err(invalid());
        }
        Ok(manifest)
    }
}

pub(super) fn verify(pin: &Pin, root: &File, deadline: Instant) -> Result<()> {
    let bytes = manifest_bytes(root)?.ok_or_else(invalid)?;
    let manifest = Manifest::decode(&pin.cache(), &bytes)?;
    package::verify_cache(&manifest.package, root, deadline, Some(&bytes))
}

fn redirect_policy() -> reqwest::redirect::Policy {
    // GitHub release asset links redirect once to the dedicated HTTPS asset host.
    reqwest::redirect::Policy::custom(|attempt| {
        let target = attempt.url();
        if attempt.previous().len() == 1
            && attempt.previous()[0].host_str() == Some("github.com")
            && target.scheme() == "https"
            && target.host_str() == Some("release-assets.githubusercontent.com")
            && target.port().is_none()
            && target.username().is_empty()
            && target.password().is_none()
            && target.fragment().is_none()
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

fn download(pin: &Pin, root: &File, test_loopback: bool, deadline: Instant) -> Result<File> {
    let name = private::name(DOWNLOAD.as_ref())?;
    let mut file = private::openat(root, &name, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
    // An interrupted download must leave no archive on disk to be adopted.
    if unsafe { libc::unlinkat(root.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(invalid());
    }
    let client = package::download_client(redirect_policy())?;
    let mut response = client
        .get(package::https_url(&pin.url, test_loopback)?)
        .send()
        .map_err(|_| "runtime archive download failed")?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|bytes| bytes != pin.bytes)
    {
        return Err("runtime archive download rejected");
    }
    let digest = copy(&mut response, &mut file, pin.bytes, deadline)?;
    if digest != pin.sha256 {
        return Err("runtime archive digest mismatch");
    }
    file.rewind().map_err(|_| invalid())?;
    Ok(file)
}

fn copy(
    input: &mut dyn Read,
    target: &mut File,
    expected: u64,
    deadline: Instant,
) -> Result<String> {
    let mut input = input.take(expected + 1);
    let mut copied = 0;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        if Instant::now() >= deadline {
            return Err("runtime installation deadline");
        }
        let n = input
            .read(&mut buffer)
            .map_err(|_| "runtime archive read failed")?;
        if n == 0 {
            break;
        }
        copied += n as u64;
        if copied > expected {
            return Err("runtime archive size mismatch");
        }
        target.write_all(&buffer[..n]).map_err(|_| invalid())?;
        hash.update(&buffer[..n]);
    }
    if copied != expected {
        return Err("runtime archive size mismatch");
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn finalize(file: &File, mode: libc::mode_t) -> Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
        return Err(invalid());
    }
    file.sync_all().map_err(|_| invalid())
}

fn archive_parts(path: &str) -> Result<Vec<&str>> {
    // ASCII keeps case-fold and normalization behavior uniform on both filesystems.
    if !path.is_ascii() || path.contains(':') {
        return Err(invalid());
    }
    parts(path)
}

#[derive(Default)]
struct Paths {
    names: BTreeMap<String, (String, bool, bool)>,
    bytes: usize,
}

impl Paths {
    fn register(&mut self, path: &str, directory: bool) -> Result<()> {
        let components = archive_parts(path)?;
        self.bytes += path.len();
        if self.bytes > 1024 * 1024 {
            return Err("runtime archive path byte bound exceeded");
        }
        for index in 1..=components.len() {
            let name = components[..index].join("/");
            let explicit = index == components.len();
            let directory = directory || !explicit;
            let existing = self
                .names
                .entry(name.to_ascii_lowercase())
                .or_insert_with(|| (name.clone(), directory, false));
            if existing.0 != name || existing.1 != directory || (explicit && existing.2) {
                return Err("duplicate or colliding runtime archive path");
            }
            existing.2 |= explicit;
        }
        Ok(())
    }
}

struct Extraction<'a> {
    pin: &'a Pin,
    root: &'a File,
    deadline: Instant,
    paths: Paths,
    entries: usize,
    total: u64,
    files: BTreeMap<String, String>,
    links: BTreeMap<String, String>,
}

impl Extraction<'_> {
    fn count(&mut self) -> Result<()> {
        self.entries += 1;
        if self.entries > ENTRIES || Instant::now() >= self.deadline {
            return Err("runtime archive entry or time bound exceeded");
        }
        Ok(())
    }

    fn path(&mut self, raw: &[u8], directory: bool) -> Result<Option<String>> {
        let full = std::str::from_utf8(raw).map_err(|_| invalid())?;
        let full = if directory {
            full.strip_suffix('/').unwrap_or(full)
        } else {
            full
        };
        self.paths.register(full, directory)?;
        let path = match &self.pin.strip_prefix {
            Some(prefix) if full == prefix && directory => return Ok(None),
            Some(prefix) => full
                .strip_prefix(prefix)
                .and_then(|suffix| suffix.strip_prefix('/'))
                .ok_or_else(invalid)?,
            None => full,
        };
        if path.split('/').next().is_some_and(|part| {
            part.eq_ignore_ascii_case(MANIFEST) || part.eq_ignore_ascii_case(DOWNLOAD)
        }) {
            return Err(invalid());
        }
        Ok(Some(path.to_owned()))
    }

    fn parent(&self, path: &str, create: bool) -> Result<(File, std::ffi::CString)> {
        let components = archive_parts(path)?;
        let (name, parents) = components.split_last().ok_or_else(invalid)?;
        let mut dir = self.root.try_clone().map_err(|_| invalid())?;
        for part in parents {
            dir = package::directory(&dir, part, create)?;
        }
        Ok((dir, private::name(name.as_ref())?))
    }

    fn file(&mut self, path: String, size: u64, input: &mut dyn Read) -> Result<()> {
        self.total = self.total.checked_add(size).ok_or_else(invalid)?;
        if size > FILE_BYTES || self.total > PACKAGE_BYTES.min(self.pin.bytes.saturating_mul(RATIO))
        {
            return Err("runtime archive byte or compression ratio bound exceeded");
        }
        let (dir, name) = self.parent(&path, true)?;
        let mut target =
            private::openat(&dir, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
        let hash = copy(input, &mut target, size, self.deadline)?;
        let executable = path == self.pin.entrypoint || self.pin.executables.contains(&path);
        finalize(&target, if executable { 0o500 } else { 0o400 })?;
        dir.sync_all().map_err(|_| invalid())?;
        self.files.insert(path, hash);
        Ok(())
    }

    fn link(&mut self, path: String, raw_target: &[u8]) -> Result<()> {
        let target = std::str::from_utf8(raw_target).map_err(|_| invalid())?;
        if !self.pin.materialize_links || archive_parts(target)?.len() != 1 {
            return Err("unsafe runtime archive link");
        }
        let target = path
            .rsplit_once('/')
            .map_or_else(|| target.to_owned(), |(dir, _)| format!("{dir}/{target}"));
        self.links.insert(path, target);
        Ok(())
    }

    fn materialize(&mut self) -> Result<()> {
        for path in self.links.keys().cloned().collect::<Vec<_>>() {
            let mut resolved = path.as_str();
            let mut hops = 0;
            while let Some(next) = self.links.get(resolved) {
                hops += 1;
                if hops > 32 {
                    return Err("runtime archive link cycle or depth exceeded");
                }
                resolved = next;
            }
            if !self.files.contains_key(resolved) {
                return Err("runtime archive link target is missing or not a file");
            }
            let (dir, name) = self.parent(resolved, false)?;
            let mut input = private::openat(&dir, &name, libc::O_RDONLY)?;
            let size = input.metadata().map_err(|_| invalid())?.len();
            self.file(path, size, &mut input)?;
        }
        Ok(())
    }

    fn tar(&mut self, input: File) -> Result<()> {
        let limit = PACKAGE_BYTES.min(self.pin.bytes.saturating_mul(RATIO));
        let stream = MultiGzDecoder::new(input).take(limit + 1);
        let mut archive = tar::Archive::new(stream);
        let mut pax = false;
        for entry in archive.entries().map_err(|_| invalid())?.raw(true) {
            self.count()?;
            let mut entry = entry.map_err(|_| invalid())?;
            let kind = entry.header().entry_type();
            let mode = entry.header().mode().map_err(|_| invalid())?;
            if mode & 0o6000 != 0 {
                return Err("set-id runtime archive entry");
            }
            if kind.is_pax_local_extensions() {
                if pax || entry.size() > 32768 {
                    return Err(invalid());
                }
                self.path(&entry.path_bytes(), false)?;
                let mut metadata = Vec::new();
                entry.read_to_end(&mut metadata).map_err(|_| invalid())?;
                validate_pax(&metadata)?;
                // These annotations have no effect on paths, contents or installed modes.
                pax = true;
                continue;
            }
            pax = false;
            let path = self.path(&entry.path_bytes(), kind.is_dir())?;
            match (kind, entry.size(), path) {
                (tar::EntryType::Directory, 0, _) => {}
                (tar::EntryType::Regular, size, Some(path)) => self.file(path, size, &mut entry)?,
                (tar::EntryType::Symlink, 0, Some(path)) => {
                    self.link(path, &entry.link_name_bytes().ok_or_else(invalid)?)?;
                }
                _ => return Err("unsupported runtime archive entry type"),
            }
        }
        if pax {
            return Err(invalid());
        }
        let mut stream = archive.into_inner();
        let mut tail = [0; 8192];
        loop {
            if Instant::now() >= self.deadline {
                return Err("runtime installation deadline");
            }
            let n = stream.read(&mut tail).map_err(|_| invalid())?;
            if n == 0 {
                break;
            }
            if tail[..n].iter().any(|byte| *byte != 0) {
                return Err("unexpected data after runtime tar archive");
            }
        }
        if stream.limit() == 0 {
            return Err("runtime archive compression ratio bound exceeded");
        }
        Ok(())
    }

    fn zip(&mut self, mut input: File) -> Result<()> {
        let count = zip_entry_count(&mut input, self.pin.bytes)?;
        let reader = zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        };
        let mut archive = zip::ZipArchive::with_config(reader, input).map_err(|_| invalid())?;
        if archive.len() != count {
            return Err("duplicate runtime zip entry");
        }
        for index in 0..count {
            self.count()?;
            let mut entry = archive.by_index(index).map_err(|_| invalid())?;
            let directory = entry.is_dir();
            let mode = entry.unix_mode().unwrap_or(0);
            let expected_type = if directory { 0o040000 } else { 0o100000 };
            if entry.encrypted()
                || entry.is_symlink()
                || mode & 0o6000 != 0
                || (mode & 0o170000 != 0 && mode & 0o170000 != expected_type)
                || entry.size() > entry.compressed_size().saturating_mul(RATIO)
                || (directory && entry.size() != 0)
            {
                return Err("unsafe runtime zip entry");
            }
            let path = self.path(entry.name_raw(), directory)?;
            if !directory {
                self.file(path.ok_or_else(invalid)?, entry.size(), &mut entry)?;
            }
        }
        Ok(())
    }
}

fn validate_pax(mut metadata: &[u8]) -> Result<()> {
    // SCHILY represents some xattrs as binary values containing newlines.
    // PAX records carry a byte length, which lets us skip values without parsing them.
    while !metadata.is_empty() {
        let space = metadata
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(invalid)?;
        let len = std::str::from_utf8(&metadata[..space])
            .map_err(|_| invalid())?
            .parse::<usize>()
            .map_err(|_| invalid())?;
        let (record, rest) = metadata.split_at_checked(len).ok_or_else(invalid)?;
        let record = record
            .strip_suffix(b"\n")
            .and_then(|record| record.get(space + 1..))
            .ok_or_else(invalid)?;
        let equals = record
            .iter()
            .position(|byte| *byte == b'=')
            .ok_or_else(invalid)?;
        let key = &record[..equals];
        let apple_attribute = key
            .strip_prefix(b"LIBARCHIVE.xattr.com.apple.cs.")
            .or_else(|| key.strip_prefix(b"SCHILY.xattr.com.apple.cs."));
        if key != b"mtime"
            && !matches!(
                apple_attribute,
                Some(b"CodeSignature" | b"CodeRequirements" | b"CodeDirectory")
            )
        {
            return Err("unsupported runtime archive PAX metadata");
        }
        metadata = rest;
    }
    Ok(())
}

fn zip_entry_count(input: &mut File, bytes: u64) -> Result<usize> {
    // Bound the central directory before the ZIP reader allocates it.
    // This subset uses a terminal single-disk EOCD, without ZIP64 or an archive comment.
    let mut tail = [0; 42];
    input.seek(SeekFrom::End(-42)).map_err(|_| invalid())?;
    input.read_exact(&mut tail).map_err(|_| invalid())?;
    let record = &tail[20..];
    if &tail[..4] == b"PK\x06\x07" || &record[..4] != b"PK\x05\x06" || record[20..22] != [0; 2] {
        return Err(invalid());
    }
    let count = u16::from_le_bytes([record[10], record[11]]) as usize;
    let size = u32::from_le_bytes(record[12..16].try_into().map_err(|_| invalid())?) as u64;
    let offset = u32::from_le_bytes(record[16..20].try_into().map_err(|_| invalid())?) as u64;
    if record[4..8] != [0; 4]
        || record[8..10] != record[10..12]
        || count > ENTRIES
        || size > 8 * 1024 * 1024
        || Some(offset + size) != bytes.checked_sub(22)
    {
        return Err("runtime zip metadata bound exceeded");
    }
    Ok(count)
}

pub(super) fn stage(
    pin: &Pin,
    state: &Directory,
    state_path: &Path,
    references: &PackageReferences,
    test_loopback: bool,
) -> Result<PathBuf> {
    pin.validate(test_loopback)?;
    let cache = pin.cache();
    let deadline = Instant::now() + Duration::from_secs(600);
    if let Some(root) = state.cached_package(&cache)? {
        verify(pin, &root, deadline)?;
    } else {
        let root = state.package_workspace()?;
        let archive = download(pin, &root, test_loopback, deadline)?;
        let mut extraction = Extraction {
            pin,
            root: &root,
            deadline,
            paths: Paths::default(),
            entries: 0,
            total: 0,
            files: BTreeMap::new(),
            links: BTreeMap::new(),
        };
        match pin.format {
            Format::TarGz => extraction.tar(archive)?,
            Format::Zip => extraction.zip(archive)?,
        }
        extraction.materialize()?;
        let package = pin.package(extraction.files);
        package::validate_package(&package, false)?;
        if tree_digest(&package)? != pin.tree_sha256 {
            return Err("runtime archive tree identity mismatch");
        }
        let manifest = Manifest {
            backend: pin.backend,
            version: pin.version.clone(),
            package,
        };
        let bytes = serde_json::to_vec(&manifest).map_err(|_| invalid())?;
        if bytes.len() as u64 > MANIFEST_BYTES {
            return Err(invalid());
        }
        let mut file = private::openat(
            &root,
            &private::name(MANIFEST.as_ref())?,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        file.write_all(&bytes).map_err(|_| invalid())?;
        finalize(&file, 0o400)?;
        package::publish(
            &manifest.package,
            state,
            &root,
            &cache,
            deadline,
            Some(&bytes),
        )?;
    }
    state.prune_packages(&cache, references, |entry, root| {
        Ok(manifest_bytes(root)?
            .map(|bytes| Manifest::decode(entry, &bytes))
            .transpose()?
            .is_some_and(|manifest| manifest.backend == pin.backend))
    })?;
    Ok(state_path.join(cache).join(&pin.entrypoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet, fs, io::Cursor, net::TcpListener, os::unix::fs::PermissionsExt,
    };

    const ENTRY: &[u8] = b"\x7fELF archive fixture";

    fn pin(bytes: &[u8], format: Format) -> Pin {
        let mut pin = Pin {
            backend: Backend::LlamaCpp,
            version: "1.2.3".into(),
            os: "linux".into(),
            arch: "aarch64".into(),
            url: "https://example.invalid/archive".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            format,
            strip_prefix: None,
            entrypoint: "server".into(),
            executables: vec![],
            materialize_links: true,
            tree_sha256: String::new(),
            qualified: false,
            retrieved: "2026-11-23".into(),
        };
        pin.tree_sha256 = tree_digest(&pin.package(BTreeMap::from([(
            "server".into(),
            format!("{:x}", Sha256::digest(ENTRY)),
        )])))
        .unwrap();
        pin
    }

    struct TarEntry<'a> {
        name: &'a str,
        kind: tar::EntryType,
        mode: u32,
        data: &'a [u8],
        target: &'a str,
    }
    fn regular<'a>(name: &'a str, data: &'a [u8]) -> TarEntry<'a> {
        TarEntry {
            name,
            kind: tar::EntryType::Regular,
            mode: 0o755,
            data,
            target: "",
        }
    }

    fn tar<'a>(entries: impl IntoIterator<Item = TarEntry<'a>>) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        for entry in entries {
            let mut header = tar::Header::new_ustar();
            // Write raw names so the fixture can contain paths the builder would reject.
            header.as_mut_bytes()[..entry.name.len()].copy_from_slice(entry.name.as_bytes());
            header.set_entry_type(entry.kind);
            header.set_mode(entry.mode);
            header.set_size(entry.data.len() as u64);
            let target = entry.target.as_bytes();
            header.as_mut_bytes()[157..157 + target.len()].copy_from_slice(target);
            header.set_cksum();
            tar.append(&header, entry.data).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (path, data) in entries {
            zip.start_file(path, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn extract(bytes: &[u8], pin: &Pin) -> Result<RuntimePackage> {
        let (_temp, path) = write_fixture(bytes);
        extract_file(File::open(path).unwrap(), pin)
    }

    fn write_fixture(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("archive");
        fs::write(&path, bytes).unwrap();
        (temp, path)
    }

    fn extract_file(input: File, pin: &Pin) -> Result<RuntimePackage> {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("state");
        let state = Directory::open(&path).unwrap();
        let root = state.package_workspace().unwrap();
        let mut extraction = Extraction {
            pin,
            root: &root,
            deadline: Instant::now() + Duration::from_secs(600),
            paths: Paths::default(),
            entries: 0,
            total: 0,
            files: BTreeMap::new(),
            links: BTreeMap::new(),
        };
        match pin.format {
            Format::TarGz => extraction.tar(input)?,
            Format::Zip => extraction.zip(input)?,
        }
        extraction.materialize()?;
        Ok(pin.package(extraction.files))
    }

    #[test]
    fn catalog_pins_are_well_formed_and_unique() {
        let mut keys = BTreeSet::new();
        assert!(!CATALOG.pins.is_empty());
        for pin in &CATALOG.pins {
            pin.validate(false).unwrap();
            assert!(keys.insert((pin.backend.adapter(), &pin.os, &pin.arch)));
            assert!(!pin.qualified);
            assert!(pin.url.starts_with("https://github.com/"));
            assert!(catalog_version(pin.backend).is_some());
        }
        assert!(unavailable(Backend::Vllm).is_some());
        assert!(unavailable(Backend::Mlx).is_some());
    }

    #[test]
    #[ignore = "requires independently downloaded catalog assets in a temporary folder"]
    fn downloaded_catalog_archives_match_tree_pins() {
        let directory = PathBuf::from(std::env::var_os("CANAVERAL_RUNTIME_PIN_FIXTURES").unwrap());
        for pin in &CATALOG.pins {
            let asset = pin.url.rsplit('/').next().unwrap();
            let mut file = File::open(directory.join(asset)).unwrap();
            assert_eq!(file.metadata().unwrap().len(), pin.bytes, "{asset}");
            let mut hash = Sha256::new();
            std::io::copy(&mut file, &mut hash).unwrap();
            assert_eq!(format!("{:x}", hash.finalize()), pin.sha256, "{asset}");
            file.rewind().unwrap();
            let extracted =
                extract_file(file, pin).unwrap_or_else(|error| panic!("{asset}: {error}"));
            package::validate_package(&extracted, false).unwrap();
            assert_eq!(tree_digest(&extracted).unwrap(), pin.tree_sha256, "{asset}");
        }
    }

    #[test]
    fn rejects_unsafe_paths_and_collisions_in_both_formats() {
        for path in [
            "/absolute",
            "../up",
            "dir/../up",
            "dir//empty",
            "dir/./dot",
            "dir\\windows",
            "C:/windows",
            "trailing/",
            "server",
            "SERVER",
            "Dir/a",
            "dir",
            MANIFEST,
            DOWNLOAD,
        ] {
            let tar_bytes = tar([
                regular("server", ENTRY),
                regular("dir/first", b""),
                regular(path, b"bad"),
            ]);
            assert!(
                extract(&tar_bytes, &pin(&tar_bytes, Format::TarGz)).is_err(),
                "tar {path}"
            );
            // ZIP writers reject duplicate names and represent trailing slash as directory.
            if !matches!(path, "server" | "trailing/") {
                let zip_bytes = zip(&[("server", ENTRY), ("dir/first", b""), (path, b"bad")]);
                assert!(
                    extract(&zip_bytes, &pin(&zip_bytes, Format::Zip)).is_err(),
                    "zip {path}"
                );
            }
        }
        let bytes = zip(&[("server", ENTRY), ("abcdef", b"")]);
        let mut duplicate = bytes;
        for index in 0..duplicate.len() - 5 {
            if &duplicate[index..index + 6] == b"abcdef" {
                duplicate[index..index + 6].copy_from_slice(b"server");
            }
        }
        assert!(extract(&duplicate, &pin(&duplicate, Format::Zip)).is_err());
        for name in ["x".repeat(256), vec!["x".repeat(40); 27].join("/")] {
            let bytes = zip(&[(&name, ENTRY)]);
            assert!(extract(&bytes, &pin(&bytes, Format::Zip)).is_err());
        }
    }

    #[test]
    fn rejects_special_entries_bad_links_and_set_id() {
        for kind in [
            tar::EntryType::Link,
            tar::EntryType::Char,
            tar::EntryType::Block,
            tar::EntryType::Fifo,
        ] {
            let bytes = tar([TarEntry {
                kind,
                ..regular("special", b"")
            }]);
            assert!(extract(&bytes, &pin(&bytes, Format::TarGz)).is_err());
        }
        for mode in [0o4755, 0o2755] {
            let bytes = tar([TarEntry {
                mode,
                ..regular("server", ENTRY)
            }]);
            assert!(extract(&bytes, &pin(&bytes, Format::TarGz)).is_err());
        }
        for target in [
            "/root",
            "../escape",
            "./server",
            "dir/server",
            "alias",
            "missing",
            "SERVER",
        ] {
            let bytes = tar([
                regular("server", ENTRY),
                TarEntry {
                    kind: tar::EntryType::Symlink,
                    target,
                    ..regular("alias", b"")
                },
            ]);
            assert!(
                extract(&bytes, &pin(&bytes, Format::TarGz)).is_err(),
                "{target}"
            );
        }
        let bytes = tar([
            regular("server", ENTRY),
            TarEntry {
                kind: tar::EntryType::Symlink,
                target: "server",
                ..regular("alias", b"")
            },
            TarEntry {
                kind: tar::EntryType::Symlink,
                target: "alias",
                ..regular("another", b"")
            },
        ]);
        let mut aliases = pin(&bytes, Format::TarGz);
        let files = extract(&bytes, &aliases).unwrap().files;
        assert_eq!(files["alias"], files["server"]);
        assert_eq!(files["another"], files["server"]);
        aliases.materialize_links = false;
        assert!(extract(&bytes, &aliases).is_err());
    }

    #[test]
    fn pax_annotations_cannot_override_extraction() {
        let value = b"SCHILY.xattr.com.apple.cs.CodeSignature=a\nb\0";
        let encoded = [format!("{} ", value.len() + 4).as_bytes(), value, b"\n"].concat();
        assert!(validate_pax(&encoded).is_ok());
        for rejected in [
            b"14 path=other\n".as_slice(),
            b"10 size=2\n",
            b"0 mtime=0\n",
        ] {
            assert!(validate_pax(rejected).is_err());
        }
    }

    #[test]
    fn applies_prefix_and_entry_byte_and_ratio_bounds() {
        let bytes = tar([regular("prefix/server", ENTRY)]);
        let mut prefixed = pin(&bytes, Format::TarGz);
        prefixed.strip_prefix = Some("prefix".into());
        assert_eq!(
            tree_digest(&extract(&bytes, &prefixed).unwrap()).unwrap(),
            prefixed.tree_sha256
        );
        prefixed.strip_prefix = Some("pref".into());
        assert!(extract(&bytes, &prefixed).is_err());

        let names: Vec<_> = (0..=ENTRIES)
            .map(|index| format!("entry-{index}"))
            .collect();
        let bytes = tar(names.iter().map(|name| TarEntry {
            kind: tar::EntryType::Directory,
            ..regular(name, b"")
        }));
        assert_eq!(
            extract(&bytes, &pin(&bytes, Format::TarGz)).err(),
            Some("runtime archive entry or time bound exceeded")
        );

        let data = vec![0; 512 * 1024];
        let bytes = tar([regular("server", &data)]);
        assert!(extract(&bytes, &pin(&bytes, Format::TarGz)).is_err());
        let bytes = zip(&[("server", &data)]);
        assert!(extract(&bytes, &pin(&bytes, Format::Zip)).is_err());

        let fixture = pin(b"fixture", Format::TarGz);
        let workspace = tempfile::tempdir().unwrap();
        let root = File::open(workspace.path()).unwrap();
        let mut extraction = Extraction {
            pin: &fixture,
            root: &root,
            deadline: Instant::now() + Duration::from_secs(1),
            paths: Paths::default(),
            entries: 0,
            total: 0,
            files: BTreeMap::new(),
            links: BTreeMap::new(),
        };
        assert!(extraction
            .file("server".into(), FILE_BYTES + 1, &mut &b""[..])
            .is_err());
        extraction.total = PACKAGE_BYTES;
        assert!(extraction.file("server".into(), 1, &mut &b"a"[..]).is_err());
    }

    fn serve(bytes: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/pinned", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            write!(stream, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n").unwrap();
            stream.write_all(&bytes).unwrap();
        });
        (url, thread)
    }

    #[test]
    fn verified_download_recovers_staging_reuses_cache_and_detects_tampering() {
        for (bytes, format) in [
            (tar([regular("server", ENTRY)]), Format::TarGz),
            (zip(&[("server", ENTRY)]), Format::Zip),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().canonicalize().unwrap().join("state");
            let state = Directory::open(&path).unwrap();
            let mut pin = pin(&bytes, format);
            for fault in ["size", "digest", ""] {
                let (url, task) = serve(bytes.clone());
                pin.url = url;
                let expected = pin.sha256.clone();
                if fault == "size" {
                    pin.bytes += 1;
                } else if fault == "digest" {
                    pin.sha256 = "a".repeat(64);
                }
                let result = stage(&pin, &state, &path, &Default::default(), true);
                task.join().unwrap();
                if fault.is_empty() {
                    let installed = result.unwrap();
                    assert_eq!(fs::read(&installed).unwrap(), ENTRY);
                    assert_eq!(fs::metadata(&installed).unwrap().mode() & 0o7777, 0o500);
                    // The only server has stopped, so success proves the cache was reused.
                    assert_eq!(
                        stage(&pin, &state, &path, &Default::default(), true).unwrap(),
                        installed
                    );
                    fs::set_permissions(&installed, fs::Permissions::from_mode(0o700)).unwrap();
                    fs::write(&installed, b"tampered").unwrap();
                    fs::set_permissions(&installed, fs::Permissions::from_mode(0o500)).unwrap();
                    assert!(stage(&pin, &state, &path, &Default::default(), true).is_err());
                } else {
                    assert_eq!(
                        result,
                        Err(if fault == "size" {
                            "runtime archive size mismatch"
                        } else {
                            "runtime archive digest mismatch"
                        })
                    );
                    assert!(state.cached_package(&pin.cache()).unwrap().is_none());
                    fs::write(path.join("runtime-package.next/interrupted"), b"partial").unwrap();
                    pin.bytes = bytes.len() as u64;
                    pin.sha256 = expected;
                }
            }
        }
    }
}
