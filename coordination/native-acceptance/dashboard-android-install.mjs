import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startController } from "../dist/src/main.js";
import { HostRunner } from "../dist/src/host.js";
import { CliClient } from "../dist/src/account-cli.js";

import { startDashboard } from "../dist/src/dashboard.js";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { dashboardAndroidUpload } from "./dashboard-android-upload.mjs";

const archive = process.argv[2];
import { homedir } from "node:os";
import { access, readdir, stat } from "node:fs/promises";
const stock = join(homedir(), ".android/avd");
const bundle = "test.canaveral.dashboardtrial";
const root = await mkdtemp(
  join(await realpath(tmpdir()), "dashboard-android-install-"),
);
console.log("Private trial state:", root);
let controller, runner, dashboard, browser;
async function until(check, description, milliseconds = 180000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw Error("Timed out waiting for " + description);
}
try {
  const admin = randomBytes(32).toString("hex"),
    enrollment = randomBytes(32).toString("hex");
  const adminFile = join(root, "admin"),
    enrollmentFile = join(root, "enroll");
  await writeFile(adminFile, admin, { mode: 0o600 });
  await writeFile(enrollmentFile, enrollment, { mode: 0o600 });
  controller = await startController({
    statePath: join(root, "db"),
    adminTokenFile: adminFile,
    enrollmentTokenFile: enrollmentFile,
    controllerId: randomUUID(),
    listen: { host: "127.0.0.1", port: 0 },
  });
  const url = "http://127.0.0.1:" + controller.address.port;
  const image = {
    id: "acceptance-android",
    revision: "1",
    os: "android",
    arch: "arm64",
    mode: "device",
    minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
    device: {
      systemImage: "system-images;android-36;google_apis_playstore;arm64-v8a",
      profile: "pixel_8",
    },
  };
  runner = new HostRunner({
    url,
    stateDir: join(root, "runner"),
    storage: join(root, "devices"),
    name: "acceptance-android",
    provider: "android",
    androidSDK: process.env.ANDROID_HOME,
    templates: [image],
    enrollmentToken: enrollment,
    capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 32 },
  });
  await runner.start();
  const runtime = runner.runtimes.get("android");
  await runtime.check();
  const prepareOnly = process.argv[3] === "--prepare-only";
  if (!archive) {
    console.log("Preflight only. No assignment created.");
  } else {
    await readFile(archive);
    // The stock AVD registry, its pointer file, directory identity and configuration.
    const inventory = async () => [
      await readdir(stock),
      await readFile(join(stock, "Pixel_API_36.ini"), "utf8"),
      (await stat(join(stock, "Pixel_API_36.avd"))).ino,
      createHash("sha256")
        .update(await readFile(join(stock, "Pixel_API_36.avd", "config.ini")))
        .digest("hex"),
    ];
    const before = await inventory();
    const machineId = randomUUID(),
      deletionId = randomUUID(),
      name = "dashboard-android-" + machineId;
    const record = (data) =>
      writeFile(
        join(root, "trial.json"),
        JSON.stringify(
          {
            machineId,
            deletionId,
            before,
            ...data,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    await record({});
    const bootstrap = new CliClient(url, admin);
    const password = randomBytes(24).toString("hex");
    const setup = await bootstrap.request("POST", "/v1/auth/setup", {
      username: "admin",
      password,
    });
    const manager = new CliClient(url, setup.token);
    const username = "trial";
    const user = await manager.request("POST", "/v1/users", {
      id: randomUUID(),
      username,
    });
    const invite = await manager.request(
      "POST",
      "/v1/users/" + user.id + "/invite",
      {},
    );
    const session = await new CliClient(url, "").request(
      "POST",
      "/v1/auth/claim",
      { token: invite.token, password },
    );
    const owner = new CliClient(url, session.token);
    dashboard = await startDashboard({
      orchestratorUrl: url,
      listen: { host: "127.0.0.1", port: 0 },
    });
    const require = createRequire(
      new URL("../../dashboard/package.json", import.meta.url),
    );
    browser = await require("playwright").chromium.launch();
    const page = await browser.newPage();
    const home = "http://127.0.0.1:" + dashboard.address.port;
    await page.goto(home);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Account menu" }).waitFor();
    if (prepareOnly) {
      console.log("Owner dashboard login verified. No assignment created.");
    } else {
      assert.equal(
        typeof runtime.removeOwnedStorage,
        "function",
        "Android provider lacks verified removal",
      );
      await runner.checkEnvironment();
      await runner.poll();
      const path = "/v1/machines/" + machineId;
      const machine = await owner.request("POST", "/v1/machines", {
        id: machineId,
        name,
        templateId: image.id,
        resources: image.minimum,
      });
      assert.equal(machine.ownerId, user.id);
      assert.equal(machine.hostId, runner.identity.id);
      const observed = async (state) =>
        (await owner.request("GET", path)).observed === state;
      await until(() => observed("running"), "running machine");
      const assignment = runner.assignments.find(
        (item) => item.id === machineId,
      );
      const storage = runtime.storage(assignment, runner.context(assignment).image);
      const serial = await runtime.endpoint(assignment, storage);
      await runtime.owned(assignment, serial);
      console.log("Confirmed running", runtime.name(assignment), serial);
      try {
        await page.goto(home + "/#machines");
        await page.reload();
        await page.getByRole("button", { name, exact: true }).click();
        const operation = await dashboardAndroidUpload(
          page,
          archive,
          machineId,
          machine.hostId,
        );
        await runtime.owned(assignment, serial);
        await record({ serial, avd: runtime.name(assignment), operation });
        // The package is observed through T3 device_open, not by driving adb here.
        console.log("Open local device", serial, "(" + runtime.name(assignment) + ") and launch", bundle, "with the device_open command.");
        const receipt = join(root, "launch-confirmed");
        console.log("After observing the trial app, write the serial and package separated by a space to", receipt);
        await until(
          async () => {
            try { return (await readFile(receipt, "utf8")).trim() === serial + " " + bundle; }
            catch (e) { if (e.code === "ENOENT") return false; throw e; }
          },
          "device launch confirmation",
          900000,
        );
        console.log("Package observed", bundle, operation);
      } finally {
        await owner.request("POST", path + "/desired", { state: "stopped" });
        await until(() => observed("stopped"), "confirmed shutdown");
        const remove = () =>
          owner.request("POST", path + "/delete", { id: deletionId });
        await remove();
        await until(async () => {
          const proof = await remove();
          assert.equal(proof.id, deletionId);
          assert.equal(proof.machineId, machineId);
          assert.notEqual(proof.state, "blocked");
          return proof.state === "complete";
        }, "confirmed deletion");
        assert.deepEqual(await inventory(), before);
        // Every upload for this machine must be deleted with its storage released.
        const db = new DatabaseSync(join(root, "db"), { readOnly: true });
        const uploads = db.prepare("SELECT id FROM app_artifacts WHERE machine=?").all(machineId);
        assert.ok(uploads.length > 0);
        for (const { id } of uploads) {
          assert.equal((await owner.request("GET", "/v1/app-artifacts/" + id)).state, "deleted");
          assert.deepEqual({ ...db.prepare("SELECT reserved_disk AS disk,(SELECT count(*) FROM app_artifact_chunks WHERE artifact=?) AS chunks FROM app_artifacts WHERE id=?").get(id, id) }, { disk: 0, chunks: 0 });
        }
        db.close();
        console.log("Upload storage released:", uploads.map(({ id }) => id).join(" "));
        for (const file of [
          storage,
          join(
            runtime.environment().ANDROID_AVD_HOME,
            runtime.name(assignment) + ".ini",
          ),
        ]) {
          await assert.rejects(access(file), { code: "ENOENT" });
        }
      }
      console.log(
        "Deletion confirmed and neighboring simulator inventory preserved.",
      );
    }
  }
} finally {
  try {
    await browser?.close();
    await dashboard?.close();
  } finally {
    try {
      await runner?.close();
    } finally {
      await controller?.close();
    }
  }
}
