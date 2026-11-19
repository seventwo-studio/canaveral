import { api } from "./api";
import { operate } from "./machine-operations";
import { verifyMp4, type Mp4Summary } from "./mp4";
import { record } from "./types";

/** Device output is bounded to 4 MiB by the mobile providers. */
const MAX_SCREENSHOT = 4 * 1048576;
/** The dashboard holds a recording in memory; keep it well below the 512 MiB stream budget. */
export const MAX_RECORDING = 128 * 1048576;
export const RECORDING_BIT_RATE = 4_000_000;
/** The runner answers broker pings only between messages, and the broker drops a
 * peer after 30 s without a pong; keep each capture inside that window. */
export const RECORDING_DURATIONS = [5, 10, 15, 20] as const;
const IDLE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Keeps a readable, portable base name and appends the extension. */
export function captureFileName(name: string, extension: "png" | "mp4") {
  const base = name
    .trim()
    .replace(/\.(png|mp4)$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 100);
  if (!base) throw Error("Enter a file name.");
  return base + "." + extension;
}
export function defaultCaptureName(prefix: string, now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Decodes the screenshot operation result and checks the PNG signature and header. */
export function screenshotPng(result: Record<string, unknown>) {
  if (result.mediaType !== "image/png" || typeof result.data !== "string")
    throw Error("The device did not return a PNG screenshot.");
  let raw: string;
  try {
    raw = atob(result.data);
  } catch {
    throw Error("The screenshot data is not valid base64.");
  }
  if (!raw.length || raw.length > MAX_SCREENSHOT)
    throw Error("The screenshot is empty or exceeds 4 MiB.");
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 33 ||
    signature.some((b, i) => bytes[i] !== b) ||
    view.getUint32(8) !== 13 ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    throw Error("The screenshot is not a valid PNG image.");
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height) throw Error("The screenshot has no picture size.");
  return { bytes, width, height };
}
export async function takeScreenshot(machineId: string) {
  return screenshotPng(await operate(machineId, "screenshot"));
}

export interface VideoSessionReceipt {
  id: string;
  machineId: string;
  generation: string;
  state: string;
}
function videoSession(
  value: unknown,
  expected: { id: string; machineId: string },
) {
  const r = record(value);
  if (
    r.id !== expected.id ||
    r.machineId !== expected.machineId ||
    typeof r.generation !== "string" ||
    !UUID.test(r.generation) ||
    r.capability !== "video" ||
    r.protocol !== "canaveral-session-v1" ||
    typeof r.state !== "string"
  )
    throw Error("Invalid video session receipt.");
  return r as unknown as VideoSessionReceipt;
}
const sessionPath = (machineId: string, id: string) =>
  `machines/${machineId}/video-sessions/${id}`;
export function readVideoSession(machineId: string, id: string) {
  return api(sessionPath(machineId, id), undefined, (v) =>
    videoSession(v, { id, machineId }),
  );
}
/** Ends capture authorization through the supported close route. The runner then
 * reports positive native cleanup, which releases the session's reservation. */
