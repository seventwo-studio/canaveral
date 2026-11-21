import type { TestContext } from "node:test";
import type { SendResult } from "../../src/alerts.ts";
import type { ControlRequest, ControlResponse, Principal } from "../../src/control/contracts.ts";
import { Observability } from "../../src/control/observability.ts";
import type { EventView } from "../../src/events.ts";
import type { ObservabilitySettings } from "../../src/observability.ts";
import { leaseFixture } from "./leases-fixture.test.ts";

export interface SentAlert { url: string; headers: Record<string, string>; body: Buffer }
/** The disposable lease fixture with event capture, the usage ledger and a recording alert sender on its injected clock. */
export function observabilityFixture(t: TestContext, settings: Partial<ObservabilitySettings> = {}, system = "linux", mode = "headless") {
  const f = leaseFixture(t, system, mode);
  const sent: SentAlert[] = [];
  let reply: (alert: SentAlert) => SendResult | Promise<SendResult> = () => ({ ok: true, status: 204, outcome: "delivered" });
  const observability = new Observability(f.store, { ...f.options, observability: settings }, f.apps, async (url, headers, body) => {
    const alert = { url, headers, body }; sent.push(alert); return reply(alert);
  });
  const captured = observability.installCapture();
  const operator: Principal = { kind: "operator", user: null, scopes: ["admin"] };
  const call = async (method: string, target: string, body: Record<string, unknown> = {}, token = f.options.adminToken, principal: Principal | undefined = operator): Promise<ControlResponse> => {
    const url = new URL(target, "http://fixture.invalid");
    const req: ControlRequest = { method, path: url.pathname, parts: url.pathname.split("/").filter(Boolean), query: url.searchParams, body, token,
      principal() { if (!principal || token !== f.options.adminToken) throw Object.assign(new Error("rejected"), { status: 401 }); return principal; } };
    const result = await observability.handle(req);
    if (!result) throw new Error("observability route was not owned: " + target);
    return result;
  };
  const admin = async (target: string) => (await call("GET", target)).body as any;
  const events = async (query = "") => (await admin("/v1/admin/events?limit=500" + (query ? "&" + query : ""))).events as EventView[];
  const own = async (credential: string, query = "") => ((await call("GET", "/v1/events?limit=500" + (query ? "&" + query : ""), {}, credential, undefined)).body as any).events as EventView[];
  return { ...f, observability, captured, sent, call, admin, events, own, respond(next: typeof reply) { reply = next; } };
}
