import { initSegment } from "./mp4";

/** Plays ordered fragmented-MP4 segments in a `<video>` through Media Source Extensions.
 *
 * It knows nothing about where segments come from. An initialization segment names the codec and
 * starts or restarts decoding; media segments are appended in order. Segments are appended in
 * `sequence` mode, so a later epoch, or a gap where the sender dropped a viewer's backlog, continues
 * on one timeline instead of leaving a hole the element would wait in.
 *
 * Verified in Chromium against segments cut from an FFmpeg recording made with the runner's encoder
 * arguments. A live stream from a native device has not been played, and `ManagedMediaSource`
 * (iPhone Safari, which has no `MediaSource`) is selected here but has not been tried on a device. */
/** The element stays within this many seconds of the newest frame. */
const LIVE_EDGE_SECONDS = 1.5;
/** Played video kept behind the playhead, and how much may pile up before it is trimmed. */
const KEEP_SECONDS = 10,
  TRIM_AFTER_SECONDS = 30;
/** Segments waiting for the decoder. Beyond this the browser is not keeping up. */
const MAX_QUEUED_BYTES = 32 * 1048576;

export interface LivePlayer {
  /** Starts or restarts decoding with an epoch's initialization segment. */
  init(data: Uint8Array): void;
  append(data: Uint8Array): void;
  destroy(): void;
}
export interface PlayerEvents {
  /** The first frame is on screen, with the picture size the stream declared. */
  onPicture(size: { width: number; height: number }): void;
  /** Playback cannot continue in this browser; the text says why. */
  onProblem(message: string): void;
}
type SourceConstructor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};
function mediaSource(): { Source: SourceConstructor; managed: boolean } | null {
  const scope = globalThis as unknown as {
    MediaSource?: SourceConstructor;
    ManagedMediaSource?: SourceConstructor;
  };
  if (scope.MediaSource) return { Source: scope.MediaSource, managed: false };
  if (scope.ManagedMediaSource)
    return { Source: scope.ManagedMediaSource, managed: true };
  return null;
}

export function createLivePlayer(
  video: HTMLVideoElement,
  events: PlayerEvents,
): LivePlayer {
  const found = mediaSource();
  let failed = false,
    destroyed = false,
    shown = false,
    buffer: SourceBuffer | undefined,
    mime = "",
    size = { width: 0, height: 0 },
    queued = 0;
  /** Segments in arrival order. An initialization segment carries the format it announces, so the
   * decoder is created or switched exactly where that segment sits in the stream. */
  const queue: { data: Uint8Array; type?: string }[] = [];
  function problem(message: string) {
    if (failed || destroyed) return;
    failed = true;
    queue.length = 0;
    events.onProblem(message);
  }
  if (!found) {
    // Reported after the caller has its handle.
    queueMicrotask(() =>
      problem(
        "This browser cannot play a live stream: it has no Media Source Extensions.",
      ),
    );
    return {
      init() {},
      append() {},
      destroy() {
        destroyed = true;
      },
    };
  }
  const source = new found.Source();
  const url = URL.createObjectURL(source);
  // A managed source plays only in an element that does not offer remote playback.
  if (found.managed) video.disableRemotePlayback = true;
  video.src = url;

  function pump() {
    if (failed || destroyed || source.readyState !== "open") return;
    if (buffer?.updating) return;
    const next = queue[0];
    if (!next) return;
    try {
      if (next.type !== undefined) {
        if (!buffer) {
          if (!found!.Source.isTypeSupported(next.type)) {
            problem("This browser cannot decode the device's H.264 video.");
            return;
          }
          buffer = source.addSourceBuffer(next.type);
          buffer.mode = "sequence";
          buffer.addEventListener("updateend", settle);
          buffer.addEventListener("error", () =>
            problem("The browser could not decode the video stream."),
          );
        } else if (next.type !== mime && "changeType" in buffer)
          // A later epoch may be encoded with another profile or level.
          buffer.changeType(next.type);
        mime = next.type;
      }
      // Media before any initialization segment cannot be decoded and is not appended.
      if (!buffer) {
        queue.shift();
        queued -= next.data.length;
        pump();
        return;
      }
      queue.shift();
      queued -= next.data.length;
      buffer.appendBuffer(next.data as BufferSource);
    } catch {
      problem("The browser refused the video stream.");
    }
  }
  function settle() {
    if (failed || destroyed || !buffer) return;
    const ranges = buffer.buffered;
    if (ranges.length) {
      const start = ranges.start(0),
        end = ranges.end(ranges.length - 1);
      // Follow the newest frame: a watcher wants now, not a growing delay.
      if (end - video.currentTime > LIVE_EDGE_SECONDS)
        video.currentTime = Math.max(start, end - 0.2);
      if (video.paused) void video.play().catch(() => {});
      if (!buffer.updating && video.currentTime - start > TRIM_AFTER_SECONDS) {
        try {
          buffer.remove(start, video.currentTime - KEEP_SECONDS);
          return;
        } catch {
          /* Trimming is retried after the next append. */
        }
      }
    }
    pump();
  }
  const frame = () => {
    if (shown || failed || destroyed || !video.videoWidth) return;
    shown = true;
    events.onPicture(size);
  };
  const broken = () =>
    problem("The browser could not decode the video stream.");
  video.addEventListener("loadeddata", frame);
  video.addEventListener("playing", frame);
  video.addEventListener("error", broken);
  source.addEventListener("sourceopen", pump);

  function enqueue(data: Uint8Array, type?: string) {
    if (failed || destroyed) return;
    queue.push(type === undefined ? { data } : { data, type });
    queued += data.length;
    if (queued > MAX_QUEUED_BYTES)
      problem("The browser is not keeping up with the video stream.");
    else pump();
  }
  return {
    init(data) {
      if (failed || destroyed) return;
      try {
        const info = initSegment(data);
        size = { width: info.width, height: info.height };
        enqueue(data, `video/mp4; codecs="${info.codec}"`);
      } catch {
        problem("The video stream did not start with a valid header.");
      }
    },
    append: (data) => enqueue(data),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      queue.length = 0;
      video.removeEventListener("loadeddata", frame);
      video.removeEventListener("playing", frame);
      video.removeEventListener("error", broken);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}
