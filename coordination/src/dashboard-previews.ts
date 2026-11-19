import { createHash, randomUUID } from "node:crypto";
import { readFileSync, openSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConsumerClient,
  ConsumerError,
  ConsumerServiceError,
  ConsumerTransportError,
  LeaseClient,
  uploadWorkspaceFile,
  downloadWorkspaceFile,
} from "./consumer-client.ts";
import type { ClientOptions } from "./consumer-client.ts";
import { DashboardError } from "./dashboard.ts";
import { transferPath, transferUUID } from "./linux-transfers.ts";

import type { TransferJournal } from "./linux-transfer-sdk.ts";
import { operationReceipt } from "./linux-operations.ts";

type BuildImage = Pick<
  PreviewConfig,
  "templateId" | "templateRevision" | "arch" | "digest"
> & { id: string };
export interface PreviewConfig {
  buildImages?: BuildImage[];
  applicationKeyFile: string;
  database: string;
  templateId: string;
  templateRevision: string;
  arch: "arm64" | "amd64";
  digest: string;
  ttlSeconds: number;
}
interface Intent {
  id: string;
  mode: "static" | "command" | "build";
  imageId?: string;
  artifact?: string;
  files: { path: string; data: string }[];
  argv: string[];
  port: number;
  /** Preview-only queue fields; present only when the caller supplied them, so older bodies keep their replay hash. */
  priority?: number;
  deadline?: string;
}
/** Bounds the waiting deadline a dashboard owner may hold an application waiting slot for. */
const MAX_WAIT_MS = 24 * 3600 * 1000;
export function previewIntent(body: Record<string, unknown>): Intent {
  return workspaceIntent(body, false);
}
function workspaceIntent(
  body: Record<string, unknown>,
  build: boolean,
): Intent {
  const invalid = (): never => {
    throw new DashboardError(
      build ? "Invalid build specification." : "Invalid preview specification.",
      400,
    );
  };
  const { id, files } = body;
  const mode = build ? "build" : body.mode;
  let artifact: string | undefined;
  if (build) {
    if (typeof body.imageId !== "string") return invalid();
    try {
      artifact = transferPath(body.artifact);
    } catch {
      return invalid();
    }
  }
  try {
    transferUUID(id);
  } catch {
    return invalid();
  }
  if (
    (!build && mode !== "static" && mode !== "command") ||
    !Array.isArray(files) ||
    files.length > 128 ||
    Object.keys(body).some(
      (k) =>
        ![
          "id",
          ...(build
            ? ["imageId", "artifact", "argv"]
            : ["mode", "priority", "deadline"]),
          "files",
          ...(mode === "command" ? ["argv", "port"] : []),
        ].includes(k),
    )
  )
    return invalid();
  const paths = new Set<string>();
  const entries = files.map((f) => {
    if (
      !f ||
      Object.keys(f).length !== 2 ||
      typeof f.data !== "string" ||
      Buffer.from(f.data, "base64").toString("base64") !== f.data
    )
      return invalid();
    let path: string;
    try {
      path = transferPath(f.path);
    } catch {
      return invalid();
    }
    if (paths.has(path)) return invalid();
    paths.add(path);
    return { path, data: f.data as string };
  });
  const parents = parentDirectories(entries);
  if (
    parents.some((p) => paths.has(p)) ||
    Buffer.byteLength(JSON.stringify(parents)) > 60000
  )
    return invalid();
  for (const path of paths) {
    const components = path.split("/");
    while (components.length > 1) {
      components.pop();
      if (paths.has(components.join("/"))) return invalid();
    }
  }
  let argv: string[], port: number;
  if (mode === "command" || build) {
    if (
      !Array.isArray(body.argv) ||
      !body.argv.length ||
      !body.argv[0] ||
      body.argv.some((a) => typeof a !== "string" || a.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(body.argv)) > 64000 ||
      (!build &&
        (typeof body.port !== "number" ||
          !Number.isInteger(body.port) ||
          body.port < 1 ||
          body.port > 65535))
    )
      return invalid();
    argv = body.argv;
    port = build ? 0 : (body.port as number);
  } else {
    if (!paths.has("index.html")) return invalid();
    port = 18760;
    // The guest serves only paths explicitly present in the upload manifest.
    const script = `const files=new Set(JSON.parse(process.argv[1])),fs=require('node:fs');
require('node:http').createServer((q,r)=>{let p;try{p=decodeURIComponent(new URL(q.url,'http://localhost').pathname.slice(1))||'index.html'}catch{}
if(!files.has(p)){r.writeHead(404).end();return}
const mime={html:'text/html',css:'text/css',js:'text/javascript',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg'};
r.setHeader('Content-Type',mime[p.split('.').pop()]||'application/octet-stream');
fs.createReadStream(p).on('error',()=>r.destroy()).pipe(r)}).listen(18760,'127.0.0.1')`;
    argv = ["node", "-e", script, JSON.stringify([...paths])];
  }
  if (Buffer.byteLength(JSON.stringify(argv)) > 64000) return invalid();
  const { priority, deadline } = body;
  if (
    priority !== undefined &&
    (typeof priority !== "number" ||
      !Number.isSafeInteger(priority) ||
      priority < -1000000 ||
      priority > 1000000)
  )
    return invalid();
  if (
    deadline !== undefined &&
    (typeof deadline !== "string" ||
      !/^\d{4}-\d\d-\d\dT[^Z]*Z$/.test(deadline) ||
      !Number.isFinite(Date.parse(deadline)))
  )
    return invalid();
  return {
    id: id as string,
    mode: mode as Intent["mode"],
    ...(artifact ? { artifact, imageId: body.imageId as string } : {}),
    files: entries,
    argv,
    port,
    ...(priority === undefined ? {} : { priority: priority as number }),
    ...(deadline === undefined ? {} : { deadline: deadline as string }),
  };
}
function parentDirectories(files: { path: string }[]) {
  return [
    ...new Set(
      files
        .filter((f) => f.path.includes("/"))
        .map((f) => f.path.slice(0, f.path.lastIndexOf("/"))),
    ),
  ];
}
interface Row {
  id: string;
  owner: string;
  mode: string;
  hash: string;
  state: string;
  expiresAt: string;
  lease: string;
  op: string;
  failed: number;
  /** Last controller request state observed for a preview, from workspace_requests. */
  request?: string | null;
}
/** The controller's view of a preview's waiting request. Intent fields (files, argv) are never echoed. */
interface QueueView {
  state: string;
  priority: number;
  deadline: string | null;
  reason: string | null;
  admittedAt: string | null;
}
function view({ id, mode, state, expiresAt, request }: Row) {
  return {
    id,
    mode,
    state,
    expiresAt,
    ...(request ? { request: JSON.parse(request) as QueueView } : {}),
  };
}
function queueView(request: QueueView): QueueView {
  const { state, priority, deadline, reason, admittedAt } = request;
  return { state, priority, deadline, reason, admittedAt };
}

