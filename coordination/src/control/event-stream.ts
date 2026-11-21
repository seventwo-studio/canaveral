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
 * revoked credential ends it at the next round. Each event is one unnamed SSE message whose `id` is
 * its sequence, so `Last-Event-ID` (or `after`) resumes without loss or repetition while the cursor is
 * still retained. Without a cursor the stream starts after the newest matching event.
 *
 * Idle streams cost one read-only sequence probe per second for all followers together; the list
 * route runs only when the sequence moved or the periodic authorization recheck is due. Streams are
 * bounded in number, buffered bytes and lifetime, and never use a request slot or a transaction.
 * Browser origins are refused like every controller route; a dashboard relays through its gateway.
 */
const MAX_STREAMS = 32, POLL_MS = 1000, KEEPALIVE_MS = 10_000, RECHECK_MS = 15_000, LIFETIME_MS = 3_600_000, MAX_BUFFERED = 1_048_576, PAGE = 500;
const ADMIN_FILTERS = ["after", "kind", "application", "lease", "request", "host", "machine"], APPLICATION_FILTERS = ["after", "kind", "lease", "request"];
interface Stream {
  response: ServerResponse; listPath: string; filters: URLSearchParams; token: string; cursor: number;
  opened: number; lastWrite: number; lastPoll: number; seenLatest: number; polling: boolean; ended: boolean;
}

export function createEventStream(control: StreamRequester, clock: () => number = () => Date.now()) {
  const streams = new Set<Stream>();
  let timer: NodeJS.Timeout | undefined, ticking = false;

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
  function emit(stream: Stream, page: EventPage): void {
    for (const event of page.events) write(stream, `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    stream.cursor = page.cursor;
  }
  function finish(stream: Stream, reason?: string): void {
    if (stream.ended) return;
    if (reason && !stream.response.destroyed) stream.response.write(`event: end\ndata: ${JSON.stringify({ code: reason, cursor: stream.cursor })}\n\n`);
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
      // The follower's authority or the controller ended; the client decides whether to reconnect.
      finish(stream, error instanceof ServiceError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "unavailable");
    } finally { stream.polling = false; }
  }
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      let latest: number;
      // A requester without the probe answers something else; every round then reads the list route.
      try { const value = await control.request({ type: "events.latest" }); latest = typeof value === "number" ? value : Number.NaN; }
      catch { for (const stream of [...streams]) finish(stream, "unavailable"); return; }
      const now = clock();
      // One follower at a time: streams together never hold more than one of the worker's request slots.
      for (const stream of [...streams]) {
        if (now - stream.opened >= LIFETIME_MS) { finish(stream, "stream_lifetime"); continue; }
        if (latest !== stream.seenLatest || now - stream.lastPoll >= RECHECK_MS) await poll(stream, latest);
        if (!stream.ended && clock() - stream.lastWrite >= KEEPALIVE_MS) write(stream, ": keep-alive\n\n");
      }
    } finally { ticking = false; }
  }

  return {
    get size() { return streams.size; },
    async handle(request: IncomingMessage, response: ServerResponse, target: { path: string; query: URLSearchParams; token: string }): Promise<void> {
      if (request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
          request.headers.upgrade !== undefined || request.headers.expect !== undefined || request.headers.trailer !== undefined) throw new ServiceError("Invalid request framing.", 400);
      const admin = target.path === "/v1/admin/events/stream";
      if (!admin && target.path !== "/v1/events/stream") throw new ServiceError("Unknown endpoint.", 404);
      for (const key of target.query.keys()) if (!(admin ? ADMIN_FILTERS : APPLICATION_FILTERS).includes(key)) throw new ServiceError("Unsupported event stream parameter.", 400);
      if (streams.size >= MAX_STREAMS) throw new ServiceError("Event stream limit reached.", 429, { code: "event_stream_limit", retryable: true });
      const resume = target.query.get("after") ?? (typeof request.headers["last-event-id"] === "string" && request.headers["last-event-id"] !== "" ? request.headers["last-event-id"] : undefined);
      if (target.query.getAll("after").length > 1 || (resume !== undefined && (!/^(?:0|[1-9][0-9]{0,15})$/.test(resume) || Number(resume) > Number.MAX_SAFE_INTEGER))) throw new ServiceError("Invalid event cursor.", 400);
      const filters = new URLSearchParams([...target.query].filter(([key]) => key !== "after"));
      const source = { listPath: admin ? "/v1/admin/events" : "/v1/events", filters, token: target.token };
      // Authenticate and validate the filters through the list route before any stream header is written.
      const first = await list(source, resume === undefined ? { tail: 1 } : { after: Number(resume) });
      if (response.destroyed) return;
      if (streams.size >= MAX_STREAMS) throw new ServiceError("Event stream limit reached.", 429, { code: "event_stream_limit", retryable: true });
      const now = clock();
      const stream: Stream = { response, ...source, cursor: first.cursor, opened: now, lastWrite: now, lastPoll: now, seenLatest: -1, polling: false, ended: false };
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no", Connection: "close" });
      streams.add(stream);
      response.once("close", () => finish(stream));
      write(stream, `retry: 2000\n: canaveral events after ${resume === undefined ? first.cursor : resume}\n\n`);
      if (resume !== undefined) {
        if (first.truncated) write(stream, `event: truncated\ndata: ${JSON.stringify({ after: Number(resume) })}\n\n`);
        emit(stream, first);
      }
      if (!timer) { timer = setInterval(() => { void tick(); }, POLL_MS); timer.unref(); }
      // More than one page was already waiting: catch up now instead of at the next round.
      if (resume !== undefined && first.more) void poll(stream, -1);
    },
    close(): void { for (const stream of [...streams]) finish(stream); },
  };
}
