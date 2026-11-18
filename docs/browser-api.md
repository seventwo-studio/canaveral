# Real browser API

The standalone browser worker launches actual Chromium, Firefox or WebKit processes
using Playwright. Agents can navigate, run JavaScript in a page, inspect elements,
click by locator or coordinates, drag, take PNG screenshots and manage multiple
tabs. Optional context settings emulate viewport, touch, locale and device traits;
they do not replace the browser with a simulated renderer.

The worker is exported as `canaveral-machines/browser-runtime` and
`canaveral-machines/browser-sdk`. It can run independently or under a macOS host
through the controller's optional gateway. Use a dedicated browser application
credential. Playwright drivers are passed explicitly to keep controller imports
and offline release modules independent of browser loading.

## Start the worker

Install dependencies with `npm ci --ignore-scripts` and `npm run setup`. The pinned `playwright-core` library
ships no browser binaries. Install matching binaries on a dedicated worker through
its operator's approved provisioning process, for example
`npm exec --prefix coordination -- playwright-core install chromium` in a source
checkout. Build TypeScript with `npm --prefix coordination run build` before running
the examples. Client and worker must use matching Playwright major/minor versions.
Browser installation, launch and native acceptance require operator authorization.

[The worker example](../examples/browser_runtime.ts) starts an HTTP service on
loopback port 9333 using `CANAVERAL_BROWSER_TOKEN` (at least 32 random characters)
and `CANAVERAL_BROWSER_ORIGIN` (the externally reachable HTTP origin). Run it with
`node examples/browser_runtime.ts` after provisioning the worker. In a deployed
worker, terminate HTTPS and WebSocket upgrades in front of that loopback listener
and set the origin to the public HTTPS origin. Use a reverse proxy with no caching,
credential/response logging or URL rewriting. The Playwright listener itself stays
on loopback; only the authenticated gateway is reachable externally.

Each worker serves one trusted application credential. Provision separate workers
and credentials for mutually untrusted agents. Each browser boot launches a
separate process; each SDK attachment creates an isolated context. Contexts are
not an operating-system security boundary. Run the worker in an isolated,
nonprivileged environment with a real browser sandbox, bounded CPU/memory and
operator-controlled network policy. The supplied Chromium example enables its
sandbox; it does not add `--no-sandbox`. The worker's own network access is
independent of agent-runtime forwarding. Arbitrary pages and page JavaScript must
not have access to worker credentials, metadata endpoints or internal services.

## Build the ARM64 browser VM disk

Use a disposable native ARM64 Linux runner with root access, outbound HTTPS,
loop-device partition scanning, ext4, udev and systemd-nspawn namespace support.
On Ubuntu 24.04 install `qemu-utils cloud-guest-utils gdisk fdisk e2fsprogs
util-linux mount udev systemd-container curl ca-certificates coreutils bash`.
Allow space for the downloaded base, the sparse 16 GiB raw working disk and
the final qcow2. Run from the checkout:

```sh
sudo bash tools/browser-image/build.sh browser-worker.qcow2
```

The [build recipe](../tools/browser-image/build.sh) verifies the dated Debian 13
genericcloud ARM64 disk and Node 24.11.0 archive against the repository’s
existing SHA-512 and SHA-256 pins before customization. It expands the root
partition in place on a derived raw disk, retaining GPT partition numbers, uses a dated Debian package
snapshot, installs the coordination lockfile, and installs the ARM64 archives selected by that Playwright release.
Only the build container shares runner networking. Its temporary resolver and service-start policy are removed before conversion to qcow2.
Each browser archive, the Chromium headless shell and FFmpeg are SHA-256
verified against the [browser lockfile](../tools/browser-image/browsers.lock) before extraction. The build checks the installed executable
paths and qcow2 structure before publishing the output and printing its SHA-256.
The inputs select fixed releases. Filesystem metadata can vary across builds.

Record the prepared disk digest and verify it before copying. Give each instance
its own writable disk and UEFI variable store, and record their ownership before
launch. After shutdown, confirm the owned VM has stopped before removing its
disk and firmware state. Retain the ownership record when shutdown is uncertain. Use ARM64 UEFI and a
virtio disk and network interface. Before starting services, inject these
root-owned files (mode 0600) into the guest’s `/etc/canaveral-browser/`
through private instance provisioning:

- `token` holds a unique high-entropy application key of at least 32 characters.
  Provision the same value in the controller’s worker credential file.
