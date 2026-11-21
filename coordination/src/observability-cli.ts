import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { CliError, credential, metadata, option, origin, positional, privateInput, record, uuid } from "./account-cli.ts";
import type { CliArguments, RequestClient } from "./account-cli.ts";
import { FINDING_CODES } from "./control/diagnosis.ts";
import type { Diagnosis, Finding, Severity } from "./control/diagnosis.ts";
import type { ServerSentEvent } from "./sse.ts";
import { usageCsv } from "./usage.ts";
import type { UsageReport, UsageRow } from "./usage.ts";

/** `canaveral events`, `usage`, `alerts` and `doctor`.
 * All four read controller state; only `alerts add|remove|test` mutate, each under a caller-held UUID.
 * `doctor` issues GET requests only. Webhook URLs and signing secrets are read from private files and
 * are never printed or passed as arguments.
 */
export interface ObservabilityIO {
  stdout(text: string): void; stderr(text: string): void;
  client(url: string, token: string, allowHttp: boolean): RequestClient;
  signal?: AbortSignal;
  /** Connection probe for `doctor`; replaceable in portable tests. */
  probe?: (url: string, allowHttp: boolean) => Promise<Probe>;
  /** Pauses of `events --follow` before it follows again; portable tests shorten them. */
  followTiming?: { reconnectMs?: number; retryMs?: number };
}
export interface Probe { reachable: boolean; code?: string; tls?: { protocol: string; expiresAt: string } }
/** A follower needs the transport itself; the JSON request client alone cannot hold a stream open. */
export interface StreamingClient extends RequestClient { stream(path: string, signal: AbortSignal): Promise<AsyncIterable<ServerSentEvent>> }

/** Pause before following again after an ordinary stream end, and after a failed attempt; retries allowed in a row. */
const FOLLOW_RECONNECT_MS = 100, FOLLOW_RETRY_MS = 2000, FOLLOW_RETRIES = 5;
/** Requests one `events` listing may make to fill its page from a filtered read. */
const LIST_REQUESTS = 50;
function list(args: CliArguments, name: string): string[] {
  const value = args.options[name];
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}
function whole(args: CliArguments, name: string, maximum: number): string {
  const text = option(args, name);
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(text) || Number(text) > maximum) throw new CliError(`Invalid --${name}.`);
  return text;
}
function instant(text: string, name: string): string {
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(text) || !Number.isFinite(Date.parse(text))) throw new CliError(`--${name} must be a UTC RFC3339 time such as 2026-11-21T08:00:00Z.`);
  return text;
}

