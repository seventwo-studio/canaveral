import { options, failure, privateOutput, ensureNewOutput } from './sdk-options.ts';
try {
  const args = options('Capture a native accessibility snapshot to a new private JSON file. Uses an existing lease key; no input or rotation.', ['lease', 'request-id', 'member', 'output']);
  if (args) { await ensureNewOutput(args.required('output')); const value = await args.lease().accessibility(args.required('request-id'), String(args.values.member ?? 'primary')); await privateOutput(args.required('output'), JSON.stringify(value, null, 2)); console.log(JSON.stringify({ snapshotId: value.snapshotId, nodes: value.nodes.length, truncated: value.truncated, output: args.required('output') })); }
} catch (error) { failure(error); }
