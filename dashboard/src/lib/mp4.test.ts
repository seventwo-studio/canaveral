import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { verifyMp4 } from "./mp4";

// Produced by FFmpeg with the runner's exact encoder arguments (src/mobile-video.ts).
const fixture = new Uint8Array(
  readFileSync(resolve(process.cwd(), "e2e/fixtures/capture.mp4")),
);
function boxStarts(data: Uint8Array, type: string) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const starts: number[] = [];
  for (let at = 0; at < data.length; at += view.getUint32(at))
    if (String.fromCharCode(...data.subarray(at + 4, at + 8)) === type)
      starts.push(at);
  return starts;
}

it("summarizes frames, duration and size of a fragmented H.264 recording", () => {
  // ffprobe -count_frames reports 31 frames and 1.033333 s for this file.
  expect(verifyMp4(fixture)).toEqual({
    frames: 31,
    durationSeconds: 31 / 30,
    width: 64,
    height: 112,
    fragments: 5,
  });
});

it("rejects truncated, reordered or inconsistent recordings", () => {
  expect(() => verifyMp4(new Uint8Array())).toThrow(/does not start with ftyp/);
  // Truncated anywhere inside the last box.
  for (const cut of [1, 100, fixture.length - 900])
    expect(() => verifyMp4(fixture.subarray(0, fixture.length - cut))).toThrow(
      /truncated/,
    );
  // A complete-looking file whose last fragment lost its media data.
  const lastMdat = boxStarts(fixture, "mdat").at(-1)!;
  expect(() => verifyMp4(fixture.subarray(0, lastMdat))).toThrow(
    /last fragment has no media/,
  );
  // Only the initialization segment.
  const firstMoof = boxStarts(fixture, "moof")[0]!;
  expect(() => verifyMp4(fixture.subarray(0, firstMoof))).toThrow(
    /no video frames/,
  );
  // Fragment data without the movie header.
  const ftyp = fixture.subarray(0, boxStarts(fixture, "moov")[0]);
  const withoutMovie = new Uint8Array([
    ...ftyp,
    ...fixture.subarray(firstMoof),
  ]);
  expect(() => verifyMp4(withoutMovie)).toThrow(/one movie header/);
  // A sample run whose data offset no longer points at its media data.
  const altered = fixture.slice();
  const trun = Buffer.from(altered).indexOf("trun", firstMoof) - 4;
  const view = new DataView(altered.buffer);
  view.setInt32(trun + 16, view.getInt32(trun + 16) + 1);
  expect(() => verifyMp4(altered)).toThrow(/do not match their media data/);
});

it("rejects a sample count beyond the file without iterating it", () => {
  const data = fixture.slice();
  const at = boxStarts(data, "moof")[0]!;
  // The first trun inside the first fragment; its sample count follows version/flags.
  let found = -1;
  for (let i = at; i < data.length - 4; i++)
    if (String.fromCharCode(...data.subarray(i, i + 4)) === "trun") {
      found = i;
      break;
    }
  new DataView(data.buffer).setUint32(found + 8, 0xffffffff);
  const started = performance.now();
  expect(() => verifyMp4(data)).toThrow(/malformed|exceeds/);
  expect(performance.now() - started).toBeLessThan(200);
});
