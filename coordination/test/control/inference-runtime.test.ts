import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inferenceNativeHelper, OllamaExecutor } from "../../src/inference-runtime.ts";
import { modelJobCanRelease, parseModelJob } from "../../src/model-job.ts";
import type { ModelJob, ModelJobState } from "../../src/model-job.ts";

const model = { id: "fixture:latest", digest: `sha256:${"a".repeat(64)}`, capability: "generation", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 1 } };
const helper = process.env.CANAVERAL_INFERENCE_HELPER ?? inferenceNativeHelper({});
const runtimeFixture = `#!${process.execPath}
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root=process.env.OLLAMA_MODELS, mode=fs.existsSync(path.join(root,'mode'))?fs.readFileSync(path.join(root,'mode'),'utf8'):'';
fs.writeFileSync(path.join(root,'environment.json'),JSON.stringify(process.env));
fs.writeFileSync(path.join(root,'pid'),String(process.pid));
let child;
if(mode==='child'||mode==='foreign-listener') {
 const source=mode==='child'?'setInterval(()=>{},1000)':"require('node:http').createServer((req,res)=>{require('node:fs').writeFileSync(process.argv[1],'contacted');res.end('{}')}).listen(Number(process.argv[2]),'127.0.0.1')";
 child=spawn(process.execPath,['-e',source,path.join(root,'intruder-requests'),process.env.OLLAMA_HOST.split(':')[1]],{stdio:'ignore',env:{}});
 fs.writeFileSync(path.join(root,'child-pid'),String(child.pid));
 process.on('SIGTERM',()=>{child.kill('SIGTERM'); child.once('exit',()=>process.exit(0));});
}
if(mode==='startup-hang'||mode==='foreign-listener') setInterval(()=>{},1000);
else if(mode==='startup-exit') process.exit(1);
else {
const server=http.createServer(async(req,res)=>{
 const chunks=[]; for await(const chunk of req)chunks.push(chunk);
 const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 fs.appendFileSync(path.join(root,'requests.jsonl'),JSON.stringify({path:req.url,value})+'\\n');
 let result;
 if(req.url==='/api/version')result={version:'fixture'};
 else if(req.url==='/api/tags')result={models:[{name:'fixture:latest',digest:(mode==='digest'?'b':'a').repeat(64)}]};
 else if(req.url==='/api/show'){
  result={capabilities:mode==='capability'?['embedding']:['completion']};
  if(mode==='remote')result.remote_host='https://example.invalid';
 }else if(req.url==='/api/generate'){
  fs.writeFileSync(path.join(root,'generating'),'yes');
  if(mode==='wait'){setTimeout(()=>res.destroy(),30000).unref();return;}
  if(mode==='drop'){res.destroy();return;}
  if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/never'});res.end();return;}
  if(mode==='duplicate'){res.end('{"done":false,"done":true,"model":"fixture:latest","response":"hello","prompt_eval_count":4,"eval_count":5}');return;}
  if(mode==='utf8'){res.end(Buffer.from([255]));return;}
  if(mode==='oversized'){res.end('x'.repeat(1048577));return;}
  result={model:mode==='wrong-model'?'other:latest':'fixture:latest',done:mode!=='incomplete',response:'Hello from fixture.',prompt_eval_count:4,eval_count:mode==='tokens'?999:5};
  if(mode==='usage')delete result.eval_count;
  if(mode==='empty')result.response=' ';
  if(mode==='unicode-bound')result.response='é'.repeat(50000);
 }else {res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
});
server.listen(Number(process.env.OLLAMA_HOST.split(':')[1]),'127.0.0.1');
}
`;

