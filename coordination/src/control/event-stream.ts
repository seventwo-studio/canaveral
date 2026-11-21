import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceError } from "../errors.ts";
import type { EventPage } from "../events.ts";
import type { HttpCommand } from "./client.ts";
import type { ControlResponse } from "./contracts.ts";

/** The worker boundary a stream needs: the list route, and the newest sequence read without the write lock. */
export interface StreamRequester { request(command: HttpCommand | { type: "events.latest" }): Promise<unknown> }

/** Live follow over server-sent events, served on the listener thread.
 *
 * A stream is a cursor over the same list route a client could poll, read with the follower's own
 * credential on every round. It therefore has exactly that route's authorization and scoping, and a
 * revoked credential ends it at the next round.
 *
 * Messages. Each event is one unnamed message whose `id` is its sequence. `open` is always first and
 * `cursor` is sent whenever the stream has been silent for the keep-alive interval; both carry the
 * position the stream has read up to as their `id` and as `{cursor}`. `truncated` reports that retention
 * removed history after the resume cursor. `end` carries `{code, cursor}` when the controller closes
 * the stream. Because every message that moves the position has an `id`, a client that reconnects
 * with its last id (`Last-Event-ID`, which wins over a stale `after` in the URL) resumes without loss
 * or repetition while that position is still retained, also after a quiet stream.
 *
 * Bounds. Streams are limited in total, per credential and for applications together, so one
 * credential cannot take every slot and administrators keep some. Authenticating a new stream is
 * limited separately, so unauthenticated requests cannot occupy the worker's request slots. Open
 * streams together use one worker slot at a time, and never a transaction. A stream is also bounded
 * in buffered bytes and lifetime. A busy worker changes nothing: the round is skipped.
 * Browser origins are refused like every controller route; a dashboard relays through its gateway.
 */
export const STREAM_LIMITS = { total: 32, perCredential: 4, applications: 24, admissions: 4 };
const KEEPALIVE_MS = 10_000, POLL_MS = 1000, RECHECK_MS = 15_000, LIFETIME_MS = 3_600_000, MAX_BUFFERED = 1_048_576, PAGE = 500;
const ADMIN_FILTERS = ["after", "kind", "application", "lease", "request", "host", "machine"], APPLICATION_FILTERS = ["after", "kind", "lease", "request"];
const CURSOR = /^(?:0|[1-9][0-9]{0,15})$/;
interface Stream {
  response: ServerResponse; admin: boolean; listPath: string; filters: URLSearchParams; token: string; cursor: number;
  opened: number; lastWrite: number; lastPoll: number; seenLatest: number; polling: boolean; ended: boolean;
}
export interface StreamTiming { clock?: () => number; pollMs?: number; keepaliveMs?: number; recheckMs?: number; lifetimeMs?: number }

