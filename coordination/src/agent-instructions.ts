/** Canonical rules for coding agents that use Canaveral devices, and the onboarding that installs them.
 * One text serves `canaveral instructions`, the MCP `canaveral://instructions` resource and the
 * skill files written by `canaveral setup`. Keep it in step with docs/agent-surfaces.md. */
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError } from "./account-cli.ts";

export const INSTRUCTIONS_URI = "canaveral://instructions";
export const SKILL_NAME = "canaveral-devices";
const SKILL_DESCRIPTION = "Lease, drive and release Canaveral devices (Android emulators). Use whenever a task needs to install, launch, inspect, screenshot or test an app on a device.";

/** The rules themselves. Markdown, no secrets, no deployment-specific values. */
export const RULES = `# Canaveral devices: rules for coding agents

A Canaveral device is a leased emulator that belongs to one holder at a time. Other agents and CI
jobs wait in a queue for it. Follow these rules whenever a task needs a device.

1. **Lease before you touch a device.** Get a device only through a lease: the \`lease_device\` tool
   of the Canaveral MCP server, or \`canaveral lease hold\`. Do not run \`adb\`, \`emulator\`,
   \`xcrun simctl\` or any other local device tool against a Canaveral host, and do not reuse a
   device, serial or lease id that you found in a log, a file or another session.
2. **Hold only what the task needs.** Lease one device unless the task itself needs more. Lease it
   when you are ready to use it, not at the start of unrelated work. Ask for a TTL that fits the
   task; the application's limits bound it.
3. **Keep the lease renewed.** The MCP session and \`canaveral lease hold\` renew for you, when about
   a third of the TTL remains. If you call the HTTP API or SDK yourself, renew at that point: a
   renewal that arrives after expiry cannot revive the device. No lease outlives the application's
   maximum lifetime; when you are told a lease can no longer be renewed, finish or lease again.
4. **Always release.** Release as soon as the device work is done, and also when the task fails or
   is abandoned: \`release_device\`, or stop \`canaveral lease hold\`. In CI, release in a step that
   always runs (\`canaveral requests cancel LEASE_ID\`). A session that closes releases what it holds.
   A process that is killed cannot: its lease then blocks others until the TTL ends.
5. **Never touch a device you do not hold.** Act only through a lease granted to you in this
   session. Once a lease has ended (released, expired or failed) its device is no longer yours,
   even if something still answers. Lease again instead.
6. **Treat \`unknown\` as unknown.** An action whose outcome is \`unknown\` may or may not have
   happened. Nothing replays it for you. Look first (take a screenshot, list the apps, read the
   receipt by its operation id), then decide what to do. Do not repeat it blindly, and do not send
   the "same" action under a new id to force a retry. Sending the identical operation id and
   arguments again returns the original receipt and never runs the action twice.

## What to expect

- **Waiting.** When every device is in use the lease request queues. Waiting reports progress
  (queued, then booting) and ends at the wait deadline with nothing leased. Cancelling the wait
  withdraws the request.
- **Devices.** Only Android emulator leases run today; iOS simulator leases are refused. A leased
  emulator has no guest network: the app under test cannot reach the internet, the host or a
  backend.
- **Actions.** \`screenshot\`, \`hierarchy\`, \`accessibility\`, \`tap\`, \`swipe\`, \`text\`, \`key\`, \`apps\`,
  \`launch\`, \`terminate\`, \`uninstall\`, \`open-url\`, \`logs\` and \`shell\`, each only when the lease
  has the capability. Coordinates are device pixels. \`text\` takes single-line ASCII. \`shell\` runs
  inside the guest.
- **Builds.** Install an APK from a local file with \`install_app\` (or
  \`canaveral lease LEASE_ID install FILE\`). An install whose outcome is \`unknown\` is not repeated;
  inspect the device.
- **Credentials.** Keys live in private files named by flags or environment variables. Never print
  a key, put one on a command line or write one into a repository.

## Surfaces

| Need | MCP tool | CLI |
| --- | --- | --- |
| See what can be leased | \`list_device_templates\` | \`canaveral leases templates\` |
| Lease, wait and hold | \`lease_device\` | \`canaveral lease hold --template ID\` |
| Check a lease | \`lease_status\` | \`canaveral lease LEASE_ID\` |
| Act on the device | \`device_action\` | \`canaveral lease LEASE_ID device ACTION\` |
| Install a build | \`install_app\` | \`canaveral lease LEASE_ID install FILE\` |
| Release | \`release_device\` | \`canaveral requests cancel LEASE_ID\` |
`;

