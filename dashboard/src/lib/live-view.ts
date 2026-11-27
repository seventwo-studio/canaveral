import { api, errorMessage } from "./api";
import { record } from "./types";

/** One viewer's live view of an account-owned mobile device, through the dashboard gateway's relay.
 *
 * This is the only module that knows the live-view routes and messages; see "Owner live screen" in
 * docs/dashboard.md and "Live screen" in docs/mobile-control.md. The page that shows screens uses
 * `watchLive` and nothing else, so a change to the relay is a change here.
 *
 * A view is watch-only. The page sends one message, `{type:"renew"}`, and only while its picture is
 * on screen: a view that is not renewed lapses, and the device's capture stops with its last view.
 * The controller refuses a leased device on this route, and the page never offers one; a leased
 * device's screen belongs to its lease holder.
 *
 * Fixture coverage only. No native device, emulator or simulator has streamed through this module. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROTOCOL = "canaveral-session-v1";
/** Lifetime asked for each view, within the route's 10 to 120 seconds. A short one frees the host's
 * capture sooner after a tile leaves the screen; the cost is one small renewal message every third
 * of it while watching. */
export const VIEW_TTL_SECONDS = 60;
const RENEW_MS = (VIEW_TTL_SECONDS * 1000) / 3;
/** The relay's envelope: binary messages of at most 64 KiB, an initialization segment of at most
 * 1 MiB and a media segment of at most 8 MiB. */
const MAX_CHUNK = 65536,
  MAX_INIT = 1048576,
  MAX_SEGMENT = 8 * 1048576;

export interface LiveSegment {
  epoch: number;
  sequence: number;
  keyframe: boolean;
  data: Uint8Array;
}
/** Why a view is over, in words for the tile. `again` says whether opening another view can
 * succeed: at once, after something else settles, or not while the cause stands. */
export interface LiveEnding {
  reason: string;
  message: string;
  again: "now" | "later" | "no";
  /** A short name for an ending that is an ordinary state of the device or its host rather than a
   * failure, such as a host that does not offer live views. Absent for failures. */
  state?: string;
  /** The session lost its access; the page should treat it as signed out or denied. */
  denied?: boolean;
}
export interface LiveHandlers {
  /** The host announced the stream. Segments follow when the screen produces frames. */
  onLive(): void;
  /** The initialization segment of an epoch (`ftyp` and `moov`). A decoder restarts with it. */
  onInit(epoch: number, data: Uint8Array): void;
  onSegment(segment: LiveSegment): void;
  /** Called once, when the view is over for any reason other than `close`. */
  onEnd(ending: LiveEnding): void;
}
export interface LiveView {
  /** Renew while true. Pass false whenever the picture is not on screen. */
  setWatched(watched: boolean): void;
  /** Leave the view. `keepalive` is for page unload, where no reply can be awaited. */
  close(keepalive?: boolean): void;
}

