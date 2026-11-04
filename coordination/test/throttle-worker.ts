import { parentPort, workerData } from "node:worker_threads";
import { Accounts } from "../src/accounts.ts";
import { ServiceError } from "../src/errors.ts";
import { SqliteStore } from "../src/sqlite.ts";

const accounts = new Accounts(new SqliteStore(workerData.path as string, () => 80_000));
const statuses: number[] = [];
for (let index = 0; index < 4; index++) {
  try { await accounts.login({ username: "?", password: "" }); statuses.push(200); }
  catch (error) { if (!(error instanceof ServiceError)) throw error; statuses.push(error.status); }
}
parentPort!.postMessage(statuses);