export class DashboardPreviews {
  readonly images: BuildImage[];
  private db: DatabaseSync;
  private app: ConsumerClient;
  private config: PreviewConfig;
  private options: ClientOptions;
  private keys = new Map<string, string>();
  private active = new Set<string>();
  private timer: NodeJS.Timeout;
  private closed = false;
  constructor(config: PreviewConfig, options: ClientOptions) {
    if (
      !config.database ||
      !Number.isInteger(config.ttlSeconds) ||
      config.ttlSeconds < 30 ||
      config.ttlSeconds > 1800 ||
      !/^sha256:[a-f0-9]{64}$/.test(config.digest)
    )
      throw new Error("Invalid preview configuration");
    const { templateId, templateRevision, arch, digest } = config;
    this.images = [
      { id: "default", templateId, templateRevision, arch, digest },
      ...(config.buildImages ?? []),
    ].map(({ id, templateId, templateRevision, arch, digest }) => ({
      id,
      templateId,
      templateRevision,
      arch,
      digest,
    }));
    if (
      new Set(this.images.map((i) => i.id)).size !== this.images.length ||
      this.images.some(
        (i) =>
          !i.id ||
          !i.templateId ||
          !i.templateRevision ||
          !["amd64", "arm64"].includes(i.arch) ||
          !/^sha256:[a-f0-9]{64}$/.test(i.digest),
      )
    )
      throw Error("Invalid build image configuration");
    this.config = config;
    this.options = options;
    this.app = new ConsumerClient({
      ...options,
      applicationKey: readFileSync(config.applicationKeyFile, "utf8").trim(),
    });
    closeSync(openSync(config.database, "a", 0o600));
    this.db = new DatabaseSync(config.database);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,owner TEXT,mode TEXT,hash TEXT,state TEXT,expiresAt TEXT,lease TEXT,op TEXT,failed INTEGER);
      CREATE TABLE IF NOT EXISTS preview_transfer_journal(preview TEXT,transfer TEXT,step INTEGER,payload TEXT,PRIMARY KEY(preview,transfer,step));
      CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY,imageId TEXT,artifact TEXT,result TEXT,bytes BLOB,sha256 TEXT,submitted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS build_chunks(id TEXT,seq INTEGER PRIMARY KEY,data BLOB);
      CREATE TABLE IF NOT EXISTS workspace_requests(id TEXT PRIMARY KEY,intent TEXT,deadline TEXT NOT NULL,submitted INTEGER NOT NULL DEFAULT 0,request TEXT);
      UPDATE previews SET state='stopping',failed=1 WHERE state IN ('ready','starting','provisioning','running')
        AND NOT (state='provisioning' AND mode!='build' AND id IN (SELECT id FROM workspace_requests WHERE intent IS NOT NULL
          AND coalesce(json_extract(request,'$.state'),'waiting')='waiting'))`);
    // A preview whose request was never seen admitted holds no lease key, workspace or service, so it resumes waiting.
    this.timer = setInterval(() => this.tick(), 1000).unref();
  }
  private row(id: string) {
    return this.db
      .prepare(
        "SELECT p.*,w.request FROM previews p LEFT JOIN workspace_requests w ON w.id=p.id WHERE p.id=?",
      )
      .get(id) as unknown as Row | undefined;
  }
  private observe(id: string, request: QueueView) {
    this.db
      .prepare("UPDATE workspace_requests SET request=? WHERE id=?")
      .run(JSON.stringify(queueView(request)), id);
  }
  private state(id: string, state: string) {
    this.db.prepare("UPDATE previews SET state=? WHERE id=?").run(state, id);
  }
  handle(
    owner: string,
    method: string,
    id?: string,
    body?: Record<string, unknown>,
    build = false,
  ) {
    if (!id && method === "GET")
      return {
        [build ? "builds" : "previews"]: (
          this.db
            .prepare(
              "SELECT p.*,w.request FROM previews p LEFT JOIN workspace_requests w ON w.id=p.id WHERE owner=? AND (mode='build')=? ORDER BY p.rowid DESC",
            )
            .all(owner, Number(build)) as unknown as Row[]
        ).map((r) => (build ? this.buildView(r, false) : view(r))),
      };
    const intent =
      method === "POST" ? workspaceIntent(body!, build) : undefined;
    id = intent?.id ?? id!;
    const r = this.row(id);
    if (
      (r && (r.owner !== owner || (r.mode === "build") !== build)) ||
      (!r && !intent)
    )
      throw new DashboardError(
        build ? "Unknown build." : "Unknown preview.",
        404,
      );
    if (intent) {
      const hash = createHash("sha256")
        .update(JSON.stringify(intent))
        .digest("hex");
      if (r && hash !== r.hash)
        throw new DashboardError(
          build
            ? "Build ID already has another specification."
            : "Preview ID already has another specification.",
          409,
        );
      if (!r) {
        // Without an explicit deadline a preview waits at most ttlSeconds, as before queued previews.
        const expiresAt =
          intent.deadline ??
          new Date(Date.now() + this.config.ttlSeconds * 1000).toISOString();
        if (
          intent.deadline !== undefined &&
          (Date.parse(intent.deadline) <= Date.now() ||
            Date.parse(intent.deadline) > Date.now() + MAX_WAIT_MS)
        )
          throw new DashboardError(
            "Choose a waiting deadline within the next 24 hours.",
            400,
          );
        if (build && !this.images.some((i) => i.id === intent.imageId))
          throw new DashboardError("Unknown build image.", 400);
        this.db.exec("BEGIN");
        try {
          if (build)
            this.db
              .prepare("INSERT INTO builds(id,imageId,artifact) VALUES(?,?,?)")
              .run(id, intent.imageId!, intent.artifact!);
          this.db
            .prepare("INSERT INTO previews VALUES(?,?,?,?,?,?,?,?,0)")
            .run(
              id,
              owner,
              intent.mode,
              hash,
              "provisioning",
              expiresAt,
              randomUUID(),
              randomUUID(),
            );
          this.db
            .prepare(
              "INSERT INTO workspace_requests(id,intent,deadline) VALUES(?,?,?)",
            )
            .run(id, JSON.stringify(intent), expiresAt);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    } else if (
      method === "DELETE" &&
      !["stopped", "failed", "succeeded", "stopping"].includes(r!.state)
    )
      this.state(id, "stopping");
    return build ? this.buildView(this.row(id)!, true) : view(this.row(id)!);
  }
  private buildView({ id, state, expiresAt }: Row, detail: boolean) {
    const meta = this.db
      .prepare(
        detail
          ? "SELECT imageId,artifact,result FROM builds WHERE id=?"
          : "SELECT imageId,artifact FROM builds WHERE id=?",
      )
      .get(id)!;
    return {
      id,
      state,
      expiresAt,
      imageId: meta.imageId,
      artifact: meta.artifact,
      ...(detail && typeof meta.result === "string"
        ? { result: JSON.parse(meta.result) }
        : {}),
    };
  }
  artifact(owner: string, id: string) {
    const row = this.row(id);
    if (!row || row.owner !== owner || row.mode !== "build")
      throw new DashboardError("Unknown build.", 404);
    if (row.state !== "succeeded")
      throw new DashboardError("Artifact unavailable.", 409);
    const meta = this.db
      .prepare("SELECT artifact,bytes,sha256 FROM builds WHERE id=?")
      .get(id)!;
    const bytes = Buffer.from(meta.bytes as Uint8Array);
    if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256)
      throw Error("Invalid retained artifact");
    return { name: String(meta.artifact), bytes };
  }
  target(owner: string, id: string) {
    const r = this.row(id),
      leaseKey = this.keys.get(id);
    if (
      r?.owner === owner &&
      r.state === "ready" &&
      Date.parse(r.expiresAt) > Date.now() &&
      leaseKey
    )
      return { leaseId: r.lease, operationId: r.op, leaseKey };
    return undefined;
  }
  private tick() {
    for (const r of this.db
      .prepare(
        "SELECT * FROM previews WHERE state NOT IN ('failed','stopped','succeeded')",
      )
      .all() as unknown as Row[]) {
      if (this.active.has(r.id)) continue;
      this.active.add(r.id);
      void this.advance(r)
        .catch(() => {
          if (r.state !== "stopping")
            this.db
              .prepare(
                "UPDATE previews SET state='stopping',failed=1 WHERE id=? AND state!='stopping'",
              )
              .run(r.id);
        })
        .finally(() => {
          this.active.delete(r.id);
          if (this.closed && !this.active.size) this.db.close();
        });
    }
  }
  private async advance(r: Row) {
    const { id, lease } = r;
    if (Date.now() >= Date.parse(r.expiresAt)) this.state(id, "stopping");
    const stored = this.db
      .prepare(
        "SELECT intent,deadline,submitted,request FROM workspace_requests WHERE id=?",
      )
      .get(id) as
      | {
          intent: string | null;
          deadline: string;
          submitted: number;
          request: string | null;
        }
      | undefined;
    const seen = stored?.request
      ? (JSON.parse(stored.request) as QueueView)
      : undefined;
    if (this.row(id)!.state === "stopping") {
      this.keys.delete(id);
      this.db
        .prepare("UPDATE workspace_requests SET intent=NULL WHERE id=?")
        .run(id);
      let admitted = false,
        failed = r.failed;
      try {
        const request = await this.app.cancelRequest(lease);
        this.observe(id, request);
        admitted = request.state === "admitted";
        // Waiting intent that expired or was refused never ran; the owner's own cancellation is a stop.
        if (request.state === "expired" || request.state === "rejected")
          failed = 1;
      } catch (e) {
        if (
          r.mode !== "build" &&
          seen?.state !== "admitted" &&
          e instanceof ConsumerServiceError &&
          e.status === 401
        ) {
          // The controller refuses this application's credential, for example after revocation. Revocation
          // cancels waiting intent and owns any lease, and this dashboard never held a key for this one.
          this.db.prepare("UPDATE previews SET failed=1 WHERE id=?").run(id);
          failed = 1;
        } else if (!(e instanceof ConsumerServiceError && e.status === 404))
          throw e;
        // A timed-out submission may still arrive. Its deadline fences later admission.
        // Rows from before workspace_requests keep their creation-time expiry as the deadline.
        else if (
          Date.now() < Date.parse(stored?.deadline ?? r.expiresAt) &&
          (stored?.submitted ||
            (r.mode === "build" &&
              this.db
                .prepare("SELECT id FROM builds WHERE id=? AND submitted=1")
                .get(id)))
        )
          return;
      }
      if (
        admitted &&
        (await this.app.inspectLease(lease)).cleanup.state !== "complete"
      )
        return;
      this.db
        .prepare("DELETE FROM preview_transfer_journal WHERE preview=?")
        .run(id);
      this.db.prepare("DELETE FROM build_chunks WHERE id=?").run(id);
      const published =
        r.mode === "build" &&
        this.db
          .prepare("SELECT id FROM builds WHERE id=? AND sha256 IS NOT NULL")
          .get(id);
      this.state(id, published ? "succeeded" : failed ? "failed" : "stopped");
      return;
    }
    // A preview's expiry moves from its waiting deadline to the lease expiry at admission, so read it fresh.
    const check = () => {
      const current = this.row(id)!;
      if (r.mode === "build" && Date.now() >= Date.parse(current.expiresAt))
        this.state(id, "stopping");
      if (
        this.closed ||
        this.row(id)!.state === "stopping" ||
        Date.now() >= Date.parse(current.expiresAt)
      )
        throw Error("Preview ended");
    };
    const scoped = (leaseKey: string) =>
      new LeaseClient({ ...this.options, leaseId: lease, leaseKey });
    if (r.state !== "provisioning") {
      const client = scoped(this.keys.get(id)!);
      const op = await client.operation(r.op);
      check();
      if (r.mode === "build") {
        if (op.state === "queued") return;
        const receipt = operationReceipt({
          state: op.state,
          ...(op.result ? { result: op.result } : {}),
        });
        if (receipt.result)
          this.db
            .prepare("UPDATE builds SET result=? WHERE id=?")
            .run(JSON.stringify(receipt.result), id);
        if (receipt.state !== "succeeded") throw Error("Build failed");
        await this.collectArtifact(id, client, check);
        return;
      }
      if (op.state !== "queued") throw Error("Service ended");
      this.state(id, op.previewReady ? "ready" : "starting");
      return;
    }
    if (!stored?.intent) throw Error("Workspace intent unavailable");
    const intent = JSON.parse(stored.intent) as Intent;
    const { templateId, templateRevision, arch, digest } =
      intent.mode === "build"
        ? this.images.find((i) => i.id === intent.imageId)!
        : this.config;
    const { ttlSeconds } = this.config;
    let request: QueueView;
    try {
      if (seen) {
        // The request exists; inspect it without taking the controller's write boundary every tick.
        request = await this.app.inspectRequest(lease);
      } else {
        if (!stored.submitted) {
          const images = await this.app.catalogue();
          if (
            !images.templates.some(
              (i) =>
                i.id === templateId &&
                i.revision === templateRevision &&
                i.arch === arch &&
                i.digest === digest &&
                i.workspaceIOVersion === 1,
            )
          )
            throw Error("Workspace pin unavailable");
          check();
          if (intent.mode === "build")
            this.db.prepare("UPDATE builds SET submitted=1 WHERE id=?").run(id);
          this.db
            .prepare("UPDATE workspace_requests SET submitted=1 WHERE id=?")
            .run(id);
        }
        // After a lost reply, replaying the same UUID and envelope returns the request the controller kept.
        ({ request } = await this.app.submitRequest({
          id: lease,
          kind: "linux-lease",
          intent: {
            templateId,
            templateRevision,
            arch,
            ttlSeconds,
            requiredCapabilities: ["command", "files"],
          },
          ...(intent.priority === undefined
            ? {}
            : { priority: intent.priority }),
          deadline: stored.deadline,
        }));
      }
    } catch (e) {
      if (
        e instanceof ConsumerTransportError ||
        (e instanceof ConsumerError && e.outcome === "unknown") ||
        (e instanceof ConsumerServiceError && e.status >= 500)
      )
        return;
      throw e;
    }
    this.observe(id, request);
    if (request.state === "waiting") return;
    if (request.state !== "admitted") throw Error("Request ended");
    const machine = await this.app.inspectLease(lease);
    // Lease TTL starts at admission; a preview lives until its lease expires, not its waiting deadline.
    if (intent.mode !== "build" && machine.expiresAt !== r.expiresAt)
      this.db
        .prepare("UPDATE previews SET expiresAt=? WHERE id=?")
        .run(machine.expiresAt, id);
    if (machine.state === "provisioning") return;
    if (machine.state !== "ready") throw Error("Lease ended");
    if (!machine.members[0]?.ready) return;
    check();
    const key = (await this.app.rotateLeaseCredential(lease)).credential;
    const client = scoped(key);
    const parents = parentDirectories(intent.files);
    if (parents.length) {
      check();
      const prepare = await client.createOperation({
        id: randomUUID(),
        member: "primary",
        action: "shell",
        arguments: {
          argv: [
            "node",
            "-e",
            "for(const p of process.argv.slice(1))require('node:fs').mkdirSync(p,{recursive:true})",
            "--",
            ...parents,
          ],
          timeoutMs: 10000,
        },
      });
      let operation = prepare.operation;
      while (operation.state === "queued") {
        check();
        await delay(150);
        operation = await client.operation(operation.id);
      }
      if (operation.state !== "succeeded")
        throw Error("Directory preparation unconfirmed");
    }
    for (const f of intent.files) {
      check();
      const bytes = Buffer.from(f.data, "base64");
      await uploadWorkspaceFile(
        client,
        {
          id: randomUUID(),
          direction: "upload",
          member: "primary",
          path: f.path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          replace: false,
        },
        (async function* () {
          yield bytes;
        })(),
        this.journal(id, check),
        {
          wait: async () => {
            check();
            await delay(150);
          },
        },
      );
    }
    check();
    await client
      .createOperation({
        id: r.op,
        member: "primary",
        action: "shell",
        arguments: {
          argv:
            intent.mode === "build"
              ? intent.argv
              : [
                  "/sbin/canaveral-guest-agent",
                  "--preview-service",
                  String(intent.port),
                  ...intent.argv,
                ],
          timeoutMs: ttlSeconds * 1000,
        },
      })
      .catch((error) => {
        if (
          intent.mode !== "build" ||
          !(error instanceof ConsumerError && error.outcome === "unknown")
        )
          throw error;
        // Inspect the persisted operation ID on the next tick. Never launch a replacement.
      });
    check();
    this.db
      .prepare("DELETE FROM preview_transfer_journal WHERE preview=?")
      .run(id);
    this.keys.set(id, key);
    this.db
      .prepare("UPDATE workspace_requests SET intent=NULL WHERE id=?")
      .run(id);
    this.state(id, intent.mode === "build" ? "running" : "starting");
  }
  private journal(id: string, check: () => void): TransferJournal {
    return {
      save: async (value) => {
        check();
        this.db
          .prepare("INSERT INTO preview_transfer_journal VALUES(?,?,?,?)")
          .run(
            id,
            value.id,
            "step" in value ? value.step : 0,
            JSON.stringify(value),
          );
      },
    };
  }
  private async collectArtifact(
    id: string,
    client: LeaseClient,
    check: () => void,
  ) {
    const { artifact } = this.db
      .prepare("SELECT artifact FROM builds WHERE id=?")
      .get(id)!;
    let total = 0;
    const transfer = await downloadWorkspaceFile(
      client,
      {
        id: randomUUID(),
        member: "primary",
        direction: "download",
        path: String(artifact),
      },
      async (chunk) => {
        check();
        total += chunk.length;
        if (total > 1048576) throw Error("Artifact too large");
        this.db
          .prepare("INSERT INTO build_chunks(id,data) VALUES(?,?)")
          .run(id, chunk);
      },
      this.journal(id, check),
      {
        wait: async () => {
          check();
          await delay(150);
        },
      },
      1048576,
    );
    check();
    const bytes = Buffer.concat(
      this.db
        .prepare("SELECT data FROM build_chunks WHERE id=? ORDER BY seq")
        .all(id)
        .map((c) => c.data as Uint8Array),
    );
    if (
      bytes.length !== transfer.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== transfer.sha256
    )
      throw Error("Invalid artifact");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE builds SET bytes=?,sha256=? WHERE id=?")
        .run(bytes, transfer.sha256, id);
      this.state(id, "stopping");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    if (!this.active.size) this.db.close();
  }
}