const endings: Record<string, Omit<LiveEnding, "reason">> = {
  closed: { message: "The view was closed.", again: "now", state: "Closed" },
  view_expired: {
    message: "The view lapsed while it was not on screen.",
    again: "now",
    state: "Paused",
  },
  attach_timeout: {
    message: "The device's host did not attach in time.",
    again: "later",
  },
  access_revoked: {
    message: "Your access to this device ended.",
    again: "no",
    denied: true,
  },
  device_stopped: {
    message: "The device stopped.",
    again: "no",
    state: "Stopped",
  },
  host_unavailable: {
    message: "The device's host is unavailable.",
    again: "later",
  },
  capture_ended: {
    message: "The device's capture ended.",
    again: "now",
  },
  preempted_by_recording: {
    message:
      "A recording on this device's host needed the capture slot this view was using.",
    again: "later",
  },
  capture_failed: {
    message: "The device's screen capture failed. It is not retried by itself.",
    again: "later",
  },
  capture_unavailable: {
    message:
      "A recording of this device ended without confirmed cleanup. Its screen cannot be captured until an administrator resolves that.",
    again: "no",
  },
  disconnected: { message: "The connection dropped.", again: "now" },
  controller_restarted: {
    message: "The controller restarted.",
    again: "now",
  },
  // Refusals when opening, and a host that does not serve live views (iOS is opt-in per host).
  capability_unsupported: {
    message:
      "Live view is not offered by this device's host. For iOS it is off unless the host opts in.",
    again: "no",
    state: "Not offered",
  },
  device_recording_active: {
    message:
      "This device is recording or awaiting recording cleanup. Try again after recording ends and cleanup is confirmed.",
    again: "later",
  },
  capture_cleanup_pending: {
    message:
      "An earlier capture of this device is still being cleaned up. Try again shortly.",
    again: "later",
  },
  capture_cleanup_unproven: {
    message:
      "Cleanup of an earlier capture of this device is unproven. Its screen stays unavailable until cleanup is confirmed.",
    again: "no",
  },
  live_view_limit: {
    message:
      "This device or its host already has as many viewers as it accepts.",
    again: "later",
    state: "Full",
  },
  not_found: {
    message: "This device is not available to your account.",
    again: "no",
  },
  conflict: {
    message:
      "The device is leased or stopped, or its host has no capacity for a capture.",
    again: "later",
  },
  limit_exceeded: {
    message: "Every video session of the device's host is in use.",
    again: "later",
    state: "Full",
  },
};
export function liveEnding(reason: string, fallback?: string): LiveEnding {
  const known = Object.hasOwn(endings, reason) ? endings[reason] : undefined;
  return known
    ? { reason, ...known }
    : {
        reason,
        message: fallback ?? "The view ended.",
        again: "later",
      };
}
function refusal(error: unknown): LiveEnding {
  const status =
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 0,
    code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
  if (status === 401 || status === 403)
    return {
      reason: status === 401 ? "unauthenticated" : "forbidden",
      message: "Your session does not have access to this device.",
      again: "no",
      denied: true,
    };
  if (Object.hasOwn(endings, code)) return liveEnding(code);
  if (!status)
    return {
      reason: "unavailable",
      message: errorMessage(error),
      again: "now",
    };
  return liveEnding("refused", errorMessage(error));
}

function receipt(value: unknown, id: string, machineId: string) {
  const r = record(value);
  if (
    r.id !== id ||
    r.machineId !== machineId ||
    typeof r.generation !== "string" ||
    !UUID.test(r.generation) ||
    r.capability !== "live" ||
    r.protocol !== PROTOCOL ||
    r.mediaType !== "video/mp4" ||
    r.codec !== "avc1"
  )
    throw Error("Invalid live view receipt.");
  return { generation: r.generation };
}
const count = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;

/** Opens a view of one device and delivers its segments in order. The caller owns nothing but the
 * returned handle: leaving closes the socket and tells the controller, so the capture can stop. */
