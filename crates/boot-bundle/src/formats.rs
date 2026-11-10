//! Header layouts: Linux fs/erofs/erofs_fs.h, include/uapi/linux/elf.h,
//! arch/arm64/include/asm/image.h. Header checks are not mountability proofs.
use canaveral_guest_protocol::Result;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};
fn read(f: &mut File, offset: u64, n: usize) -> Result<Vec<u8>> {
    f.seek(SeekFrom::Start(offset))?;
    let mut b = vec![0; n];
    f.read_exact(&mut b)?;
    Ok(b)
}
fn u16le(b: &[u8]) -> u16 {
    u16::from_le_bytes(b[..2].try_into().unwrap())
}
fn u32le(b: &[u8]) -> u32 {
    u32::from_le_bytes(b[..4].try_into().unwrap())
}
fn u64le(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}
pub fn kernel(f: &mut File) -> Result<()> {
    let b = read(f, 0, 64)?;
    if &b[56..60] != b"ARM\x64"
        || b.starts_with(b"MZ")
        || u64le(&b[16..]) == 0
        || u64le(&b[24..]) & 1 != 0
    {
        return Err("expected uncompressed little-endian ARM64 Image".into());
    }
    Ok(())
}
pub fn erofs(f: &mut File) -> Result<uuid::Uuid> {
    let b = read(f, 1024, 128)?;
    if u32le(&b) != 0xe0f5e1e2 || !(9..=16).contains(&b[12]) || u32le(&b[36..]) == 0 {
        return Err("invalid EROFS header".into());
    }
    Ok(uuid::Uuid::from_bytes(b[48..64].try_into()?))
}
pub fn elf(f: &mut File) -> Result<()> {
    let b = read(f, 0, 64)?;
    if &b[..7] != b"\x7fELF\x02\x01\x01"
        || u16le(&b[16..]) != 2
        || u16le(&b[18..]) != 183
        || u32le(&b[20..]) != 1
        || u16le(&b[52..]) != 64
        || u16le(&b[54..]) != 56
    {
        return Err("expected static AArch64 ELF64 ET_EXEC".into());
    }
    let n = u16le(&b[56..]);
    let start = u64le(&b[32..]);
    let size = f.metadata()?.len();
    if n == 0
        || n > 1024
        || start < 64
        || start
            .checked_add(n as u64 * 56)
            .is_none_or(|end| end > size)
    {
        return Err("invalid ELF program table".into());
    }
    let mut entry = false;
    for i in 0..n {
        let p = read(f, start + i as u64 * 56, 56)?;
        let kind = u32le(&p);
        if kind == 3 || kind == 2 {
            return Err("dynamic/interpreted bootstrap forbidden".into());
        }
        if kind == 1 {
            let off = u64le(&p[8..]);
            let va = u64le(&p[16..]);
            let fs = u64le(&p[32..]);
            let mem = u64le(&p[40..]);
            if fs > mem || off.checked_add(fs).is_none_or(|e| e > size) {
                return Err("invalid ELF load segment".into());
            }
            let e = u64le(&b[24..]);
            if u32le(&p[4..]) & 1 != 0 && e >= va && e - va < fs {
                entry = true
            }
        }
    }
    if !entry {
        return Err("ELF entry outside executable load segment".into());
    }
    Ok(())
}
pub fn cpio(out: &mut File, init: &mut File, size: u32, epoch: u32) -> Result<()> {
    fn header(
        out: &mut File,
        name: &str,
        ino: u32,
        mode: u32,
        size: u32,
        epoch: u32,
    ) -> Result<()> {
        write!(out,"070701{ino:08x}{mode:08x}{:08x}{:08x}{:08x}{epoch:08x}{size:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}",0,0,if mode&0o170000==0o040000{2}else{1},0,0,0,0,name.len()+1,0)?;
        out.write_all(name.as_bytes())?;
        out.write_all(&[0])?;
        pad(out, 4)?;
        Ok(())
    }
    fn pad(out: &mut File, n: u64) -> Result<()> {
        let count = (n - out.stream_position()? % n) % n;
        out.write_all(&vec![0; count as usize])?;
        Ok(())
    }
    for (i, name) in [
        "dev",
        "etc",
        "etc/canaveral",
        "init",
        "newroot",
        "proc",
        "sys",
    ]
    .iter()
    .enumerate()
    {
        let is_init = *name == "init";
        header(
            out,
            name,
            i as u32 + 1,
            if is_init { 0o100500 } else { 0o040700 },
            if is_init { size } else { 0 },
            epoch,
        )?;
        if is_init {
            init.seek(SeekFrom::Start(0))?;
            if std::io::copy(&mut init.take(size as u64), out)? != size as u64 {
                return Err("short bootstrap".into());
            }
            pad(out, 4)?;
        }
    }
    header(out, "TRAILER!!!", 0, 0, 0, 0)?;
    pad(out, 512)?;
    Ok(())
}