export function closeVideoSession(
  machineId: string,
  id: string,
  keepalive = false,
) {
  if (keepalive) {
    // Survives page unload. The gateway requires a same-origin JSON POST.
    void fetch(`/api/v1/${sessionPath(machineId, id)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      keepalive: true,
      redirect: "error",
    }).catch(() => {});
    return Promise.resolve();
  }
  return api(sessionPath(machineId, id) + "/close", {}, (v) =>
    videoSession(v, { id, machineId }),
  );
}

export interface Recording extends Mp4Summary {
  data: Uint8Array;
  bytes: number;
  sha256: string;
}
export interface RecordOptions {
  durationSeconds: number;
  signal: AbortSignal;
  /** Called with the browser-chosen session ID before the create request, so the caller
   * can close the session even when the create outcome is unknown or cancelled. */
  onRequest(id: string): void;
  /** Called once the session exists, before attachment, so the caller can close it. */
  onSession(session: VideoSessionReceipt): void;
  onProgress(
    state: "attaching" | "recording" | "verifying",
    bytes: number,
  ): void;
  socket?: (url: string) => WebSocket;
}
async function sha256(data: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function keys(value: Record<string, unknown>) {
  return Object.keys(value).sort().join(",");
}

/** Records one native MP4 session through the dashboard relay. Success requires
 * the runner's completion receipt, a matching byte count and SHA-256, and a
 * structurally complete MP4 before the acknowledgement is sent. */
export async function recordVideo(
  machineId: string,
  options: RecordOptions,
): Promise<Recording> {
  if (!RECORDING_DURATIONS.includes(options.durationSeconds as never))
    throw Error("Choose a supported recording length.");
  const id = crypto.randomUUID();
  options.onRequest(id);
  if (options.signal.aborted) throw Error("Recording cancelled.");
  const session = await api(
    `machines/${machineId}/video-sessions`,
    {
      id,
      fps: 30,
      durationSeconds: options.durationSeconds,
      bitRate: RECORDING_BIT_RATE,
    },
    (v) => videoSession(v, { id, machineId }),
  );
  options.onSession(session);
  if (options.signal.aborted) throw Error("Recording cancelled.");
  const url = new URL(
    `/api/v1/${sessionPath(machineId, id)}/${session.generation}`,
    location.href,
  );
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = options.socket
    ? options.socket(url.href)
    : new WebSocket(url.href, ["canaveral-session-v1"]);
  socket.binaryType = "arraybuffer";
  options.onProgress("attaching", 0);
  return await new Promise<Recording>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0,
      stage:
        "ready" | "video" | "format" | "media" | "verifying" | "acknowledged" =
        "ready",
      result: Recording | undefined,
      done = false,
      idle: ReturnType<typeof setTimeout> | undefined;
    const overall = setTimeout(
      () => finish(Error("The recording did not finish in time.")),
      (options.durationSeconds + 90) * 1000,
    );
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => finish(Error("The recording stream stalled.")),
        IDLE_MS,
      );
    };
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(overall);
      clearTimeout(idle);
      options.signal.removeEventListener("abort", abort);
      if (socket.readyState < 2) socket.close(); // CONNECTING or OPEN
      if (error || !result) reject(error ?? Error("Recording is incomplete."));
      else resolve(result);
    }
    const abort = () => finish(Error("Recording cancelled; no file was kept."));
    options.signal.addEventListener("abort", abort, { once: true });
    arm();
    socket.onopen = () => {
      if (socket.protocol !== "canaveral-session-v1")
        finish(Error("The recording stream used an unexpected protocol."));
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      // The host closes after it receives the acknowledgement.
      if (stage === "acknowledged") finish();
      else
        finish(
          Error("The recording stream closed before a verified completion."),
        );
    };
    socket.onmessage = (event: MessageEvent) => {
      if (done) return;
      arm();
      void (async () => {
        if (event.data instanceof ArrayBuffer) {
          // Media is accepted only after the format message and before verification.
          if (stage !== "media" && stage !== "format")
            throw Error("Unexpected video data.");
          stage = "media";
          const chunk = new Uint8Array(event.data);
          if (!chunk.length || chunk.length > 65536)
            throw Error("A video chunk exceeded its envelope.");
          bytes += chunk.length;
          if (bytes > MAX_RECORDING)
            throw Error("The recording exceeds the dashboard's 128 MiB limit.");
          chunks.push(chunk);
          options.onProgress("recording", bytes);
          return;
        }
        if (typeof event.data !== "string") throw Error("Invalid message.");
        const message = record(JSON.parse(event.data));
        if (message.type === "error")
          throw Error(
            (typeof message.message === "string"
              ? message.message
              : "Native video capture failed.") +
              " The recording is incomplete.",
          );
        if (stage === "ready") {
          if (
            message.type !== "ready" ||
            message.sessionId !== id ||
            message.generation !== session.generation ||
            message.capability !== "video"
          )
            throw Error("The video peers did not become ready.");
          stage = "video";
          return;
        }
        if (stage === "video" && message.type === "video") {
          if (
            keys(message) !== "codec,fps,mediaType,type" ||
            message.mediaType !== "video/mp4" ||
            message.codec !== "avc1" ||
            message.fps !== 30
          )
            throw Error("Unexpected video format.");
          stage = "format";
          options.onProgress("recording", 0);
          return;
        }
        if (stage !== "media" || message.type !== "finish")
          throw Error("Unexpected recording message.");
        if (
          keys(message) !== "bytes,cleaned,sha256,type" ||
          message.bytes !== bytes ||
          message.cleaned !== true ||
          typeof message.sha256 !== "string"
        )
          throw Error("The recording size or cleanup was not confirmed.");
        // Nothing else is accepted while the snapshot is verified.
        stage = "verifying";
        options.onProgress("verifying", bytes);
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        chunks.length = 0;
        const digest = await sha256(data);
        if (digest !== message.sha256)
          throw Error("The recording checksum did not match.");
        const summary = verifyMp4(data);
        if (done) return;
        result = { ...summary, data, bytes, sha256: digest };
        stage = "acknowledged";
        socket.send(JSON.stringify({ type: "ack" }));
      })().catch((error: unknown) =>
        finish(
          error instanceof Error ? error : Error("Invalid recording message."),
        ),
      );
    };
  });
}
