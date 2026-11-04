import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:18766", browserName: "chromium" },
  webServer: {
    command: "python3 e2e/serve.py",
    url: "http://127.0.0.1:18766/healthz",
    reuseExistingServer: false,
  },
});