export function watchLive(
  machineId: string,
  handlers: LiveHandlers,
  socketFactory?: (url: string) => WebSocket,
): LiveView {
  const id = crypto.randomUUID(),
    path = `machines/${machineId}/live-views/${id}`;
  let socket: WebSocket | undefined,
    done = false,
    watched = true,
    ready = false,
    renewal: ReturnType<typeof setInterval> | undefined,
    // The segment being received: its announcement and the bytes that have arrived for it.
    pending:
      | {
          kind: "init" | "segment";
          epoch: number;
          sequence: number;
          keyframe: boolean;
          data: Uint8Array;
          received: number;
        }
      | undefined;

  /** Stops renewing and drops the socket. `tell` also closes the view on the controller, so the
   * capture can stop now rather than at its lifetime; a view the controller already ended needs none. */
  function leave(tell: boolean, keepalive = false) {
    clearInterval(renewal);
    if (socket && socket.readyState < 2) socket.close();
    if (!tell) return;
    void fetch(`/api/v1/${path}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      keepalive,
      redirect: "error",
    }).catch(() => {});
  }
  function end(ending: LiveEnding, tell = false) {
    if (done) return;
    done = true;
    leave(tell);
    handlers.onEnd(ending);
  }
  function renew() {
    if (!done && ready && watched && socket?.readyState === 1)
      socket.send(JSON.stringify({ type: "renew" }));
  }
  /** The socket closed without the host naming a reason: the controller recorded one. */
  async function closed() {
    if (done) return;
    let reason = "disconnected";
    try {
      const view = record(await api(path));
      if (typeof view.endReason === "string") reason = view.endReason;
    } catch {
      /* The record is unreadable, for example after the credential ended. */
    }
    end(liveEnding(reason));
  }
  function message(event: MessageEvent) {
    if (done) return;
    if (event.data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(event.data);
      if (
        !pending ||
        !chunk.length ||
        chunk.length > MAX_CHUNK ||
        pending.received + chunk.length > pending.data.length
      )
        throw Error("Unexpected stream data.");
      pending.data.set(chunk, pending.received);
      pending.received += chunk.length;
      if (pending.received < pending.data.length) return;
      const complete = pending;
      pending = undefined;
      if (complete.kind === "init")
        handlers.onInit(complete.epoch, complete.data);
      else
        handlers.onSegment({
          epoch: complete.epoch,
          sequence: complete.sequence,
          keyframe: complete.keyframe,
          data: complete.data,
        });
      return;
    }
    if (typeof event.data !== "string") throw Error("Invalid stream message.");
    const m = record(JSON.parse(event.data));
    // The broker's reply to a renewal may arrive anywhere, including inside a segment.
    if (m.type === "renewal") return;
    if (pending) throw Error("A segment was interrupted.");
    if (!ready) {
      if (m.type !== "ready" || m.sessionId !== id || m.capability !== "live")
        throw Error("The live view did not become ready.");
      ready = true;
      renewal = setInterval(renew, RENEW_MS);
      return;
    }
    if (m.type === "live") {
      if (m.mediaType !== "video/mp4" || m.codec !== "avc1")
        throw Error("Unexpected stream format.");
      handlers.onLive();
    } else if (m.type === "init" || m.type === "segment") {
      const segment = m.type === "segment";
      if (
        !count(m.epoch, Number.MAX_SAFE_INTEGER) ||
        !count(m.bytes, segment ? MAX_SEGMENT : MAX_INIT) ||
        m.bytes === 0 ||
        (segment &&
          (!count(m.sequence, Number.MAX_SAFE_INTEGER) ||
            typeof m.keyframe !== "boolean"))
      )
        throw Error("Invalid segment announcement.");
      pending = {
        kind: m.type,
        epoch: m.epoch,
        sequence: segment ? (m.sequence as number) : 0,
        keyframe: segment ? (m.keyframe as boolean) : true,
        data: new Uint8Array(m.bytes),
        received: 0,
      };
    } else if (m.type === "end")
      end(
        liveEnding(typeof m.reason === "string" ? m.reason : "capture_ended"),
      );
    else if (m.type === "error")
      end(
        liveEnding(
          typeof m.code === "string" ? m.code : "capture_failed",
          typeof m.message === "string" ? m.message : undefined,
        ),
      );
    else throw Error("Unexpected stream message.");
  }

  void (async () => {
    let generation: string;
    try {
      ({ generation } = await api(
        `machines/${machineId}/live-views`,
        { id, ttlSeconds: VIEW_TTL_SECONDS },
        (value) => receipt(value, id, machineId),
      ));
    } catch (error) {
      // Nothing was attached. A reply that never arrived may still have created the view, so that
      // one is closed by its identifier; a definite refusal created nothing.
      const ending = refusal(error);
      end(ending, ending.reason === "unavailable");
      return;
    }
    if (done) return;
    const url = new URL(`/api/v1/${path}/${generation}`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = socketFactory
      ? socketFactory(url.href)
      : new WebSocket(url.href, [PROTOCOL]);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (socket!.protocol !== PROTOCOL)
        end(
          liveEnding("protocol", "The stream used an unexpected protocol."),
          true,
        );
    };
    socket.onerror = () => {};
    socket.onclose = () => void closed();
    socket.onmessage = (event: MessageEvent) => {
      try {
        message(event);
      } catch (error) {
        // The view may still be alive on the controller; leave it explicitly.
        end(liveEnding("protocol", errorMessage(error)), true);
      }
    };
  })();

  return {
    setWatched(value) {
      const resumed = value && !watched;
      watched = value;
      // Coming back on screen renews at once: the lifetime may be nearly spent.
      if (resumed) renew();
    },
    close(keepalive = false) {
      if (done) return;
      done = true;
      leave(true, keepalive);
    },
  };
}
