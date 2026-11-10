/** Persisted operation submission or read-only recovery with an existing lease key. */
import { options, failure, readRequestFile } from './sdk-options.ts';
import type { OperationRequest } from '../coordination/dist/src/sdk.js';
try {
  const args = options('Submit --request-file or inspect --operation-id. No retry or credential rotation.', ['lease-id', 'request-file', 'operation-id']);
  if (args) {
    const submit = typeof args.values['request-file'] === 'string'; if (submit === (typeof args.values['operation-id'] === 'string')) throw new Error('Choose one mode');
    const lease = args.lease(); let result;
    if (submit) { const request = await readRequestFile(args.required('request-file')); result = (await lease.createOperation(request as OperationRequest)).operation; }
    else result = await lease.operation(args.required('operation-id'));
    console.log(JSON.stringify({ id: result.id, leaseId: result.leaseId, member: result.member, state: result.state, updatedAt: result.updatedAt }));
  }
} catch (error) { failure(error); }
