import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import https from "node:https";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const origin = "https://dashboard.canaveral.test";
const builds = origin + "/api/v1/builds";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function dashboardBuilds({
  dashboard,
  restart,
  privateDir,
  cert,
  key,
  accounts,
  onLaunch,
  onCleanup,
  record,
}) {
  const { chromium } = createRequire(
    new URL("../../dashboard/package.json", import.meta.url),
  )("playwright");
  const ingress = https.createServer({ cert, key }, (req, res) =>
    dashboard.emit("request", req, res),
  );
  await new Promise((resolve, reject) =>
    ingress.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const pin = createHash("sha256")
    .update(
      new X509Certificate(cert).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  let browser;
  try {
    browser = await chromium.launch({
      args: [
        "--no-proxy-server",
        "--ignore-certificate-errors-spki-list=" + pin,
        "--host-resolver-rules=MAP dashboard.canaveral.test 127.0.0.1:" +
          ingress.address().port,
      ],
    });
    async function login(account) {
      const page = await browser.newPage();
      await page.goto(origin);
      await page.getByLabel("Username").fill(account.username);
      await page.getByLabel("Password", { exact: true }).fill(account.password);
      const logged = page.waitForResponse((r) =>
        r.url().endsWith("/api/v1/auth/login"),
      );
      await page.getByRole("button", { name: "Sign in" }).click();
      assert.equal((await logged).status(), 200);
      return page;
    }
    let owner = await login(accounts[0]),
      other = await login(accounts[1]);
    const request = (page, url, method = "GET", body) =>
      page.evaluate(
        async ({ url, method, body }) => {
          const r = await fetch(url, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return {
            status: r.status,
            bytes: Array.from(new Uint8Array(await r.arrayBuffer())),
          };
        },
        { url, method, body },
      );
    const json = (response) =>
      JSON.parse(Buffer.from(response.bytes).toString());
    const expected = Buffer.from(
      "<!doctype html><title>Native build</title><h1>49</h1>\n",
    );
    const app =
      "const n=require('./data.json').n;require('node:fs').writeFileSync('index.html','<!doctype html><title>Native build</title><h1>'+n*n+'</h1>\\n');";
    for (const [mode, script, terminal] of [
      ["success", app, "succeeded"],
      ["failure", "process.exit(17)", "failed"],
      ["cancel", "setInterval(()=>{},1000)", "stopped"],
    ]) {
      const directory = join(privateDir, "upload-" + mode);
      await mkdir(join(directory, "src", "site"), { recursive: true });
      await writeFile(join(directory, "src", "site", "build.cjs"), script);
      await writeFile(join(directory, "src", "site", "data.json"), '{"n":7}');
      await owner.goto(origin + "/#builds");
      await owner.getByLabel("Source directory").setInputFiles(directory);
      await owner
        .getByLabel("Command (one argument per line)")
        .fill("node\nsrc/site/build.cjs");
      await owner.getByLabel("Artifact path").fill("index.html");
      const submission = owner.waitForResponse(
        (r) => r.url() === builds && r.request().method() === "POST",
      );
      await owner.getByRole("button", { name: "Launch build" }).click();
      const response = await submission;
      assert.equal(response.status(), 200);
      const { id } = await response.json();
      assert.ok(id);
      const url = builds + "/" + id;
      await onLaunch({ id, mode });
      for (let i = 0; ; i++) {
        const response = await request(owner, url);
        assert.equal(response.status, 200);
        const state = json(response).state;
        if (state === terminal) {
          if (mode === "failure")
            assert.equal(json(response).result?.exitCode, 17);
          if (mode === "success")
            assert.equal(json(response).result?.exitCode, 0);
          break;
        }
        assert.ok(
          i < 150 && ["provisioning", "running", "stopping"].includes(state),
          "unexpected build state " + state,
        );
        if (mode === "cancel" && state === "running")
          assert.equal((await request(owner, url, "DELETE")).status, 200);
        await sleep(500);
      }
      await onCleanup({ id, mode });
      async function verify() {
        for (const path of [url, url + "/artifact"])
          assert.ok([403, 404].includes((await request(other, path)).status));
        assert.ok(
          [403, 404].includes((await request(other, url, "DELETE")).status),
        );
        const artifact = await request(owner, url + "/artifact");
        if (mode === "success") {
          await owner.goto(origin + "/#builds");
          const link = owner
            .getByRole("article")
            .filter({ hasText: id })
            .getByRole("link", { name: "Download verified artifact" });
          const [download] = await Promise.all([
            owner.waitForEvent("download"),
            link.click(),
          ]);
          assert.deepEqual(await readFile(await download.path()), expected);
          assert.equal(artifact.status, 200);
          assert.deepEqual(Buffer.from(artifact.bytes), expected);
          assert.equal(digest(Buffer.from(artifact.bytes)), digest(expected));
        } else assert.ok([404, 409].includes(artifact.status));
      }
      await verify();
      if (mode === "success") {
        await owner.context().close();
        await other.context().close();
        dashboard = await restart(dashboard);
        owner = await login(accounts[0]);
        other = await login(accounts[1]);
        await verify();
      }
      record(
        mode,
        mode === "success"
          ? {
              bytes: expected.length,
              sha256: digest(expected),
              restartVerified: true,
            }
          : {},
      );
    }
  } finally {
    await browser?.close();
    ingress.closeAllConnections();
    await new Promise((resolve) => ingress.close(resolve));
    dashboard.close();
  }
}