- `origin` holds the controller-reachable HTTPS origin, such as
  `https://browser-worker.example.internal`.
- `fullchain.pem` and `key.pem` hold the certificate chain for that hostname
  and its private key. Configure the controller to trust the issuing CA.

Restrict inbound TCP 443 to the controller at the VM network boundary and
block guest access to metadata and private services before boot. Provision
credentials offline on the private instance disk before first boot. Configure
DHCP on the guest network and private DNS so the certificate hostname resolves
to that instance from the controller. Apply ingress and egress policy on the
hypervisor or upstream network before connecting the NIC. The worker and nginx
units check for their provisioning files at boot. nginx forwards HTTP
and WebSocket upgrades to loopback. systemd loads the worker credentials,
runs the authenticated worker as browser-runtime, and starts each browser under
the separate browser UID through a private launch socket. Launcher services
are bound to the worker lifecycle and share its resource slice. Reconcile outstanding boots after a restart.

The build requires a Linux libguestfs appliance and access to the pinned
downloads. Native acceptance requires a separately authorized boot, a TLS
connection from the controller, sandboxed launches of all three engines,
WebSocket attachment and process cleanup after a worker crash.

## HTTP lifecycle

All routes reject browser Origin headers. Requests use bearer headers; secrets
are never URL parameters. Responses are noncacheable. The service never logs
request bodies, page content, screenshots or credentials.

- `POST /v1/browsers` accepts exactly `{id, engine, ttlSeconds}`. Persist the UUID
  before dispatch. Engines are `chromium`, `firefox`, `webkit`; TTL is 30–3600
  seconds, including startup time. A new boot returns 201; an identical replay
  returns 200 with the same receipt. Changed intent returns 409. Creation requires
  the worker application key.
- `GET /v1/browsers/{id}` requires the application key and returns the current
  receipt. Receipts contain `{id, engine, expiresAt, endpoint, key}`. Treat the
  endpoint and scoped key as sensitive. Never log the receipt.
- `DELETE /v1/browsers/{id}` requires the application key. It closes the dedicated
  process and is safe to repeat. A 200 confirms the adapter acknowledged cleanup;
  a 503 leaves cleanup uncertain and capacity reserved.
- `/v1/browsers/{id}/connect` upgrades to the Playwright WebSocket protocol only
  with that browser's scoped bearer key. Application keys cannot attach. The
  gateway strips that key before forwarding to the private Playwright listener.

The default capacity is four browsers; it is configurable from 1–64. The process
retains boot identities, including failures and closed identities, up to 10,000
entries. It refuses further creation rather than silently forgetting replay
history. Closed/expired/failed identities return 410 and never launch a replacement.
Failed startup conservatively holds capacity until worker shutdown/reconciliation.
New connections and receipt inspection reject expiry immediately. A one-second
sweeper starts process cleanup; cleanup latency is not a hard kill deadline.

This ledger is in memory. Process supervision must terminate all child browsers
when the worker exits or crashes. A worker restart loses replay identities and
credentials: do not replay an uncertain boot across restarts without operator
reconciliation. There is no durable cross-worker recovery or reconnect replay.
Neither SDK actions nor JavaScript are automatically replayed after uncertainty.
The application key is trusted with all browsers on that worker.

## Route a browser worker through the controller

Isolate the browser worker in a bounded VM on the Mac. Give the controller a TLS-verified network
route to that origin and a private copy of the worker's dedicated application
credential. Limit the route to the controller and preserve WebSocket upgrades.
Do not share one worker across untrusted applications.

Supply the following `browserGateway` object in the controller configuration,
or pass the object itself as a JSON file to `serve --browser-gateway-config`.
Use the UUID of the existing macOS host as the key.
If a private TCP egress proxy uses a different DNS name, add `connectHost` to
the worker entry. The controller dials that address while verifying TLS and
sending HTTP requests for the configured worker origin.

```json
{
  "origin": "https://controller.example.com",
  "workers": {
    "83d93157-1043-4700-91f8-158d38d1ba63": {
      "origin": "https://browser-worker.example.internal",
      "credentialFile": "/run/canaveral/browser-worker.token"
    }
  }
}
```

