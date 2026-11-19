/** Structural checks for the runner's fragmented H.264 MP4 output.
 * This walks box headers and fragment sample tables; it does not decode video. */
export interface Mp4Summary {
  frames: number;
  durationSeconds: number;
  width: number;
  height: number;
  fragments: number;
}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}
const textDecoder = new TextDecoder("latin1");
function fail(detail: string): never {
  throw new Error("The recording is not a complete MP4: " + detail + ".");
}
function boxes(view: DataView, start: number, end: number): Box[] {
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) fail("a box header is truncated");
    let size = view.getUint32(offset);
    let body = offset + 8;
    const type = textDecoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4),
    );
    if (size === 1) {
      if (end - offset < 16) fail("a box header is truncated");
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail("a box is too large");
      size = Number(large);
      body = offset + 16;
    }
    if (size === 0) fail("a box has no declared length");
    if (!/^[\x20-\x7e]{4}$/.test(type)) fail("a box type is invalid");
    if (size < body - offset || offset + size > end)
      fail(`the ${type} box is truncated`);
    result.push({ type, start: offset, body, end: offset + size });
    offset += size;
  }
  return result;
}
function child(view: DataView, parent: Box, type: string): Box {
  const found = boxes(view, parent.body, parent.end).filter(
    (b) => b.type === type,
  );
  if (found.length !== 1) fail(`${parent.type} needs one ${type} box`);
  return found[0]!;
}
function need(box: Box, offset: number, bytes: number): number {
  if (box.body + offset + bytes > box.end) fail(`the ${box.type} box is short`);
  return box.body + offset;
}

/** Verifies the box envelope, one AVC video track, fragment sequencing, and
 * that every fragment's sample table covers exactly its following media data. */
