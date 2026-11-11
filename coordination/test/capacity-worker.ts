import { parentPort, workerData } from "node:worker_threads";
import { CapacityLedger } from "../src/capacity.ts";
import { ResourceDomains } from "../src/resource-domains.ts";
import { SqliteStore } from "../src/sqlite.ts";

const { path, host, id, domain } = workerData as { path: string; host: string; id: string; domain?: string };
const store = new SqliteStore(path, () => 80000), ledger = new CapacityLedger(store);
parentPort!.on("message", () => {
  const result = store.transaction(db => {
    if (domain) return new ResourceDomains(() => 80000).reserve(db, { id, domain, kind: "model-job", owner: id, resources: { cpu: 2, memoryMiB: 1024, diskGiB: 8 } }, 80000) ? "reserved" : "full";
    if (ledger.remaining(db, host).cpu < 2) return "full";
    db.prepare("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated) VALUES (?,?,?,'{}','running','pending','',80000)")
      .run(id, JSON.stringify({ resources: { cpu: 2, memoryMiB: 1024, diskGiB: 8 } }), host);
    return "reserved";
  });
  parentPort!.postMessage(result);
  parentPort!.close();
});
parentPort!.postMessage("ready");
