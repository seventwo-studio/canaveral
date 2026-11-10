/** Explicit acquisition and release. All mutation identities are caller-persisted. */
import { ConsumerClient } from '../coordination/dist/src/sdk.js';
import { options, failure } from './sdk-options.ts';
try {
  const args = options('Acquire, inspect and release. Credential rotation occurs only with --rotate-credential. Persist the complete request before dispatch.', ['request-id', 'release-request-id', 'image', 'revision', 'arch'], ['rotate-credential']);
  if (args) {
    const arch = args.required('arch'); if (arch !== 'arm64' && arch !== 'amd64') throw new Error('Invalid arch');
    const client = ConsumerClient.fromCredentialFile({ ...args.base, credentialFile: args.required('credential-file') });
    const releaseId = args.required('release-request-id');
    const { lease } = await client.acquireLease({ id: args.required('request-id'), templateId: args.required('image'), templateRevision: args.required('revision'), arch, ttlSeconds: 60 });
    console.log(JSON.stringify({ id: lease.id, state: lease.state, revision: lease.revision }));
    if (lease.state === 'ready' || lease.state === 'provisioning') {
      try { if (args.values['rotate-credential']) { const scoped = await client.scopedLease(lease.id); const view = await scoped.inspect(); console.log(JSON.stringify({ id: view.id, state: view.state, revision: view.revision })); } }
      finally { const result = await client.releaseLease(lease.id, { id: releaseId }); console.log(JSON.stringify({ id: result.lease.id, state: result.lease.state, cleanup: result.lease.cleanup.state })); }
    }
  }
} catch (error) { failure(error); }
