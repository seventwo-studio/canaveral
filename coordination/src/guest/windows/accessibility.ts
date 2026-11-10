import { randomUUID } from "node:crypto";
import { Lane, ServiceError, allowed, equal, fields, integer, type Authority, type MaybePromise } from "./common.ts";
export interface UIADetails {
  role: string; name: string; identifier: string; states: Record<string, boolean>; actions: string[];
  bounds: { x: number; y: number; width: number; height: number } | null;
  properties: Record<string, unknown> & { runtimeId: number[] };
}
export interface UIANode extends UIADetails { id: string; parentId: string | null; depth: number; path: number[] }
export interface UIASnapshot { snapshotId: string; capturedAt: number; source: "windows-uia"; coordinateSpace: "screen-pixels"; nodes: UIANode[]; truncated: boolean; unavailableNodes: number; coverage: string }
export interface WindowsUIAAPI<H> {
  root(): MaybePromise<H | null>; firstChild(element: H): MaybePromise<H | null>; nextSibling(element: H): MaybePromise<H | null>;
  describe(element: H): MaybePromise<UIADetails>; same(a: H, b: H): MaybePromise<boolean>; invoke(element: H): MaybePromise<void>;
  clear?(): MaybePromise<void>;
}
function details(value: UIADetails): UIADetails {
  if (!value || !Array.isArray(value.properties?.runtimeId) || !integer(value.properties.runtimeId.length, 1, 64) || value.properties.runtimeId.some(n => !integer(n, -2147483648, 2147483647)) || !Array.isArray(value.actions) || value.actions.some(a => a !== "invoke") || [value.role, value.name, value.identifier].some(s => typeof s !== "string") || value.bounds && Object.values(value.bounds).some(n => typeof n !== "number" || !Number.isFinite(n)) || value.bounds && (value.bounds.width < 0 || value.bounds.height < 0)) throw new ServiceError("Malformed native UIA description.", 409);
  const result = structuredClone(value);
  if (result.states.password) { result.name = ""; result.actions = []; delete result.properties.value; result.properties.helpText = ""; }
  return result;
}
export class WindowsInspections<H> {
  readonly lane = new Lane(); private value?: UIASnapshot; private retained = new Map<string, H>(); private started = 0; private revoked = false;
  constructor(readonly api: WindowsUIAAPI<H>, readonly authorized: Authority, readonly clock = () => performance.now() / 1000, readonly actionAuthorized: Authority = authorized) {}
  authorize(): void { if (!allowed(this.authorized)) this.revoked = true; if (this.revoked) throw new ServiceError("Windows inspection authorization ended.", 410); }
  async inspect(): Promise<UIASnapshot> {
    return this.lane.run(async () => {
      this.authorize(); delete this.value; this.retained.clear(); await this.api.clear?.(); this.started = this.clock();
      const nodes: UIANode[] = [], seen = new Set<string>(); let bytes = 1024, truncated = false, unavailable = 0;
      const walk = async (element: H, path: number[], parent: string | null): Promise<boolean> => {
        this.authorize(); if (nodes.length >= 1500 || path.length > 25 || this.clock() >= this.started + 3) { truncated = true; return false; }
        try {
          const description = details(await this.api.describe(element)), runtime = description.properties.runtimeId.join(",");
          if (seen.has(runtime)) { truncated = true; unavailable++; return false; } seen.add(runtime);
          const node: UIANode = { id: `ax-${nodes.length + 1}`, parentId: parent, depth: path.length, path, ...description }, size = Buffer.byteLength(JSON.stringify(node)) + 2;
          if (bytes + size > 6 * 1048576) { truncated = true; return false; } bytes += size; nodes.push(node); this.retained.set(node.id, element);
          if (node.states.password) return true;
          let child = await this.api.firstChild(element), index = 0;
          while (child !== null) { if (!await walk(child, [...path, index++], node.id)) return false; if (this.clock() >= this.started + 3) { truncated = true; return false; } child = await this.api.nextSibling(child); }
          return true;
        } catch { truncated = true; unavailable++; return true; }
      };
      const root = await this.api.root(); if (root !== null) await walk(root, [], null);
      if (!nodes.length) throw new ServiceError("Windows native accessibility root is unavailable.", 503);
      this.authorize(); if (this.clock() >= this.started + 15) { this.retained.clear(); throw new ServiceError("Windows inspection expired before acknowledgement.", 409); }
      this.value = { snapshotId: randomUUID(), capturedAt: Date.now() / 1000, source: "windows-uia", coordinateSpace: "screen-pixels", nodes, truncated, unavailableNodes: unavailable, coverage: "Native UI Automation control view; protected content and descendants are omitted. Inaccessible controls may be absent." };
      return structuredClone(this.value);
    });
  }
  async invoke(request: unknown): Promise<{ status: "posted" }> {
    return this.lane.run(async () => {
      this.authorize(); const value = this.value, retained = this.retained; delete this.value; this.retained = new Map();
      const refuse = (): never => { throw new ServiceError("Windows target is stale or changed; inspect again.", 409, { code: "input_rejected", retryable: false }); };
      let target: H;
      try {
        const req = fields(request, ["snapshotId", "nodeId", "nativeAction"]);
        if (!value || req.snapshotId !== value.snapshotId || req.nativeAction !== "invoke" || typeof req.nodeId !== "string") return refuse();
        const byId = new Map(value.nodes.map(n => [n.id, n])), chain: UIANode[] = []; let id: string | null = req.nodeId;
        while (id && byId.has(id)) { const node: UIANode = byId.get(id)!; chain.unshift(node); id = node.parentId; }
        if (!chain.length || id !== null || chain.length > 26) return refuse();
        let current = await this.api.root();
        for (const [i, node] of chain.entries()) {
          this.authorize(); if (!allowed(this.actionAuthorized) || this.clock() < this.started || this.clock() >= this.started + 15) return refuse();
          if (i) { current = await this.api.firstChild(target!); for (let j = 0; j < node.path.at(-1)! && current !== null; j++) current = await this.api.nextSibling(current); }
          const original = retained.get(node.id); const { id: _id, parentId: _parent, depth: _depth, path: _path, ...expected } = node;
          if (current === null || original === undefined || !equal(details(await this.api.describe(current)), expected) || !await this.api.same(current, original) || !equal(details(await this.api.describe(original)), expected)) return refuse();
          target = original;
        }
        const node = chain.at(-1)!;
        if (!node.actions.includes("invoke") || node.states.enabled !== true || node.states.offscreen !== false || node.states.password !== false || !node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) return refuse();
        this.authorize(); if (!allowed(this.actionAuthorized) || this.clock() >= this.started + 15) return refuse();
      } catch { return refuse(); }
      try { await this.api.invoke(target!); this.authorize(); if (!allowed(this.actionAuthorized)) throw new Error("UIA owner ended"); return { status: "posted" }; }
      catch { throw new ServiceError("Windows native invocation is unconfirmed; inspect before another action.", 409, { retryable: false, outcome: "unknown" }); }
    });
  }
}