export function createEventStream(control: StreamRequester, timing: StreamTiming = {}) {
  const clock = timing.clock ?? (() => Date.now()), pollMs = timing.pollMs ?? POLL_MS, keepaliveMs = timing.keepaliveMs ?? KEEPALIVE_MS;
  const recheckMs = timing.recheckMs ?? RECHECK_MS, lifetimeMs = timing.lifetimeMs ?? LIFETIME_MS;
  const streams = new Set<Stream>();
  let timer: NodeJS.Timeout | undefined, ticking = false, admitting = 0, closed = false;

  async function list(stream: Pick<Stream, "listPath" | "filters" | "token">, cursor: { after: number } | { tail: number }): Promise<EventPage> {
    const query = new URLSearchParams(stream.filters);
    if ("after" in cursor) { query.set("after", String(cursor.after)); query.set("limit", String(PAGE)); } else query.set("tail", String(cursor.tail));
    const reply = await control.request({ type: "http", method: "GET", path: stream.listPath, query: query.toString(), token: stream.token, body: {} }) as ControlResponse | undefined;
    if (!reply) throw new ServiceError("Unknown endpoint.", 404);
    return reply.body as EventPage;
  }
  function write(stream: Stream, text: string): void {
    if (stream.ended || stream.response.destroyed) return;
    stream.response.write(text);
    stream.lastWrite = clock();
    // A reader that stopped consuming is dropped; it resumes from its last id.
    if (stream.response.writableLength > MAX_BUFFERED) finish(stream);
  }
  /** A named message that also moves the client's resume position to where the stream has read. */
  const position = (stream: Stream, name: string, data: Record<string, unknown> = {}): string => `id: ${stream.cursor}\nevent: ${name}\ndata: ${JSON.stringify({ ...data, cursor: stream.cursor })}\n\n`;
  function emit(stream: Stream, page: EventPage): void {
    for (const event of page.events) write(stream, `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    stream.cursor = page.cursor;
  }
  function finish(stream: Stream, code?: string): void {
    if (stream.ended) return;
    if (code && !stream.response.destroyed) stream.response.write(position(stream, "end", { code }));
    stream.ended = true;
    streams.delete(stream);
    if (!stream.response.destroyed) stream.response.end();
    if (!streams.size && timer) { clearInterval(timer); timer = undefined; }
  }
  async function poll(stream: Stream, latest: number): Promise<void> {
    if (stream.polling || stream.ended) return;
    stream.polling = true;
    try {
      for (let round = 0; round < 20 && !stream.ended; round++) {
        const page = await list(stream, { after: stream.cursor });
        emit(stream, page);
        if (!page.more) break;
      }
      stream.seenLatest = latest; stream.lastPoll = clock();
    } catch (error) {
      // A momentarily busy worker is not the follower's fault: keep the stream and read again next round.
      if (error instanceof ServiceError && error.status === 429) return;
      // The follower's authority ended (the refusal's own code), or the controller could not answer
      // (`unavailable`, whatever went wrong inside). The client decides whether to reconnect.
      finish(stream, error instanceof ServiceError && error.status < 500 && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "unavailable");
    } finally { stream.polling = false; }
  }
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      let latest = Number.NaN, busy = false;
      // A requester without the probe answers something else; every round then reads the list route.
      try { const value = await control.request({ type: "events.latest" }); if (typeof value === "number") latest = value; }
      catch (error) {
        // A busy worker refused the probe: read nothing this round. Any other failure is left to each
        // follower's own read of the list route, which ends that stream with the code it gets.
        busy = error instanceof ServiceError && error.status === 429;
      }
      const now = clock();
      // One follower at a time: streams together never hold more than one of the worker's request slots.
      for (const stream of [...streams]) {
        if (now - stream.opened >= lifetimeMs) { finish(stream, "stream_lifetime"); continue; }
        if (!busy && (latest !== stream.seenLatest || now - stream.lastPoll >= recheckMs)) await poll(stream, latest);
        // The keep-alive also tells a quiet follower how far the stream has read.
        if (!stream.ended && clock() - stream.lastWrite >= keepaliveMs) write(stream, position(stream, "cursor"));
      }
    } finally { ticking = false; }
  }
  /** Refuses before any work when a bound is reached. The total keeps slots that applications cannot take. */
  function admit(admin: boolean, token: string): void {
    const limited = () => new ServiceError("Event stream limit reached.", 429, { code: "event_stream_limit", retryable: true });
    if (closed) throw new ServiceError("Controller is closing.", 503, { retryable: true });
    let own = 0, applications = 0;
    for (const stream of streams) { if (stream.token === token) own++; if (!stream.admin) applications++; }
    if (streams.size >= STREAM_LIMITS.total || own >= STREAM_LIMITS.perCredential || (!admin && applications >= STREAM_LIMITS.applications)) throw limited();
  }

  return {
    get size() { return streams.size; },
    async handle(request: IncomingMessage, response: ServerResponse, target: { path: string; query: URLSearchParams; token: string }): Promise<void> {
      if (request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
          request.headers.upgrade !== undefined || request.headers.expect !== undefined || request.headers.trailer !== undefined) throw new ServiceError("Invalid request framing.", 400);
      const admin = target.path === "/v1/admin/events/stream";
      if (!admin && target.path !== "/v1/events/stream") throw new ServiceError("Unknown endpoint.", 404);
      for (const key of target.query.keys()) if (!(admin ? ADMIN_FILTERS : APPLICATION_FILTERS).includes(key)) throw new ServiceError("Unsupported event stream parameter.", 400);
      // A standard SSE client reconnects to the same URL and sends the last id it saw. That id is newer
      // than any `after` still in the URL, so the header wins when both are present.
      const header = request.headers["last-event-id"], after = target.query.get("after") ?? undefined;
      const lastId = typeof header === "string" && header !== "" ? header : undefined;
      if (target.query.getAll("after").length > 1 || Array.isArray(header) || [after, lastId].some(value => value !== undefined && (!CURSOR.test(value) || Number(value) > Number.MAX_SAFE_INTEGER))) throw new ServiceError("Invalid event cursor.", 400);
      const resume = lastId ?? after;
      admit(admin, target.token);
      // Authentication is a worker request. Its own small bound keeps a burst of stream requests,
      // authenticated or not, from occupying the request slots that ordinary routes share.
      if (admitting >= STREAM_LIMITS.admissions) throw new ServiceError("Event stream limit reached.", 429, { code: "event_stream_limit", retryable: true });
      const filters = new URLSearchParams([...target.query].filter(([key]) => key !== "after"));
      const source = { listPath: admin ? "/v1/admin/events" : "/v1/events", filters, token: target.token };
      let first: EventPage;
      admitting++;
      // Authenticate and validate the filters through the list route before any stream header is written.
      try { first = await list(source, resume === undefined ? { tail: 1 } : { after: Number(resume) }); } finally { admitting--; }
      if (response.destroyed) return;
      admit(admin, target.token);
      const now = clock();
      const stream: Stream = { response, admin, ...source, cursor: resume === undefined ? first.cursor : Number(resume), opened: now, lastWrite: now, lastPoll: now, seenLatest: -1, polling: false, ended: false };
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no", Connection: "close" });
      streams.add(stream);
      response.once("close", () => finish(stream));
      write(stream, "retry: 2000\n" + position(stream, "open"));
      if (resume !== undefined) {
        if (first.truncated) write(stream, `event: truncated\ndata: ${JSON.stringify({ after: Number(resume) })}\n\n`);
        emit(stream, first);
      }
      if (!timer) { timer = setInterval(() => { void tick(); }, pollMs); timer.unref(); }
      // More than one page was already waiting: catch up now instead of at the next round.
      if (resume !== undefined && first.more) void poll(stream, -1);
    },
    /** Ends every stream with `controller_closing` and refuses new ones; the timer stops with the last stream. */
    close(): void { closed = true; for (const stream of [...streams]) finish(stream, "controller_closing"); },
  };
}