Create a `BrowserClient` with the controller origin, browser application key,
Playwright drivers and `{ hostId }` as its fourth argument. The controller routes
create, inspect, stop and attach through `/v1/hosts/{hostId}/browsers`. It admits
new launches after the Mac reports ready and accepting, and verifies the scoped
key before forwarding a browser attachment. It returns its own attachment URL
even when the worker generates a loopback URL for local clients.
After a controller restart, inspect
the browser using its original UUID and application credential to recover
attachment authorization for a still-running worker. The worker's TTL and cleanup
rules continue to apply. The worker's fixed VM budget is separate from machine
reservations, so leave it out of the host's advertised capacity.

## Agent usage and local servers

Start the development server on the agent's own runtime, bound to `127.0.0.1`.
Then connect from that same runtime:

```ts
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium, firefox, webkit, devices } from 'playwright-core';
import { BrowserClient } from 'canaveral-machines/browser-sdk';

const client = new BrowserClient(origin, applicationKey, { chromium, firefox, webkit });
const id = randomUUID(); // Save in your operation store BEFORE dispatch.
await using browser = await client.boot({
  id, engine: 'chromium', ttlSeconds: 300,
  localPorts: [3000],
  context: { viewport: { width: 1280, height: 800 } },
  // Or use a compatible device descriptor from devices.
});
const app = await browser.newTab('http://127.0.0.1:3000');
const other = await browser.newTab('https://example.com');
await browser.activateTab(app);
const dom = await browser.elements();
await browser.click('button[name="save"]');
await browser.clickAt(120, 240);
await browser.drag({ x: 20, y: 40 }, { x: 300, y: 40 });
const title = await browser.evaluate('document.title');
await writeFile('page.png', await browser.screenshot(app));
await browser.closeTab(other);
```

Forwarding uses Playwright's `exposeNetwork`, restricted to exact
`127.0.0.1:<port>` rules (up to 32 ports). It travels over the existing outbound
WebSocket connection, including WebSocket traffic used by development servers.
No public local-server URL or inbound agent listener is needed. Forwarding is
disabled by default. Use `127.0.0.1` in page URLs, including URLs emitted by the
app; `localhost`, IPv6 and other ports are not aliases for this grant. Selected
ports are reachable by every page in that connection, so grant only ports intended
for those pages. The remote browser's ordinary egress remains governed separately
by its worker network policy. See the [Playwright connection contract](https://playwright.dev/docs/api/class-browsertype#browser-type-connect).

Tabs get session-local IDs; popups are registered automatically. New tabs become
active. Closing the active tab selects another open tab. Most convenience methods
default to the active tab and accept an explicit tab ID. `tabs()` lists IDs and
URLs. JavaScript evaluation returns serializable results from the selected page.
A script can have side effects or run indefinitely; TTL bounds browser lifetime,
not individual evaluation completion. Never automatically retry a timed-out action.

`elements()` reads main-document light-DOM elements, including hidden elements,
with CSS selectors, bounded text/attributes, viewport CSS-pixel rectangles and a
visibility hint. It defaults to 2,000 elements, allows up to 10,000, and reports
truncation. Visibility is not an occlusion or clickability guarantee. Selectors and
bounds describe that observation and can become stale after DOM changes. Scroll
before clicking coordinates outside the viewport. `screenshot()` captures the
viewport by default; full-page screenshots are opt-in and may be large.

For frames, shadow DOM, semantic locators, text entry, keyboard, scroll, downloads,
uploads and additional gestures, `browser.page(tabId)` exposes the actual Playwright
`Page`; `browser.context` exposes the context. For example:

```ts
await browser.page(app).getByRole('button', { name: 'Save' }).click();
await browser.page(app).getByLabel('Email').fill('agent@example.test');
await browser.page(app).mouse.wheel(0, 500);
```

`close()` and `await using` disconnect the context and request process cleanup.
If cleanup fails, retry `client.stop(id)` with the original identity. A failed
attachment leaves the original browser reserved until explicit stop or expiry;
it never authorizes a fresh boot identity. Do not log errors containing arbitrary
page content or external driver details.

## Verification and acceptance

Portable fixtures exercise authentication, replay/conflicts, capacity, failed
startup, expiry, uncertain cleanup, the WebSocket gateway, exact forwarding rules,
context configuration, tabs, evaluation and pointer dispatch. Package checks
verify the new entrypoints without launching browsers. These checks do not prove
real rendering, browser sandbox availability, cross-network forwarding, hot reload,
frame/shadow behavior, screenshots or process supervision. Native and deployed
acceptance remain outstanding. Track delivery in [ST-601](https://linear.app/seventwo/issue/ST-601/add-browser-emulation-api-with-agent-runtime-server-forwarding).
