import { parentPort, workerData } from "node:worker_threads";
import { CapacityLedger } from "../src/capacity.ts";
import { SqliteStore } from "../src/sqlite.ts";

const { path, host, id } = workerData as { path: string; host: string; id: string };
const store = new SqliteStore(path), ledger = new CapacityLedger(store);
parentPort!.on("message", () => {
  const result = store.transaction(db => {
    if (ledger.remaining(db, host).cpu < 2) return "full";
    db.prepare("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated) VALUES (?,?,?,'{}','running','pending','',80000)")
      .run(id, JSON.stringify({ resources: { cpu: 2, memoryMiB: 1024, diskGiB: 8 } }), host);
    return "reserved";
  });
  parentPort!.postMessage(result);
  parentPort!.close();
});
parentPort!.postMessage("ready");
