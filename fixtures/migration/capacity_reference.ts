/** Disposable legacy controller schema, copied from the persisted table contracts.
 * It contains no provider/runtime operations and never selects retained state.
 */
import type { DatabaseSync } from 'node:sqlite';
export function capacitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE hosts (id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE retired_runners (id TEXT PRIMARY KEY);
    CREATE TABLE machines (id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE inference_jobs (id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,definition TEXT NOT NULL,desired TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,result TEXT,updated REAL NOT NULL,created REAL NOT NULL);
    CREATE TABLE images (id TEXT PRIMARY KEY,host TEXT NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE image_tasks (id TEXT PRIMARY KEY,host TEXT NOT NULL,machine TEXT,request TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated REAL NOT NULL,created REAL NOT NULL,reserved_disk INTEGER NOT NULL);
    CREATE TABLE lease_members (lease TEXT NOT NULL,role TEXT NOT NULL,machine TEXT NOT NULL);
    CREATE TABLE machine_power_offs (id TEXT PRIMARY KEY,machine TEXT NOT NULL,state TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE machine_deletions (id TEXT PRIMARY KEY,machine TEXT NOT NULL,state TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE lease_cleanup_members (lease TEXT NOT NULL,machine TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,detail TEXT,storage INTEGER NOT NULL,credentials INTEGER NOT NULL,updated REAL NOT NULL);
  `);
}