/** Sent in the MCP initialize result, where space is short. The full rules are the resource. */
export const SUMMARY = "Canaveral leases exclusive devices (Android emulators) to agents. Lease before touching a device (lease_device), hold only what the task needs, " +
  "and always release (release_device), also on failure. This session renews the leases it holds and releases them when it closes. Never act on a device you do not hold. " +
  "An action reported as unknown may or may not have happened and is never replayed: inspect the device (screenshot) before deciding. " +
  `Read ${INSTRUCTIONS_URI} for the full rules.`;

export function skillFile(): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${RULES}`;
}

export interface SetupOptions {
  agents: Array<"claude" | "codex">; scope: "user" | "project";
  /** Project root for project scope. Defaults to the working directory. */
  directory?: string; force: boolean;
  /** Only named in the printed snippet; the credential file is never read here. */
  url: string; tokenFile?: string;
}
/** Skill locations: Claude Code reads `.claude/skills`; Codex reads `.agents/skills`. These are the
 * tools' conventions at the time of writing and are not verified against an installed client.
 * `canaveral instructions --skill` prints the same file for any other location. */
export function skillPaths(options: Pick<SetupOptions, "agents" | "scope" | "directory">): string[] {
  const base = options.scope === "user" ? homedir() : resolve(options.directory ?? ".");
  return options.agents.map(agent => join(base, agent === "claude" ? ".claude" : ".agents", "skills", SKILL_NAME, "SKILL.md"));
}
async function present(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Writes the skill files and returns the text to print. An existing file is replaced only with
 * `force`, and then atomically; without it nothing at all is written when any target exists. */
export async function setupAgents(options: SetupOptions): Promise<string> {
  const paths = skillPaths(options), content = skillFile();
  if (!options.force) {
    const existing = [];
    for (const path of paths) if (await present(path)) existing.push(path);
    if (existing.length) throw new CliError(`Not replacing ${existing.join(", ")}. Pass --force to replace, or use canaveral instructions --skill.`, 409);
  }
  for (const path of paths) {
    await fs.mkdir(dirname(path), { recursive: true });
    if (options.force) {
      const temporary = join(dirname(path), `.SKILL-${randomBytes(8).toString("hex")}.tmp`);
      try { await fs.writeFile(temporary, content, { flag: "wx", mode: 0o644 }); await fs.rename(temporary, path); }
      catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    } else {
      const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
      try { await file.writeFile(content); } finally { await file.close(); }
    }
  }
  const env = { CANAVERAL_URL: options.url, CANAVERAL_TOKEN_FILE: options.tokenFile === undefined ? "/ABSOLUTE/PATH/application.key" : resolve(options.tokenFile) };
  const server = { command: "canaveral", args: ["mcp"], env };
  return [
    ...paths.map(path => `Wrote ${path}`), "",
    "Register the MCP server yourself; nothing was registered for you.",
    "CANAVERAL_TOKEN_FILE names a private (mode 0600) file that holds the application key. Keep the key out of the configuration.", "",
    "Claude Code (.mcp.json in a project, or: claude mcp add-json canaveral '<the canaveral object>'):",
    JSON.stringify({ mcpServers: { canaveral: server } }, null, 2), "",
    "Codex (~/.codex/config.toml):",
    "[mcp_servers.canaveral]", `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`,
    `env = { CANAVERAL_URL = ${JSON.stringify(env.CANAVERAL_URL)}, CANAVERAL_TOKEN_FILE = ${JSON.stringify(env.CANAVERAL_TOKEN_FILE)} }`, "",
  ].join("\n");
}
