//! Bounded local authoring, not a distro builder or installation authority.
#![cfg(unix)]
pub mod bootstrap;
mod files;
mod formats;
mod inputs;
mod recipe;
pub use inputs::{verify_inputs, InputReport};
use canaveral_guest_protocol::{
    bundle::{Artifact, Manifest},
    Result,
};
pub use recipe::Recipe;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

/// Assemble into an exclusively published new directory. Never execute an input.
pub fn assemble(recipe: &[u8], inputs: &Path, output: &Path) -> Result<Manifest> {
    let recipe = Recipe::parse(recipe)?;
    let source = files::directory(inputs)?;
    let mut stage = files::Stage::new(output)?;
    let mut held = Vec::new();
    for (pin, name, limit) in [
        (&recipe.kernel, "Image", 256 << 20),
        (&recipe.rootfs, "rootfs.erofs", 8u64 << 30),
        (&recipe.bootstrap, "bootstrap", 64 << 20),
    ] {
        if pin.size > limit {
            return Err("artifact exceeds authoring bound".into());
        }
        let mut input = files::relative(&source, &pin.path)?;
        let before = input.metadata()?;
        files::regular(&before, pin.size)?;
        let mut dest = stage.create(name)?;
        let mut hash = Sha256::new();
        let mut left = pin.size;
        let mut buf = [0; 65536];
        while left != 0 {
            let take = left.min(buf.len() as u64) as usize;
            let n = input.read(&mut buf[..take])?;
            if n == 0 {
                return Err("short artifact".into());
            }
            hash.update(&buf[..n]);
            dest.write_all(&buf[..n])?;
            left -= n as u64;
        }
        if input.read(&mut buf[..1])? != 0 || format!("{:x}", hash.finalize()) != pin.sha256 {
            return Err("input digest/size mismatch".into());
        }
        files::unchanged(&before, &input.metadata()?)?;
        dest.sync_all()?;
        dest.seek(SeekFrom::Start(0))?;
        if hash_file(&mut dest)? != pin.sha256 {
            return Err("copy digest mismatch".into());
        }
        dest.seek(SeekFrom::Start(0))?;
        match name {
            "Image" => formats::kernel(&mut dest)?,
            "rootfs.erofs" => {
                formats::erofs(&mut dest)?;
            }
            _ => formats::elf(&mut dest)?,
        }
        held.push((input, before, pin.path.clone()));
    }
    let mut bootstrap = stage.open("bootstrap")?;
    let mut initrd = stage.create("initrd.cpio")?;
    formats::cpio(
        &mut initrd,
        &mut bootstrap,
        recipe.bootstrap.size as u32,
        recipe.epoch,
    )?;
    initrd.sync_all()?;
    initrd.seek(SeekFrom::Start(0))?;
    let initrd_pin = Artifact {
        path: "initrd.cpio".into(),
        size: initrd.metadata()?.len(),
        sha256: hash_file(&mut initrd)?,
    };
    let mut manifest = recipe.manifest();
    manifest.kernel.path = "Image".into();
    manifest.rootfs.path = "rootfs.erofs".into();
    manifest.initrd = Some(initrd_pin);
    stage.write("manifest.json", &manifest.canonical_bytes()?)?;
    stage.write("image.digest", manifest.digest()?.as_bytes())?;
    stage.write("recipe.json", &serde_json::to_vec(&recipe)?)?;
    // The prebuilt bootstrap is carried only by initrd in the published bundle.
    stage.remove("bootstrap")?;
    for (file, before, path) in held {
        files::unchanged(&before, &file.metadata()?)?;
        files::unchanged(&before, &files::relative(&source, &path)?.metadata()?)?;
    }
    stage.publish()?;
    Ok(manifest)
}
fn hash_file(file: &mut File) -> Result<String> {
    let mut h = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

/// Read a bounded, stable, single-link recipe without following path links.
pub fn read_recipe(path: &Path) -> Result<Vec<u8>> {
    let parent = files::directory(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid recipe path")?;
    let mut f = files::relative(&parent, name)?;
    let before = f.metadata()?;
    files::regular(&before, before.len())?;
    if before.len() > 1024 * 1024 {
        return Err("recipe too large".into());
    }
    let mut bytes = Vec::new();
    (&mut f).take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    files::unchanged(&before, &f.metadata()?)?;
    files::unchanged(&before, &files::relative(&parent, name)?.metadata()?)?;
    if bytes.len() as u64 != before.len() {
        return Err("recipe changed".into());
    }
    Ok(bytes)
}
