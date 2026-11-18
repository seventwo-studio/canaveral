import { createHash, randomUUID } from "node:crypto";
import { readFileSync, openSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConsumerClient,
  ConsumerServiceError,
  LeaseClient,
  uploadWorkspaceFile,
} from "./consumer-client.ts";
import type { ClientOptions } from "./consumer-client.ts";
import { DashboardError } from "./dashboard.ts";
import { transferPath, transferUUID } from "./linux-transfers.ts";

export interface PreviewConfig {
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
  mode: "static" | "command";
  files: { path: string; data: string }[];
  argv: string[];
  port: number;
}
const invalid = (): never => {
  throw new DashboardError("Invalid preview specification.", 400);
};
export function previewIntent(body: Record<string, unknown>): Intent {
  const { id, mode, files } = body;
  try {
    transferUUID(id);
  } catch {
    return invalid();
  }
  if (
    (mode !== "static" && mode !== "command") ||
    !Array.isArray(files) ||
    files.length > 128 ||
    Object.keys(body).some(
      (k) =>
        ![
          "id",
          "mode",
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
  if (mode === "command") {
    if (
      !Array.isArray(body.argv) ||
      !body.argv.length ||
      !body.argv[0] ||
      body.argv.some((a) => typeof a !== "string" || a.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(body.argv)) > 64000 ||
      typeof body.port !== "number" ||
      !Number.isInteger(body.port) ||
      body.port < 1 ||
      body.port > 65535
    )
      return invalid();
    argv = body.argv;
    port = body.port;
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
  return { id: id as string, mode, files: entries, argv, port };
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
}
function view({ id, mode, state, expiresAt }: Row) {
  return { id, mode, state, expiresAt };
}

export class DashboardPreviews {
  private db: DatabaseSync;
  private app: ConsumerClient;
  private config: PreviewConfig;
  private options: ClientOptions;
  private keys = new Map<string, string>();
  private active = new Set<string>();
  private intents = new Map<string, Intent>();
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
      UPDATE previews SET state='stopping',failed=1 WHERE state IN ('ready','starting','provisioning')`);
    this.timer = setInterval(() => this.tick(), 1000).unref();
  }
  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM previews WHERE id=?")
      .get(id) as unknown as Row | undefined;
  }
  private state(id: string, state: string) {
    this.db.prepare("UPDATE previews SET state=? WHERE id=?").run(state, id);
  }
  handle(
    owner: string,
    method: string,
    id?: string,
    body?: Record<string, unknown>,
  ) {
    if (!id && method === "GET")
      return {
        previews: (
          this.db
            .prepare("SELECT * FROM previews WHERE owner=? ORDER BY rowid DESC")
            .all(owner) as unknown as Row[]
        ).map(view),
      };
    const intent = method === "POST" ? previewIntent(body!) : undefined;
    id = intent?.id ?? id!;
    const r = this.row(id);
    if ((r && r.owner !== owner) || (!r && !intent))
      throw new DashboardError("Unknown preview.", 404);
    if (intent) {
      const hash = createHash("sha256")
        .update(JSON.stringify(intent))
        .digest("hex");
      if (r && hash !== r.hash)
        throw new DashboardError(
          "Preview ID already has another specification.",
          409,
        );
      if (!r) {
        const expiresAt = new Date(
          Date.now() + this.config.ttlSeconds * 1000,
        ).toISOString();
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
        this.intents.set(id, intent);
      }
    } else if (method === "DELETE" && !["stopped", "failed"].includes(r!.state))
      this.state(id, "stopping");
    return view(this.row(id)!);
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
      .prepare("SELECT * FROM previews WHERE state NOT IN ('failed','stopped')")
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
    if (this.row(id)!.state === "stopping") {
      this.keys.delete(id);
      this.intents.delete(id);
      let admitted = false;
      try {
        admitted = (await this.app.cancelRequest(lease)).state === "admitted";
      } catch (e) {
        if (!(e instanceof ConsumerServiceError && e.status === 404)) throw e;
      }
      if (
        admitted &&
        (await this.app.inspectLease(lease)).cleanup.state !== "complete"
      )
        return;
      this.db
        .prepare("DELETE FROM preview_transfer_journal WHERE preview=?")
        .run(id);
      this.state(id, r.failed ? "failed" : "stopped");
      return;
    }
    const check = () => {
      if (
        this.closed ||
        this.row(id)!.state === "stopping" ||
        Date.now() >= Date.parse(r.expiresAt)
      )
        throw Error("Preview ended");
    };
    const scoped = (leaseKey: string) =>
      new LeaseClient({ ...this.options, leaseId: lease, leaseKey });
    if (r.state !== "provisioning") {
      const op = await scoped(this.keys.get(id)!).operation(r.op);
      check();
      if (op.state !== "queued") throw Error("Service ended");
      this.state(id, op.previewReady ? "ready" : "starting");
      return;
    }
    const { templateId, templateRevision, arch, digest, ttlSeconds } =
      this.config;
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
    const { request } = await this.app.submitRequest({
      id: lease,
      kind: "linux-lease",
      intent: {
        templateId,
        templateRevision,
        arch,
        ttlSeconds,
        requiredCapabilities: ["command", "files"],
      },
      deadline: r.expiresAt,
    });
    if (request.state === "waiting") return;
    if (request.state !== "admitted") throw Error("Request ended");
    const machine = await this.app.inspectLease(lease);
    if (machine.state === "provisioning") return;
    if (machine.state !== "ready") throw Error("Lease ended");
    if (!machine.members[0]?.ready) return;
    check();
    const key = (await this.app.rotateLeaseCredential(lease)).credential;
    const client = scoped(key),
      intent = this.intents.get(id)!;
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
        {
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
        },
        {
          wait: async () => {
            check();
            await delay(150);
          },
        },
      );
    }
    check();
    await client.createOperation({
      id: r.op,
      member: "primary",
      action: "shell",
      arguments: {
        argv: [
          "/sbin/canaveral-guest-agent",
          "--preview-service",
          String(intent.port),
          ...intent.argv,
        ],
        timeoutMs: ttlSeconds * 1000,
      },
    });
    check();
    this.db
      .prepare("DELETE FROM preview_transfer_journal WHERE preview=?")
      .run(id);
    this.keys.set(id, key);
    this.intents.delete(id);
    this.state(id, "starting");
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    if (!this.active.size) this.db.close();
  }
}
