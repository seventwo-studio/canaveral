/** Production gateway with browser-supplied API fixtures; no native runner. */
import { startDashboard } from "../../coordination/src/dashboard.ts";

const service = await startDashboard({
  orchestratorUrl: "http://127.0.0.1:18765",
  listen: { host: "127.0.0.1", port: 18766 },
  ...(process.env.CANAVERAL_TEST_ASSETS ? { assetsDirectory: process.env.CANAVERAL_TEST_ASSETS } : {}),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void service.close().then(() => process.exit(0), () => process.exit(1));
});
