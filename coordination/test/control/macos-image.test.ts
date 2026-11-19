import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function repository(path: string): string {
  const source = fileURLToPath(new URL(`../../../${path}`, import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
}
const helper = "/Applications/Canaveral Assigned Guest.app/Contents/MacOS/CanaveralAssignedGuest";
const disabled = `disabled services = {\n\t"com.openssh.sshd" => disabled\n\t"com.apple.screensharing" => disabled\n}\n`;
/** A prepared guest's filesystem plus stand-ins for the macOS commands the check calls. */
function guest(t: { after(f: () => void): void }) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "macos-image-")); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "root"), bin = join(base, "bin");
  const file = (path: string, content = "", mode = 0o644) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content, { mode }); };
  file(helper, "#!/bin/sh\n", 0o755);
  file("/Library/LaunchAgents/app.canaveral.assigned-guest.plist", readFileSync(repository("tools/macos-image/app.canaveral.assigned-guest.plist"), "utf8"));
  file("/Library/Preferences/com.apple.loginwindow.plist");
  file("/private/var/db/.AppleSetupDone");
  file("/private/etc/kcpassword", "", 0o600);
  file("/Users/desktop/Library/Keychains/login.keychain-db");
  // A boot during preparation leaves the helper's empty service lock.
  file("/Users/desktop/Library/Application Support/Canaveral Guest/guest-helper.lock");
  mkdirSync(join(root, "Users/Shared"), { recursive: true });
  mkdirSync(bin);
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("codesign", `[ "\${STUB_SIGNATURE:-valid}" = valid ]`);
  stub("launchctl", `[ "$1" = print-disabled ] && [ "$2" = system ] && printf '%s' "$STUB_DISABLED"`);
  stub("fdesetup", `echo "\${STUB_FILEVAULT:-FileVault is Off.}"`);
  stub("defaults", `[ -n "\${STUB_AUTOLOGIN:-}" ] && echo "$STUB_AUTOLOGIN"`);
  stub("security", `[ "\${STUB_KEYCHAIN:-}" = present ]`);
  const run = (env: Record<string, string> = {}) => spawnSync("/bin/sh", [repository("tools/macos-image/check-image.sh")], { encoding: "utf8",
    env: { CANAVERAL_CHECK_ROOT: root, CANAVERAL_CHECK_PATH: `${bin}:/usr/bin:/bin`, STUB_DISABLED: disabled, STUB_AUTOLOGIN: "desktop", ...env } });
  return { root, file, run };
}

test("macOS image check passes a prepared guest with no shared identity", { skip: process.platform === "win32" }, t => {
  const g = guest(t), result = g.run();
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /passed for automatic login user desktop/);
});

test("macOS image check refuses shared credentials, leftover launch state and remote services", { skip: process.platform === "win32" }, t => {
  const cases: Array<[string, (g: ReturnType<typeof guest>) => Record<string, string> | void]> = [
    ["manual Canaveral Guest app is installed", g => g.file("/Applications/Canaveral Guest.app/Contents/Info.plist")],
    ["starts the manual Canaveral Guest app", g => g.file("/Users/desktop/Library/LaunchAgents/helper.plist", "<string>/Applications/Canaveral Guest.app/Contents/MacOS/CanaveralGuest</string>")],
    ["holds the manual helper credential", () => ({ STUB_KEYCHAIN: "present" })],
    ["holds helper state from an earlier launch", g => g.file("/Users/desktop/Library/Application Support/Canaveral Guest/assigned/marker")],
    ["grants key login", g => g.file("/Users/desktop/.ssh/authorized_keys", "ssh-ed25519 AAAA")],
    ["/var/root/.ssh is not empty", g => g.file("/private/var/root/.ssh/id_ed25519")],
    ["SSH host keys exist", g => g.file("/private/etc/ssh/ssh_host_ed25519_key")],
    ["com.openssh.sshd is not disabled", () => ({ STUB_DISABLED: disabled.replace('"com.openssh.sshd" => disabled', '"com.openssh.sshd" => enabled') })],
    ["com.apple.screensharing is not disabled", () => ({ STUB_DISABLED: disabled.replace('\t"com.apple.screensharing" => disabled\n', "") })],
    ["Remote Management is enabled", g => g.file("/private/etc/RemoteManagement.launchd", "enabled")],
    ["FileVault must be off", () => ({ STUB_FILEVAULT: "FileVault is On." })],
    ["FileVault must be off", () => ({ STUB_FILEVAULT: "FileVault is Off, but will be enabled after the next restart." })],
    ["Automatic login is not enabled", g => rmSync(join(g.root, "private/etc/kcpassword"))],
    ["Automatic login is not enabled", () => ({ STUB_AUTOLOGIN: "" })],
    ["Setup Assistant has not finished", g => rmSync(join(g.root, "private/var/db/.AppleSetupDone"))],
    ["signature does not verify", () => ({ STUB_SIGNATURE: "invalid" })],
    ["not installed in /Applications", g => rmSync(join(g.root, helper))],
    ["LaunchAgent is missing or starts another program", g => g.file("/Library/LaunchAgents/app.canaveral.assigned-guest.plist", "<string>/usr/bin/true</string>")],
  ];
  for (const [message, change] of cases) {
    const g = guest(t), result = g.run(change(g) ?? {});
    assert.equal(result.status, 1, message); assert.ok(result.stderr.includes(message), `${message}: ${result.stderr}`);
  }
});

test("macOS guest bundle scripts parse and the LaunchAgent starts only the assigned helper", { skip: process.platform === "win32" }, () => {
  for (const script of ["install-guest.sh", "check-image.sh"]) execFileSync("/bin/sh", ["-n", repository(`tools/macos-image/${script}`)]);
  const agent = readFileSync(repository("tools/macos-image/app.canaveral.assigned-guest.plist"), "utf8");
  assert.deepEqual([...agent.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]), ["app.canaveral.assigned-guest", helper, "Aqua", "Interactive"]);
  // Each launch's media starts the helper once; launchd must not restart it.
  assert.match(agent, /<key>KeepAlive<\/key><false\/>/);
  const install = readFileSync(repository("tools/macos-image/install-guest.sh"), "utf8");
  assert.doesNotMatch(install, /security |authorized_keys|ssh-keygen|kcpassword/);
});
