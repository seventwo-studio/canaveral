/** Lease-key uploads of large app builds for a leased emulator. They reuse the administrative
 * upload contract (app-artifacts.ts): UUID intents, sequential 512 KiB chunks, digest-checked
 * publication, host scratch reservations and positive install cleanup. Installation is the
 * lease operation `install-uploaded` (consumer-operations.ts).
 *
 * Scope: only the lease's current key reaches these routes, an upload binds one lease member,
 * and new intents and chunks need a ready lease. Ending the lease refuses further chunks; the
 * upload's reservation is released at once when no install was dispatched, otherwise only after
 * every attempt is clean, which the lease's own proven emulator removal establishes. */
import type { ControlModule, ControlRequest } from './contracts.ts';
import type { SqliteStore } from '../sqlite.ts';
import { ServiceError } from '../errors.ts';
import type { MachineStore } from './machines.ts';
import { artifactRow, artifactView, changeArtifact, fields, initializeAppArtifacts, insertArtifact, reserveArtifact, scratchGiB, STORAGE_BYTES } from './app-artifacts.ts';
import { ACTIVE, leaseScopedMember, legacySessionLease, requireApplicationCapacity } from './leases.ts';
import { uuid } from './transfers.ts';

/** Uploads a single lease may hold at once, in any state but deleted. */
export const LEASE_ARTIFACTS = 4;
/** One application's share of the controller-wide upload pool across all of its leases. Declared
 * sizes count from creation, so without a share one lease key could reserve the whole pool with no
 * data sent and refuse every other upload on the controller. */
export const APPLICATION_UPLOAD_SHARE = STORAGE_BYTES / 4;
const fail = (status = 400): never => { throw new ServiceError('App artifact request rejected.', status); };

export function createLeaseAppArtifactsModule(store: SqliteStore, machines: MachineStore): ControlModule {
  store.transaction(initializeAppArtifacts);
  return { handle(req: ControlRequest) {
    const p = req.parts;
    if (p[0] !== 'v1' || p[1] !== 'leases' || p[3] !== 'app-artifacts' || !p[2]) return undefined;
    const create = req.method === 'POST' && p.length === 4, read = req.method === 'GET' && p.length === 5;
    const change = req.method === 'POST' && p.length === 6 && ['chunks', 'complete', 'delete'].includes(p[5]!);
    if (!create && !read && !change) return undefined;
    if (req.query.size) return fail();
    const leaseId = uuid(p[2]);
    return store.transaction(db => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get() || !db.prepare('SELECT 1 FROM leases WHERE id=?').get(leaseId)) return undefined;
      if (create) {
        fields(req.body, ['id', 'member', 'format', 'bytes', 'sha256']);
        const { member, ...intent } = req.body;
        // Replay first: a saved receipt stays readable by the current key after the lease ends.
        const lease = legacySessionLease(db, leaseId, req.token), id = uuid(intent.id), old = db.prepare('SELECT lease FROM app_artifacts WHERE id=?').get(id);
        if (old && old.lease !== lease.id) return fail(404);
        if (old) {
          const saved = artifactRow(db, id), name = db.prepare('SELECT name FROM lease_members WHERE lease=? AND machine=?').get(lease.id, saved.machine)?.name;
          if (name !== member) return fail(409);
          const reserved = reserveArtifact(db, machines, db.prepare('SELECT * FROM machines WHERE id=?').get(saved.machine)!, intent, lease.id, () => {});
          if (!('replayed' in reserved)) return fail(409);
          return { body: artifactView(reserved.replayed) };
        }
        const scoped = leaseScopedMember(db, leaseId, req.token, member, 'files', store.clock());
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM app_artifacts WHERE lease=? AND state!='deleted'").get(lease.id)!.n) >= LEASE_ARTIFACTS) return fail(429);
        const shared = Number(db.prepare("SELECT COALESCE(SUM(a.bytes),0) AS n FROM app_artifacts a JOIN leases l ON l.id=a.lease WHERE l.consumer=? AND a.state!='deleted'").get(lease.consumer)!.n);
        if (typeof intent.bytes === 'number' && shared + intent.bytes > APPLICATION_UPLOAD_SHARE) return fail(429);
        const reserved = reserveArtifact(db, machines, scoped.machine, intent, lease.id, () => {});
        if ('replayed' in reserved) return { body: artifactView(reserved.replayed) };
        requireApplicationCapacity(db, lease.consumer, { diskGiB: scratchGiB(reserved.size) });
        return { status: 201, body: artifactView(insertArtifact(db, scoped.machine, reserved, lease.id)) };
      }
      const lease = legacySessionLease(db, leaseId, req.token), a = db.prepare('SELECT lease FROM app_artifacts WHERE id=?').get(uuid(p[4]));
      if (!a || a.lease !== lease.id) return fail(404);
      const artifact = artifactRow(db, p[4]!);
      if (read) return { body: artifactView(artifact) };
      // Chunks and publication need a live lease; deleting proven-clean bytes is always allowed.
      if (p[5] !== 'delete' && (!ACTIVE.includes(lease.state) || lease.state !== 'ready' || store.clock() >= lease.expires)) {
        if (p[5] === 'complete' && artifact.state === 'ready') return { body: artifactView(artifact) };
        throw new ServiceError('Lease has ended.', 410, { code: 'lease_ended' });
      }
      return { body: artifactView(changeArtifact(db, artifact, p[5]!, req.body)) };
    });
  } };
}
