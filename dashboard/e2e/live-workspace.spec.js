import { test, expect } from "@playwright/test";

const machine = process.env.CANAVERAL_LIVE_MACHINE;
const state = process.env.CANAVERAL_LIVE_STATE;
test.describe("owned local Linux workspace", () => {
  test.skip(
    !machine || !state,
    "Set the owned machine and private browser state for live acceptance",
  );
  test.use({
    baseURL: "http://127.0.0.1:8876",
    ...(state ? { storageState: state } : {}),
  });
  test("native targets drive actual VNC mouse and keyboard input", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90000);
    async function operation(action, args = {}) {
      const response = await page.request.post(
        `/api/v1/machines/${machine}/operations`,
        {
          data: { id: crypto.randomUUID(), action, arguments: args },
          headers: { Origin: "http://127.0.0.1:8876" },
        },
      );
      expect(response.ok()).toBe(true);
      let receipt = await response.json();
      for (
        let attempt = 0;
        attempt < 120 && receipt.state === "queued";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        receipt = await (
          await page.request.get(`/api/v1/operations/${receipt.id}`)
        ).json();
      }
      expect(receipt.state, JSON.stringify(receipt.result?.detail)).toBe(
        "succeeded",
      );
      return receipt.result;
    }
    await page.goto("/#machines");
    const card = page.locator('[data-slot="card"]').filter({
      has: page.getByRole("button", {
        name: "Ubuntu desktop workspace",
        exact: true,
      }),
    });
    await card.getByRole("button", { name: "Control", exact: true }).click();
    await page
      .getByRole("button", { name: "Take control", exact: true })
      .click();
    await expect(
      page.getByText("Mouse and keyboard connected", { exact: true }),
    ).toBeVisible();
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    const tree = await operation("accessibility");
    const launcher = tree.nodes.find(
      (n) => n.name === "Terminal Emulator" && n.bounds?.width > 0,
    );
    expect(launcher).toBeTruthy();
    const box = await canvas.boundingBox();
    const dimensions = await canvas.evaluate((c) => ({
      width: c.width,
      height: c.height,
    }));
    await canvas.click({
      position: {
        x:
          ((launcher.bounds.x + launcher.bounds.width / 2) * box.width) /
          dimensions.width,
        y:
          ((launcher.bounds.y + launcher.bounds.height / 2) * box.height) /
          dimensions.height,
      },
    });
    await expect
      .poll(
        async () =>
          (await operation("accessibility")).nodes.some(
            (n) => n.role === "terminal",
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await page.keyboard.type("printf 'CANAVERAL_KEYBOARD_PROOF\\n'", {
      delay: 30,
    });
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await operation("accessibility")).nodes.some((n) =>
            (n.properties?.text || "").includes("\nCANAVERAL_KEYBOARD_PROOF\n"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", {
        name: "Ubuntu desktop workspace",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("linux-desktop-input.png"),
    });
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const inspector = page.getByRole("complementary", {
      name: "Accessibility inspector",
    });

    await expect(inspector.getByText(/linux-atspi/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("linux-accessibility.png"),
    });
    await page
      .getByRole("button", { name: "Release control", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close machine workspace", exact: true })
      .click();
  });
});

const mobile = process.env.CANAVERAL_LIVE_DEVICE;
test.describe("owned simulator shared screen", () => {
  test.skip(
    !mobile || !state,
    "Set the owned device and private browser state",
  );
  test.use({
    baseURL: "http://127.0.0.1:8876",
    ...(state ? { storageState: state } : {}),
  });
  test("simulator streams through the same canvas and control toolbar", async ({
    page,
  }) => {
    test.setTimeout(45000);
    const frames = [];
    let updates = 0;
    page.on("websocket", (socket) => {
      if (socket.url().includes(`/machines/${mobile}/desktop`)) {
        socket.on("framereceived", (event) =>
          frames.push(event.payload.length),
        );
        socket.on("framesent", (event) => {
          const data = event.payload;
          if (Buffer.isBuffer(data) && data.length === 10 && data[0] === 3)
            updates++;
        });
      }
    });
    await page.goto("/#machines");
    const card = page.locator(`[data-machine-id="${mobile}"]`);
    await card.getByRole("button", { name: "Control", exact: true }).click();
    const take = page.getByRole("button", {
      name: "Take control",
      exact: true,
    });
    await expect(take).toBeEnabled({ timeout: 30000 });
    await expect(page.locator("canvas")).toBeVisible();
    await expect
      .poll(() => frames.filter((size) => size > 1000).length, {
        timeout: 15000,
      })
      .toBeGreaterThan(3);
    await expect
      .poll(() => updates, { timeout: 15000 })
      .toBeGreaterThanOrEqual(3);
    expect(
      await page.locator("canvas").evaluate((c) => c.width > 0 && c.height > 0),
    ).toBe(true);
    await take.click();
    await expect(
      page.getByRole("button", { name: "Release control", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Release control", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close machine workspace", exact: true })
      .click();
  });
});
