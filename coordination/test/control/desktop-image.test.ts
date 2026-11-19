import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guestRecipe } from "../../src/guest/access.ts";

function repository(path: string): string {
  const source = fileURLToPath(new URL(`../../../${path}`, import.meta.url));
  return readFileSync(existsSync(source) ? source : fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");
}
const helpers = [{ path: "/opt/canaveral/server.mjs", content: "await 0;\n", mode: "0644" }];
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyOnly";

test("desktop image preinstalls every package the desktop preparation recipe installs", () => {
  const provision = repository("tools/desktop-image/provision.sh");
  const install = provision.split("\n").find(line => line.startsWith("apt-get install -y "));
  assert.ok(install, "provision.sh has one package installation line");
  const installed = new Set(install.slice("apt-get install -y ".length).trim().split(/\s+/));
  // A package missing from the image would make every desktop's first boot
  // download it from the archive snapshot during preparation.
  for (const name of guestRecipe(key, "desktop", helpers).packages) assert.ok(installed.has(name), `image installs ${name}`);
  // The recipe's start script and readiness commands need these from the image.
  const start = guestRecipe(key, "desktop", helpers).files.find(file => file.path === "/opt/canaveral/start-desktop")!.content;
  for (const binary of ["/usr/bin/Xtigervnc", "xfce4-session", "/usr/local/bin/node"]) assert.ok(start.includes(binary));
  for (const binary of ["/usr/bin/Xtigervnc", "/usr/bin/xfce4-session", "/usr/bin/dbus-run-session", "/usr/bin/xdpyinfo"]) assert.ok(provision.includes(binary), `image checks ${binary}`);
  assert.match(provision, /tar xJf \/opt\/desktop-build\/node\.tar\.xz --strip-components=1 -C \/usr\/local/);
});

test("desktop image carries no shared identity or credential", () => {
  const provision = repository("tools/desktop-image/provision.sh"), disk = repository("tools/desktop-image/provision-disk.sh");
  assert.match(provision, /rm -f \/etc\/ssh\/ssh_host_\*/);
  assert.match(provision, /: > \/etc\/machine-id/);
  // provision-disk.sh refuses to finish if any shared identity survived.
  for (const check of ["ssh_host_", "machine-id", "/home/desktop"]) assert.ok(disk.includes(check), `build refuses ${check}`);
  assert.doesNotMatch(provision + disk, /useradd|authorized_keys|\/opt\/canaveral\/token|chpasswd/);
});

test("desktop image uses the browser image's pinned base disk and Node archive", () => {
  const desktop = repository("tools/desktop-image/build.sh"), browser = repository("tools/browser-image/build.sh");
  const pins = (text: string) => text.split("\n").filter(line => /sha(256|512)sum -c|^base=|nodejs\.org/.test(line)).map(line => line.replace(/\$tmp\/\S+/g, "FILE"));
  assert.deepEqual(pins(desktop), pins(browser));
  assert.match(repository("tools/desktop-image/provision.sh"), /snapshot\.debian\.org\/archive\/debian\/20261002T000000Z\//);
  assert.match(repository("tools/browser-image/provision.sh"), /snapshot\.debian\.org\/archive\/debian\/20261002T000000Z\//);
});
