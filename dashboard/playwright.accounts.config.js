import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "accounts-api.spec.js",
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:18768", browserName: "chromium" },
  webServer: {
    command: `${process.env.CANAVERAL_TEST_PYTHON || "python3"} e2e/serve_accounts.py`,
    url: "http://127.0.0.1:18768/healthz",
    reuseExistingServer: false,
  },
});
