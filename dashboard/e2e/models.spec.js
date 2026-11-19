import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

const digest = "sha256:" + "c".repeat(64);
const hostId = "4be8431f-e17b-4f15-854b-e25229f34ac1";
const offer = {
  id: "fixture:latest",
  digest,
  capability: "generation",
  resources: { cpu: 2, memoryMiB: 2048, diskGiB: 1 },
  hostId,
  online: true,
  accepting: true,
};

for (const width of [320, 1440]) {
  test(`models run a prompt and show output under CSP at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const submissions = [];
    let job = null;
    let polls = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      else if (path === "machines") result = { machines: [] };
      else if (path === "hosts") result = { hosts: [] };
      else if (path === "templates") result = { templates: [] };
      else if (path === "users") result = { users: [adminUser] };
      else if (path === "models") result = { models: [offer] };
      else if (path === "jobs" && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        submissions.push(body);
        job = {
          id: body.id,
          hostId,
          model: body.model,
          definition: offer,
          desired: "running",
          state: "running",
          detail: "",
          updatedAt: 1,
          stopped: false,
          cleanup: "pending",
          reservationHeld: true,
          sequence: 1,
        };
        result = job;
      } else if (path === "jobs") result = { jobs: job ? [job] : [] };
      else if (job && path === "jobs/" + job.id) {
        polls++;
        result =
          polls < 2
            ? job
            : {
                ...job,
                state: "succeeded",
                stopped: true,
                cleanup: "complete",
                reservationHeld: false,
                result: {
                  model: job.model,
                  text: "Ground control to dashboard.",
                  usage: { inputTokens: 6, outputTokens: 5 },
                },
              };
      }
      await route.fulfill({ json: result });
    });
    await page.goto("/#models");
    await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
    await expect(page.getByLabel("Installed model")).toContainText(
      "fixture:latest",
    );
    await page.getByLabel("Prompt").fill("Report your status.");
    await page.getByRole("button", { name: "Run model" }).click();
    await expect(page.getByText("Ground control to dashboard.")).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByText("Runtime stopped · capacity released"),
    ).toBeVisible();
    expect(submissions).toEqual([
      {
        id: job.id,
        model: "fixture:latest",
        digest,
        prompt: "Report your status.",
        maxTokens: 600,
      },
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("ordinary users are returned to machines from the models route", async ({
  page,
}) => {
  const requested = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
    requested.push(path);
    let result = {};
    if (["auth/status", "auth/session"].includes(path))
      result = {
        setupRequired: false,
        user: { ...adminUser, username: "user", role: "user" },
      };
    else if (path === "machines") result = { machines: [] };
    else if (path === "hosts") result = { hosts: [] };
    else if (path === "templates") result = { templates: [] };
    await route.fulfill({ json: result });
  });
  await page.goto("/#models");
  await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Models" })).toHaveCount(0);
  expect(requested).not.toContain("models");
  expect(requested).not.toContain("jobs");
});