function submission(changes: Record<string, unknown> = {}): ModelJob {
  return parseModelJob({ version: 1, applicationId: randomUUID(), id: randomUUID(), message: {
    type: "submit", adapter: "ollama", model: model.id, digest: model.digest, prompt: "Private fixture prompt", maxTokens: 64, ...changes,
  } });
}
function fixture(t: { after(callback: () => void | Promise<void>): void }, mode = "", overrides: Record<string, unknown> = {}) {
  assert.ok(existsSync(helper), "Build canaveral-mobile-native before the portable inference fixture tests.");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "canaveral-ollama-fixture-"));
  const models = join(root, "models");
  const state = join(root, "state");
  const executable = join(root, "ollama-fixture.mjs");
  writeFileSync(executable, runtimeFixture, { mode: 0o700 });
  const config = { runtime: "ollama", executable, modelsDirectory: models, models: [model], nativeHelper: helper,
    startupMs: 1500, executionMs: 1500, stopMs: 1500, pollMs: 20, ...overrides };
  mkdirSync(models, { mode: 0o700 }); writeFileSync(join(models, "mode"), mode, { mode: 0o600 });
  const executor = new OllamaExecutor(config, state);
  t.after(async () => { await executor.close(); rmSync(root, { recursive: true, force: true }); });
  const requests = (): Array<{ path: string; value: Record<string, unknown> }> => existsSync(join(models, "requests.jsonl")) ? readFileSync(join(models, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { path: string; value: Record<string, unknown> }) : [];
  const journals = () => {
    const db = new DatabaseSync(join(state, "execution.sqlite"));
    try { return db.prepare("SELECT * FROM ollama_execution_receipts").all().map(row => ({ ...row })); } finally { db.close(); }
  };
  return { root, models, state, config, executor, requests, journals, generating: () => existsSync(join(models, "generating")) };
}
function state(receipt: ModelJob): ModelJobState { assert.equal(receipt.message.type, "receipt"); return receipt.message.type === "receipt" ? receipt.message.state : "unknown"; }
function pidAbsent(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }
function assertStopped(f: ReturnType<typeof fixture>): void {
  if (existsSync(join(f.models, "pid"))) assert.equal(pidAbsent(Number(readFileSync(join(f.models, "pid"), "utf8"))), true);
  assert.equal(readdirSync(f.state).filter(path => path.startsWith("work-")).length, 0);
}