export function verifyMp4(data: Uint8Array): Mp4Summary {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const top = boxes(view, 0, data.byteLength);
  if (top[0]?.type !== "ftyp") fail("it does not start with ftyp");
  const moovs = top.filter((b) => b.type === "moov");
  if (moovs.length !== 1) fail("it needs one movie header");
  const moov = moovs[0]!;
  const traks = boxes(view, moov.body, moov.end).filter(
    (b) => b.type === "trak",
  );
  if (traks.length !== 1) fail("it needs exactly one track");
  const trak = traks[0]!;
  const tkhd = child(view, trak, "tkhd");
  const tkhdVersion = view.getUint8(need(tkhd, 0, 1));
  const track = view.getUint32(need(tkhd, tkhdVersion === 1 ? 20 : 12, 4));
  const dimensions = need(tkhd, tkhdVersion === 1 ? 88 : 76, 8);
  const width = Math.round(view.getUint32(dimensions) / 65536);
  const height = Math.round(view.getUint32(dimensions + 4) / 65536);
  if (width < 1 || height < 1) fail("the track has no picture size");
  const mdia = child(view, trak, "mdia");
  const mdhd = child(view, mdia, "mdhd");
  const timescale = view.getUint32(
    need(mdhd, view.getUint8(need(mdhd, 0, 1)) === 1 ? 20 : 12, 4),
  );
  if (!timescale) fail("the track has no timescale");
  const hdlr = child(view, mdia, "hdlr");
  if (
    textDecoder.decode(data.subarray(need(hdlr, 8, 4), hdlr.body + 12)) !==
    "vide"
  )
    fail("the track is not video");
  const stbl = child(view, child(view, mdia, "minf"), "stbl");
  const stsd = child(view, stbl, "stsd");
  if (view.getUint32(need(stsd, 4, 4)) !== 1)
    fail("the track needs one sample description");
  const entry = boxes(view, stsd.body + 8, stsd.end)[0];
  if (entry?.type !== "avc1") fail("the track is not H.264");
  if (
    !boxes(view, need(entry, 78, 0), entry.end).some((b) => b.type === "avcC")
  )
    fail("the H.264 configuration is missing");
  const mvex = child(view, moov, "mvex");
  const trex = boxes(view, mvex.body, mvex.end).find((b) => b.type === "trex");
  if (!trex || view.getUint32(need(trex, 4, 4)) !== track)
    fail("the fragment defaults are missing");
  const trexDuration = view.getUint32(need(trex, 12, 4));
  const trexSize = view.getUint32(need(trex, 16, 4));
  const trexFlags = view.getUint32(need(trex, 20, 4));

  let frames = 0,
    duration = 0,
    fragments = 0,
    sequence = 0,
    first = true,
    pending: { start: number; end: number } | undefined;
  let movie = false;
  for (const box of top) {
    if (box.type === "moov") movie = true;
    if (pending && box.type !== "mdat")
      fail("a fragment is not followed by its media");
    if (box.type === "mdat") {
      if (!pending) fail("media data has no fragment");
      if (pending.start !== box.body || pending.end !== box.end)
        fail("fragment samples do not match their media data");
      pending = undefined;
      continue;
    }
    if (box.type !== "moof") continue;
    if (!movie) fail("a fragment precedes the movie header");
    const mfhd = child(view, box, "mfhd");
    const next = view.getUint32(need(mfhd, 4, 4));
    if (next <= sequence) fail("fragments are out of order");
    sequence = next;
    const traf = child(view, box, "traf");
    const tfhd = child(view, traf, "tfhd");
    const tfFlags = view.getUint32(need(tfhd, 0, 4)) & 0xffffff;
    if (view.getUint32(need(tfhd, 4, 4)) !== track)
      fail("a fragment names another track");
    let at = 8,
      base = box.start;
    if (tfFlags & 0x1) {
      const value = view.getBigUint64(need(tfhd, at, 8));
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail("a base offset is invalid");
      base = Number(value);
      at += 8;
    }
    if (tfFlags & 0x2) at += 4;
    let defaultDuration = trexDuration,
      defaultSize = trexSize,
      defaultFlags = trexFlags;
    if (tfFlags & 0x8) {
      defaultDuration = view.getUint32(need(tfhd, at, 4));
      at += 4;
    }
    if (tfFlags & 0x10) {
      defaultSize = view.getUint32(need(tfhd, at, 4));
      at += 4;
    }
    if (tfFlags & 0x20) defaultFlags = view.getUint32(need(tfhd, at, 4));
    const truns = boxes(view, traf.body, traf.end).filter(
      (b) => b.type === "trun",
    );
    if (truns.length !== 1) fail("a fragment needs one sample run");
    const trun = truns[0]!;
    const runFlags = view.getUint32(need(trun, 0, 4)) & 0xffffff;
    const count = view.getUint32(need(trun, 4, 4));
    if (!count) fail("a fragment has no samples");
    // Every sample has at least one byte, so a count beyond the file is malformed.
    if (count > view.byteLength) fail("a sample run is malformed");
    if (!(runFlags & 0x1)) fail("a sample run has no data offset");
    const start = base + view.getInt32(need(trun, 8, 4));
    let cursor = 12,
      firstFlags: number | undefined;
    if (runFlags & 0x4) {
      firstFlags = view.getUint32(need(trun, cursor, 4));
      cursor += 4;
    }
    const fields = [0x100, 0x200, 0x400, 0x800].filter((f) => runFlags & f);
    if (trun.end - trun.body - cursor !== count * fields.length * 4)
      fail("a sample run is malformed");
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      let sampleDuration = defaultDuration,
        size = defaultSize,
        flags = i === 0 && firstFlags !== undefined ? firstFlags : defaultFlags;
      for (const field of fields) {
        const value = view.getUint32(trun.body + cursor);
        cursor += 4;
        if (field === 0x100) sampleDuration = value;
        else if (field === 0x200) size = value;
        else if (field === 0x400 && !(i === 0 && firstFlags !== undefined))
          flags = value;
      }
      if (!size) fail("a sample is empty");
      // sample_is_non_sync_sample: playback must begin on a key frame.
      if (first && flags & 0x10000) fail("it does not start on a key frame");
      first = false;
      bytes += size;
      if (bytes > view.byteLength) fail("a sample run exceeds the file");
      duration += sampleDuration;
      frames++;
    }
    pending = { start, end: start + bytes };
    fragments++;
  }
  if (pending) fail("the last fragment has no media");
  if (!frames || !duration) fail("it contains no video frames");
  return {
    frames,
    durationSeconds: duration / timescale,
    width,
    height,
    fragments,
  };
}
