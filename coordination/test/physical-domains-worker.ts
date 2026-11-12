import { parentPort, workerData } from "node:worker_threads";
import { SqliteStore } from "../src/sqlite.ts";
import { ResourceDomains } from "../src/resource-domains.ts";
import { physicalBudget } from "../src/physical-domains.ts";
const { path, host, domain, kind, id } = workerData;
const store = new SqliteStore(path);
parentPort!.on("message", () => {
  const result = store.transaction(db => {
    const resources = { cpu: 3, memoryMiB: 1024, diskGiB: 4 };
    if (kind === "runner") return new ResourceDomains().reserve(db, { id, domain, kind, owner: id, resources }, 1);
    if (physicalBudget(db, { hostId: host })!.available.cpu < resources.cpu) return false;
    db.prepare("INSERT INTO machines(id,request,host,template,desired,observed,detail,updated) VALUES (?,?,?,'{}','running','unknown','',1)").run(id, JSON.stringify({ resources }), host);
    return true;
  });
  parentPort!.postMessage(result); parentPort!.close();
});
parentPort!.postMessage("ready");