test("default JSON-configured executor serves exact installed model and persists terminal results without replay", async t => {
  const f = fixture(t), job = submission();
  const previousSecret = process.env.EXAMPLE_PROVIDER_SECRET, previousProxy = process.env.HTTP_PROXY, previousNode = process.env.NODE_OPTIONS;
  process.env.EXAMPLE_PROVIDER_SECRET = "never-inherit"; process.env.HTTP_PROXY = "http://invalid"; process.env.NODE_OPTIONS = "--throw-deprecation";
  let receipt: ModelJob;
  try { receipt = await f.executor.execute(job, () => "continue", () => undefined); }
  finally {
    for (const [key, value] of [["EXAMPLE_PROVIDER_SECRET", previousSecret], ["HTTP_PROXY", previousProxy], ["NODE_OPTIONS", previousNode]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.equal(state(receipt), "succeeded"); assert.equal(modelJobCanRelease(receipt), true);
  assert.equal(receipt.message.type === "receipt" && receipt.message.result?.usage.outputTokens, 5);
  const environment = JSON.parse(readFileSync(join(f.models, "environment.json"), "utf8")) as Record<string, string>;
  for (const secret of ["EXAMPLE_PROVIDER_SECRET", "HTTP_PROXY", "NODE_OPTIONS"]) assert.equal(Object.hasOwn(environment, secret), false);
  assert.equal(environment.OLLAMA_NO_CLOUD, "1"); assert.equal(environment.OLLAMA_NOPRUNE, "1");
  assert.ok(environment.HOME?.startsWith(f.state)); assert.ok(environment.TMPDIR?.startsWith(f.state));
  assert.equal(environment.OLLAMA_NUM_PARALLEL, "1"); assert.equal(environment.OLLAMA_MAX_LOADED_MODELS, "1");
  const generated = f.requests().find(req => req.path === "/api/generate")!.value;
  assert.deepEqual(generated, { model: model.id, prompt: "Private fixture prompt", stream: false, keep_alive: 0, think: false, options: { num_ctx: 8192, num_predict: 64 } });
  assert.equal(f.requests().some(req => req.path.includes("pull")), false);
  assertStopped(f);
  const count = f.requests().length, restarted = new OllamaExecutor(f.config, f.state);
  assert.equal(JSON.stringify(await restarted.execute(job, () => "continue", () => undefined)), JSON.stringify(receipt));
  assert.equal(f.requests().length, count); await restarted.close();
  assert.equal(lstatSync(join(f.state, "execution.sqlite")).mode & 0o077, 0);
});

test("installed tag digest, remote aliases and capabilities are rejected before generation without pull", async t => {
  for (const mode of ["digest", "remote", "capability"]) {
    const f = fixture(t, mode), receipt = await f.executor.execute(submission(), () => "continue", () => undefined);
    assert.equal(state(receipt), "failed", mode); assert.equal(modelJobCanRelease(receipt), true);
    assert.equal(f.requests().some(req => ["/api/generate", "/api/pull"].includes(req.path)), false); assertStopped(f);
  }
});

test("incomplete, wrong-model, unmeasured, unbounded or malformed results cannot succeed", async t => {
  for (const mode of ["incomplete", "usage", "tokens", "wrong-model", "empty", "duplicate", "utf8", "oversized", "unicode-bound", "redirect"]) {
    const f = fixture(t, mode), receipt = await f.executor.execute(submission(), () => "continue", () => undefined);
    assert.equal(state(receipt), "failed", mode); assert.equal(modelJobCanRelease(receipt), true, mode);
    assert.equal(f.requests().filter(req => req.path === "/api/generate").length, 1); assertStopped(f);
  }
});

test("queued cancellation launches nothing and active cancellation fences process before positive receipt", async t => {
  const queued = fixture(t), before = await queued.executor.execute(submission(), () => "cancel", () => undefined);
  assert.equal(state(before), "cancelled"); assert.equal(modelJobCanRelease(before), true); assert.equal(queued.requests().length, 0);
  const f = fixture(t, "wait"), receipt = await f.executor.execute(submission(), () => f.generating() ? "cancel" : "continue", () => undefined);
  assert.equal(state(receipt), "cancelled"); assert.equal(modelJobCanRelease(receipt), true); assertStopped(f);
});

test("resource and controller-contact fences run while generation is blocked", async t => {
  const memory = fixture(t, "wait", { executionMs: 3000 });
  const restricted = await memory.executor.execute(submission(), () => "continue", () => memory.generating() ? "Active swap traffic" : undefined);
  assert.equal(state(restricted), "failed"); assert.equal(modelJobCanRelease(restricted), true); assertStopped(memory);
  const contact = fixture(t, "wait");
  const fenced = await contact.executor.execute(submission(), () => contact.generating() ? "fence" : "continue", () => undefined);
  assert.equal(state(fenced), "unknown"); assert.equal(modelJobCanRelease(fenced), false); assertStopped(contact);
  assert.equal(contact.journals()[0]!.stop_proven, 1); assert.equal(contact.journals()[0]!.cleanup_proven, 1);
});

test("startup and generation deadlines stop owned work without retries", async t => {
  for (const mode of ["startup-hang", "startup-exit", "wait"]) {
    const f = fixture(t, mode, { startupMs: 350, executionMs: 350 });
    const receipt = await f.executor.execute(submission(), () => "continue", () => undefined);
    assert.equal(state(receipt), "failed", mode); assert.equal(modelJobCanRelease(receipt), true, mode);
    assert.ok(f.requests().filter(req => req.path === "/api/generate").length <= 1); assertStopped(f);
  }
});

test("lost generation response stays unknown after positive cleanup and cannot be replayed", async t => {
  const f = fixture(t, "drop"), job = submission();
  const first = await f.executor.execute(job, () => "continue", () => undefined);
  assert.equal(state(first), "unknown"); assert.equal(modelJobCanRelease(first), false); assertStopped(f);
  const count = f.requests().length;
  const restarted = new OllamaExecutor(f.config, f.state);
  assert.equal(state(await restarted.execute(job, () => "cancel", () => undefined)), "unknown");
  assert.equal(state(await restarted.execute(submission(), () => "continue", () => undefined)), "unknown");
  assert.equal(f.requests().length, count); await restarted.close();
});

test("durable launch intent exists before child dispatch; interrupted journals never adopt a PID", async t => {
  const f = fixture(t), job = submission();
  let intentObserved = false;
  const report = await f.executor.execute(job, () => {
    if (f.journals()[0]?.phase === "running") intentObserved = true;
    return "continue";
  }, () => undefined);
  assert.equal(state(report), "succeeded"); assert.equal(intentObserved, true);
  const interrupted = submission(), db = new DatabaseSync(join(f.state, "execution.sqlite"));
  const message = interrupted.message;
  assert.equal(message.type, "submit");
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update(JSON.stringify(interrupted)).digest("hex");
  db.prepare("INSERT INTO ollama_execution_receipts(application,id,fingerprint,phase,workspace) VALUES (?,?,?,'running','/foreign/workspace')").run(interrupted.applicationId, interrupted.id, fingerprint); db.close();
  const count = f.requests().length;
  assert.equal(state(await f.executor.execute(interrupted, () => "cancel", () => undefined)), "unknown");
  assert.equal(f.requests().length, count);
});

test("owned fixture descendants are stopped before a successful result is released", async t => {
  const f = fixture(t, "child"), receipt = await f.executor.execute(submission(), () => "continue", () => undefined);
  assert.equal(state(receipt), "succeeded"); assert.equal(modelJobCanRelease(receipt), true);
  assert.equal(pidAbsent(Number(readFileSync(join(f.models, "child-pid"), "utf8"))), true); assertStopped(f);
});

test("a listener outside the pinned runtime leader never receives even a readiness request", async t => {
  const f = fixture(t, "foreign-listener", { startupMs: 350 });
  const receipt = await f.executor.execute(submission(), () => "continue", () => undefined);
  assert.equal(state(receipt), "failed"); assert.equal(modelJobCanRelease(receipt), true);
  assert.equal(existsSync(join(f.models, "intruder-requests")), false);
  assert.equal(pidAbsent(Number(readFileSync(join(f.models, "child-pid"), "utf8"))), true); assertStopped(f);
});

test("concurrent executor instances do not dispatch a second runtime for a durable launch", async t => {
  const f = fixture(t, "wait"), job = submission();
  let cancelled = false;
  const first = f.executor.execute(job, () => cancelled ? "cancel" : "continue", () => undefined);
  const deadline = Date.now() + 3000;
  while (!f.generating() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.generating(), true);
  const second = new OllamaExecutor(f.config, f.state);
  t.after(() => second.close());
  assert.equal(state(await second.execute(job, () => "continue", () => undefined)), "unknown");
  assert.equal(state(await second.execute(submission(), () => "continue", () => undefined)), "unknown");
  assert.equal(f.requests().filter(req => req.path === "/api/generate").length, 1);
  cancelled = true;
  assert.equal(state(await first), "cancelled"); assertStopped(f);
  const changed = parseModelJob({ ...job, message: { ...job.message, prompt: "Changed identity" } });
  assert.equal(state(await second.execute(changed, () => "continue", () => undefined)), "unknown");
});

test("unconfirmed native stop keeps workspace and reservation unknown even if generation completed", async t => {
  const f = fixture(t);
  const wrapper = join(f.root, "unconfirmed-helper.mjs");
  writeFileSync(wrapper, `#!${process.execPath}
import {spawn} from 'node:child_process'; import readline from 'node:readline';
const child=spawn(${JSON.stringify(helper)},['process'],{stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
process.stdin.pipe(child.stdin);
const lines=readline.createInterface({input:child.stdout});
let lastOp='';
const input=readline.createInterface({input:process.stdin});input.on('line',line=>{lastOp=JSON.parse(line).op;});
lines.on('line',line=>{const v=JSON.parse(line);if(lastOp==='processStop'&&v.ok)v.body.stopped=false;process.stdout.write(JSON.stringify(v)+'\\n');});
child.once('exit',()=>process.exit(0));
`, { mode: 0o700 });
  const executor = new OllamaExecutor({ ...f.config, nativeHelper: wrapper }, join(f.root, "uncertain-state"));
  t.after(() => executor.close());
  const receipt = await executor.execute(submission(), () => "continue", () => undefined);
  assert.equal(state(receipt), "unknown"); assert.equal(modelJobCanRelease(receipt), false);
  assert.equal(readdirSync(executor.stateDirectory).filter(path => path.startsWith("work-")).length, 1);
});

test("unsafe paths, inventory links, wrong pin and executor close never launch a runtime", async t => {
  const f = fixture(t);
  symlinkSync(f.config.executable, join(f.models, "untrusted-link"));
  await assert.rejects(() => f.executor.check());
  assert.equal(f.requests().length, 0);
  rmSync(join(f.models, "untrusted-link"));
  const wrong = await f.executor.execute(submission({ digest: `sha256:${"b".repeat(64)}` }), () => "continue", () => undefined);
  assert.equal(state(wrong), "failed"); assert.equal(modelJobCanRelease(wrong), true); assert.equal(f.requests().length, 0);
  await f.executor.close();
  await assert.rejects(() => f.executor.execute(submission(), () => "continue", () => undefined));
  assert.throws(() => new OllamaExecutor({ ...f.config, executable: "ollama" }, join(f.root, "invalid-state")));
});