function eventLine(event: Record<string, unknown>, text: boolean): string {
  if (!text) return JSON.stringify(event) + "\n";
  const about = [["application", event.applicationId], ["lease", event.leaseId], ["request", event.requestId], ["host", event.hostId], ["machine", event.machineId]]
    .filter(([, value]) => typeof value === "string").map(([name, value]) => `${name as string}=${value as string}`).join(" ");
  const data = Object.entries(record(event.data ?? {})).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ");
  return `${String(event.sequence).padStart(8)} ${String(event.at)} ${String(event.kind)}${about ? " " + about : ""}${data ? " " + data : ""}\n`;
}
async function events(args: CliArguments, io: ObservabilityIO): Promise<number> {
  const own = args.options.own === true, query = new URLSearchParams(), text = args.options.text === true, follow = args.options.follow === true;
  if (args.options.after !== undefined && args.options.tail !== undefined) throw new CliError("Use either --after or --tail.");
  if (follow && (args.options.tail !== undefined || args.options.limit !== undefined || args.options.since !== undefined)) throw new CliError("--follow takes --after, --kind and subject filters only.");
  if (args.options.after !== undefined) query.set("after", whole(args, "after", Number.MAX_SAFE_INTEGER));
  if (args.options.tail !== undefined) query.set("tail", whole(args, "tail", 500));
  if (args.options.limit !== undefined) query.set("limit", whole(args, "limit", 500));
  if (args.options.since !== undefined) query.set("since", instant(option(args, "since"), "since"));
  for (const kind of list(args, "kind")) {
    if (!/^[a-z]+\.(?:[a-z_]+|\*)$/.test(kind)) throw new CliError("--kind takes an event kind or a family such as lease.*.");
    query.append("kind", kind);
  }
  for (const key of ["application", "lease", "request", "host", "machine"]) if (args.options[key] !== undefined) {
    if (own && (key === "application" || key === "host" || key === "machine")) throw new CliError(`--${key} is an administrator filter; it cannot be combined with --own.`);
    query.set(key, uuid(option(args, key)));
  }
  const client = io.client(args.url, await credential(args), args.allowHttp), base = own ? "/v1/events" : "/v1/admin/events";
  if (!follow) {
    // A filtered read examines a bounded stretch of the log per request and may return a short page with
    // more to read. Keep reading until the requested number of events is printed or the log is exhausted.
    const wanted = args.options.limit === undefined ? 100 : Number(query.get("limit")), paged = args.options.tail === undefined;
    let printed = 0, page: Record<string, unknown> = {}, truncated = false;
    for (let request = 0; request < LIST_REQUESTS; request++) {
      if (paged) query.set("limit", String(wanted - printed));
      page = await client.request("GET", base + (query.size ? "?" + query.toString() : ""));
      const events = Array.isArray(page.events) ? page.events : [];
      for (const event of events) io.stdout(eventLine(metadata(event), text));
      printed += events.length; truncated ||= page.truncated === true;
      if (!paged || page.more !== true || printed >= wanted || typeof page.cursor !== "number") break;
      query.set("after", String(page.cursor));
    }
    io.stderr(`cursor=${String(page.cursor)}${page.more === true ? " more=true" : ""}${truncated ? " truncated=true (retention removed events after the supplied cursor)" : ""}\n`);
    return 0;
  }
  if (typeof (client as Partial<StreamingClient>).stream !== "function") throw new CliError("This client cannot follow an event stream.", 503);
  const controller = new AbortController(), stop = () => controller.abort();
  if (io.signal) { if (io.signal.aborted) stop(); else io.signal.addEventListener("abort", stop, { once: true }); }
  else { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  // The resume position is whatever the controller last reported: an event's sequence, or the cursor in
  // an `open`, `cursor` or `end` message. Without one yet, a new stream starts at the head again; it is
  // never restarted from zero, which would print retained history as if it were live.
  let cursor: string | undefined = query.get("after") ?? undefined, failures = 0;
  const position = (data: Record<string, unknown>): void => { if (typeof data.cursor === "number" && Number.isSafeInteger(data.cursor) && data.cursor >= 0) cursor = String(data.cursor); };
  const pause = (ms: number) => new Promise<void>(done => { const timer = setTimeout(done, ms); controller.signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true }); });
  try {
    while (!controller.signal.aborted) {
      const target = new URLSearchParams(query);
      if (cursor !== undefined) target.set("after", cursor);
      // A stream that stops without an `end` message was cut off.
      let ended = "connection_lost";
      try {
        const stream = await (client as StreamingClient).stream(base + "/stream" + (target.size ? "?" + target.toString() : ""), controller.signal);
        for await (const message of stream) {
          // Any message shows that the stream was established; only consecutive failures to get one count.
          failures = 0;
          if (message.event === "open" || message.event === "cursor") { position(record(JSON.parse(message.data) as unknown)); continue; }
          if (message.event === "end") { const data = record(JSON.parse(message.data) as unknown); position(data); ended = typeof data.code === "string" ? data.code : "ended"; break; }
          if (message.event === "truncated") { io.stderr("truncated=true (retention removed events after the supplied cursor)\n"); continue; }
          if (message.event !== undefined) continue;
          const event = record(JSON.parse(message.data) as unknown);
          io.stdout(eventLine(metadata(event), text)); cursor = String(event.sequence);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        // A definite refusal is final; a dropped connection is resumed from the last position reported.
        if (error instanceof CliError && error.status >= 400 && error.status < 500) throw error;
      }
      if (controller.signal.aborted) break;
      // The controller ends every stream at its lifetime and when it closes. That is how a long follow
      // normally continues, not a failure, so it reconnects at once and without a limit.
      if (ended === "stream_lifetime") { await pause(io.followTiming?.reconnectMs ?? FOLLOW_RECONNECT_MS); continue; }
      // A closing or unavailable controller, or a lost connection, is retried a few times.
      if (!["controller_closing", "connection_lost", "unavailable"].includes(ended)) { io.stderr(`stream ended: ${ended.replace(/[^a-z0-9_]/g, "").slice(0, 64)}\n`); return 1; }
      if (++failures > FOLLOW_RETRIES) throw new CliError(`The event stream could not be resumed.${cursor === undefined ? "" : " Continue with --after " + cursor + "."}`, 503);
      await pause(io.followTiming?.retryMs ?? FOLLOW_RETRY_MS);
    }
  } finally {
    if (io.signal) io.signal.removeEventListener("abort", stop); else { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  }
  if (cursor !== undefined) io.stderr(`cursor=${cursor}\n`);
  return 0;
}

function seconds(value: unknown): string { return typeof value === "number" ? value >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(1))) : "-"; }
function usageText(report: UsageReport): string {
  const header = [report.groupBy, "requests", "admitted", "cancelled", "expired", "rejected", "waiting", "wait p50", "wait p95", "leases", "failed", "active", "blocked", "ready p50", "hold p50", "hold p95", "device-s"];
  const row = (r: UsageRow) => [r.label ? `${r.label} (${r.key})` : r.key, r.requests?.submitted ?? "-", r.requests?.admitted ?? "-", r.requests?.cancelled ?? "-", r.requests?.expired ?? "-",
    r.requests?.rejected ?? "-", r.requests?.waiting ?? "-", seconds(r.requests?.waitSeconds.p50), seconds(r.requests?.waitSeconds.p95), r.leases.admitted, r.leases.failed, r.leases.active,
    r.leases.cleanupBlocked, seconds(r.leases.timeToReadySeconds.p50), seconds(r.leases.holdSeconds.p50), seconds(r.leases.holdSeconds.p95), seconds(r.leases.deviceSeconds)].map(String);
  const rows = [header, ...report.rows.map(row), row(report.totals)], widths = header.map((_, column) => Math.max(...rows.map(cells => cells[column]!.length)));
  return `Usage ${report.from} to ${report.to} by ${report.groupBy}\n` + rows.map(cells => cells.map((cell, column) => column ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n") +
    `\nRequest records are not pruned. Lease figures come from the usage ledger, kept ${Math.round(report.retention.leaseLedgerSeconds / 86400)} days after a lease ends` +
    `${report.retention.leaseLedgerStartedAt ? ` and started ${report.retention.leaseLedgerStartedAt}` : ""}.\n`;
}
async function usage(args: CliArguments, io: ObservabilityIO): Promise<number> {
  const own = args.options.own === true, query = new URLSearchParams(), format = option(args, "format", "text");
  if (!["text", "json", "csv"].includes(format)) throw new CliError("--format must be text, json or csv.");
  if (args.options.last !== undefined) {
    if (args.options.from !== undefined || args.options.to !== undefined) throw new CliError("Use --last or --from/--to.");
    const match = /^([1-9][0-9]{0,3})([hd])$/.exec(option(args, "last"));
    if (!match) throw new CliError("--last takes hours or days, such as 24h or 7d.");
    const to = Date.now(); query.set("to", new Date(to).toISOString()); query.set("from", new Date(to - Number(match[1]) * (match[2] === "h" ? 3600_000 : 86400_000)).toISOString());
  }
  for (const key of ["from", "to"]) if (args.options[key] !== undefined) query.set(key, instant(option(args, key), key));
  if (args.options["group-by"] !== undefined) {
    const group = option(args, "group-by");
    if (!(own ? ["application", "template", "platform"] : ["application", "template", "platform", "host"]).includes(group)) throw new CliError("--group-by must be application, template, platform or (administrators only) host.");
    query.set("groupBy", group);
  }
  if (args.options.application !== undefined) {
    if (own) throw new CliError("--application is an administrator filter; it cannot be combined with --own.");
    query.set("application", uuid(option(args, "application")));
  }
  const client = io.client(args.url, await credential(args), args.allowHttp);
  const report = await client.request("GET", (own ? "/v1/usage" : "/v1/admin/usage") + (query.size ? "?" + query.toString() : "")) as unknown as UsageReport;
  if (!Array.isArray(report.rows) || !report.totals || !report.retention) throw new CliError("Unexpected controller response. Inspect state before retrying.", 502);
  io.stdout(format === "json" ? JSON.stringify(report, null, 2) + "\n" : format === "csv" ? usageCsv(report) : usageText(report));
  return 0;
}

async function alerts(args: CliArguments, io: ObservabilityIO): Promise<number> {
  const client = io.client(args.url, await credential(args), args.allowHttp);
  let result: Record<string, unknown>;
  if (args.action === "list") result = await client.request("GET", "/v1/admin/alerts/destinations");
  else if (args.action === "deliveries") {
    const query = new URLSearchParams();
    if (args.options.destination !== undefined) query.set("destination", uuid(option(args, "destination")));
    if (args.options.state !== undefined) query.set("state", option(args, "state"));
    result = await client.request("GET", "/v1/admin/alerts/deliveries" + (query.size ? "?" + query.toString() : ""));
  } else if (args.action === "add") {
    const type = option(args, "type");
    if (type !== "slack" && type !== "webhook") throw new CliError("--type must be slack or webhook.");
    if ((type === "webhook") !== (args.options["secret-file"] !== undefined)) throw new CliError(type === "webhook" ? "A webhook destination requires --secret-file." : "A Slack destination takes no --secret-file.");
    const kinds = list(args, "kind");
    result = await client.request("POST", "/v1/admin/alerts/destinations", { id: uuid(option(args, "request-id")), name: option(args, "name"), type,
      url: await privateInput(option(args, "url-file"), true), ...(type === "webhook" ? { secret: await privateInput(option(args, "secret-file"), true) } : {}),
      ...(kinds.length ? { kinds } : {}) });
  } else if (args.action === "remove") result = await client.request("POST", `/v1/admin/alerts/destinations/${uuid(positional(args))}/remove`, {});
  else {
    const id = args.options["request-id"] === undefined ? randomUUID() : uuid(option(args, "request-id"));
    result = await client.request("POST", `/v1/admin/alerts/destinations/${uuid(positional(args))}/test`, { id });
    io.stdout(JSON.stringify(metadata(result), null, 2) + "\n");
    return record(result.delivery).state === "delivered" ? 0 : 1;
  }
  io.stdout(JSON.stringify(metadata(result), null, 2) + "\n");
  return 0;
}

const TLS_REFUSALS = /^(CERT_|ERR_TLS_CERT|ERR_SSL|UNABLE_TO_(GET|VERIFY)|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_TLS)/;
/** One unauthenticated GET /healthz with the default trust store. It sends no credential. */
export function probeController(url: string, allowHttp: boolean): Promise<Probe> {
  const target = new URL(origin(url, allowHttp) + "/healthz");
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: Probe) => { if (!settled) { settled = true; clearTimeout(timer); request.destroy(); resolve(result); } };
    const request = (target.protocol === "https:" ? https : http).request(target, { method: "GET", agent: false, headers: { Accept: "application/json", Connection: "close" },
      ...(target.protocol === "https:" ? { minVersion: "TLSv1.2" as const, rejectUnauthorized: true } : {}) });
    const timer = setTimeout(() => finish({ reachable: false, code: "timeout" }), 10_000);
    request.on("error", (error: NodeJS.ErrnoException) => finish({ reachable: false, code: TLS_REFUSALS.test(error.code ?? "") ? "tls" : "connection" }));
    request.on("response", response => {
      response.resume();
      const socket = response.socket as Partial<TLSSocket>, certificate = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate() : undefined;
      finish({ reachable: response.statusCode === 200, ...(response.statusCode === 200 ? {} : { code: "status" }),
        ...(certificate?.valid_to ? { tls: { protocol: socket.getProtocol?.() ?? "TLS", expiresAt: new Date(certificate.valid_to).toISOString() } } : {}) });
    });
    request.end();
  });
}
const finding = (code: string, severity: Severity, id: string, summary: string, nextStep: string): Finding => ({ code, severity, subject: { type: "controller", id }, summary, nextStep });
/** Read-only: one unauthenticated probe, then GET requests under the supplied credential. Exit status 1 when anything is found. */
async function doctor(args: CliArguments, io: ObservabilityIO): Promise<number> {
  const findings: Finding[] = [], checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  let controller: string;
  try { controller = origin(args.url, args.allowHttp); }
  catch { controller = args.url.replace(/[^\x21-\x7e]/g, "").slice(0, 200);
    findings.push(finding("controller_plain_http", "error", controller, "The controller origin is not HTTPS and plain HTTP was not allowed.", "Use the controller's HTTPS origin with --url, or --allow-http only on a trusted private network.")); }
  let diagnosis: Diagnosis | undefined;
  if (!findings.length) {
    const url = new URL(controller);
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) findings.push(finding("controller_plain_http", "warning", controller,
      "Credentials travel to this controller without TLS.", "Configure tls in the controller configuration, or place it behind a TLS terminator, and use its HTTPS origin."));
    const probe = await (io.probe ?? probeController)(controller, args.allowHttp);
    checks.push({ check: "controller", ok: probe.reachable, detail: probe.reachable ? probe.tls ? `reachable over ${probe.tls.protocol}; certificate valid until ${probe.tls.expiresAt}` : "reachable over plain HTTP" : "no answer" });
    if (!probe.reachable && probe.code === "tls") findings.push(finding("controller_tls_untrusted", "error", controller, "The controller certificate was not accepted by the default trust store.",
      "Renew or reissue the certificate for this name, or correct the origin. Clients must never skip verification."));
    else if (!probe.reachable) findings.push(finding("controller_unreachable", "error", controller, "The controller did not answer GET /healthz.",
      "Check that the controller service is running and that this origin and port route to it."));
    if (probe.reachable && probe.tls && Date.parse(probe.tls.expiresAt) - Date.now() < 14 * 86400_000) findings.push(finding("controller_tls_expiring", "warning", controller,
      `The controller certificate expires at ${probe.tls.expiresAt}.`, "Renew the certificate; the controller reloads its TLS files without a restart."));
    if (probe.reachable) {
      if (!args.tokenFile) findings.push(finding("credential_missing", "error", controller, "No credential file was supplied, so controller state was not examined.",
        "Pass --token-file with an operator credential, an administrator session or an administrator-scoped token."));
      else {
        try {
          diagnosis = await io.client(args.url, await credential(args), args.allowHttp).request("GET", "/v1/admin/diagnosis") as unknown as Diagnosis;
          if (!Array.isArray(diagnosis.findings)) throw new CliError("Unexpected controller response.", 502);
          checks.push({ check: "credential", ok: true, detail: "accepted with administrator authority" });
        } catch (error) {
          const status = error instanceof CliError ? error.status : 0; diagnosis = undefined;
          checks.push({ check: "credential", ok: false, detail: status ? `HTTP ${status}` : "not confirmed" });
          findings.push(status === 401 ? finding("credential_rejected", "error", controller, "The controller rejected this credential.", "Sign in again or supply a current credential file; a revoked or expired credential cannot be renewed.")
            : status === 403 ? finding("credential_not_administrator", "error", controller, "This credential lacks administrator authority, so controller state was not examined.", "Use an operator credential, an administrator session or a token with the admin scope.")
              : finding("diagnosis_unavailable", "error", controller, "The controller did not return a diagnosis.", "Check that the controller runs a version with /v1/admin/diagnosis and that its storage is available."));
        }
      }
    }
  }
  // Every finding counts, including one whose code this version does not know: a newer controller may
  // report something this command has no description for, and that must never read as a clean result.
  const all = [...findings, ...(diagnosis?.findings ?? []).filter(item => item !== null && typeof item === "object").map(item => ({
    ...item, code: typeof item.code === "string" ? item.code.replace(/[^a-z0-9_]/g, "").slice(0, 64) || "unknown_finding" : "unknown_finding",
    severity: ["error", "warning", "notice"].includes(item.severity) ? item.severity : "warning" as Severity,
    summary: typeof item.summary === "string" ? item.summary : "The controller reported a finding this version cannot describe.",
    nextStep: typeof item.nextStep === "string" ? item.nextStep : "Upgrade this command, or read the finding with --json.",
  }))];
  if (args.options.json === true) io.stdout(JSON.stringify({ controller, ok: all.length === 0, checks, findings: all, ...(diagnosis ? { checked: diagnosis.checked, omitted: diagnosis.omitted, generatedAt: diagnosis.generatedAt } : {}) }, null, 2) + "\n");
  else {
    io.stdout(`Canaveral doctor: ${controller}\n`);
    for (const check of checks) io.stdout(`${check.ok ? "ok  " : "FAIL"} ${check.check}: ${check.detail}\n`);
    if (diagnosis) io.stdout(`examined ${diagnosis.checked.hosts} hosts, ${diagnosis.checked.activeLeases} active leases, ${diagnosis.checked.waitingRequests} waiting requests, ${diagnosis.checked.updateJobs} update jobs, ${diagnosis.checked.alertDestinations} alert destinations\n`);
    io.stdout(all.length ? `${all.length} finding${all.length === 1 ? "" : "s"}${diagnosis?.omitted ? ` (${diagnosis.omitted} more omitted)` : ""}:\n` : "No findings.\n");
    for (const item of all) io.stdout(`[${item.severity}] ${item.code}${Object.hasOwn(FINDING_CODES, item.code) ? "" : " (not known to this version)"}: ${item.summary}\n    next: ${item.nextStep}\n`);
  }
  return all.length ? 1 : 0;
}

export const OBSERVABILITY_COMMANDS = ["events", "usage", "alerts", "doctor"];
export async function handleObservability(args: CliArguments, io: ObservabilityIO): Promise<number> {
  if (args.command === "events") return events(args, io);
  if (args.command === "usage") return usage(args, io);
  if (args.command === "alerts") return alerts(args, io);
  return doctor(args, io);
}
