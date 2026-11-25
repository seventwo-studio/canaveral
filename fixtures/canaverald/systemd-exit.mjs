import { writeFileSync } from 'node:fs';

// systemd supplies these fields to ExecStopPost for the main process.
const { SERVICE_RESULT: result, EXIT_CODE: code, EXIT_STATUS: status } = process.env;
writeFileSync(process.argv[2], JSON.stringify({ result, code, status }), { flag: 'wx', mode: 0o600 });
