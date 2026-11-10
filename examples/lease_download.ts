import { options, failure } from './sdk-options.ts';
try {
  const args = options('Verified staged download with an existing lease key. Uses a pinned Linux directory, scoped Darwin helper or supervised Windows file bridge. No automatic retry.', ['lease-id', 'session-id', 'member', 'path', 'destination', 'app', 'helper-path'], ['replace']);
  if (args) { const result = await args.lease().downloadToFile(args.required('session-id'), String(args.values.member ?? 'primary'), args.required('path'), args.required('destination'), { replace: args.values.replace === true, ...(typeof args.values.app === 'string' ? { app: args.values.app } : {}), ...(typeof args.values['helper-path'] === 'string' ? { helperPath: args.values['helper-path'] } : {}) }); console.log(JSON.stringify({ sessionId: args.required('session-id'), state: 'complete', bytes: result.bytes, sha256: result.sha256 })); }
} catch (error) { failure(error); }
