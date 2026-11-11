import { promises as fs } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { bootstrapInstall, absoluteBootstrapPath, pathsOverlap, readBootstrapJSON, unixBootstrapPlatform } from './bootstrap.ts';
import { updateDirectory, updateObject } from './manager.ts';
import type { Target, TrustedKeys } from './protocol.ts';

export interface InstallIO { stdout?: (text: string) => void; stderr?: (text: string) => void }
export interface ServiceOptions {
  node: string; launcher: string; stableRoot: string; hostConfig: string; installation: string; state: string;
}
const FLAGS = ['bundle', 'host-config', 'installation', 'state', 'node', 'launcher', 'stable-root'] as const;
const HELP = `Usage: canaveral install --bundle DIR --host-config FILE --installation NEW_DIR --state NEW_DIR --node ABS --launcher ABS --stable-root DIR
Offline Unix private installation only. Parents must already be private and owned.
Use the existing host config with pinned updates.trustedKeys and explicit
updates.protectedPaths (credentials, host state and every provider/disk root).
Node and the complete stable launcher module tree must be supplied separately.
Returns JSON with a service definition; never installs/enables it or enrolls.
Existing or interrupted installation/state roots are refused and retained.
`;
function systemdWord(value: string): string { return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"'; }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
/** Generate only: operator review and explicit service installation remain separate. */
export function generateServiceDefinition(options: ServiceOptions, platform: string = process.platform): { filename: string; content: string } {
  unixBootstrapPlatform(platform);
  for (const path of Object.values(options)) absoluteBootstrapPath(path);
  const args = [options.node, options.launcher, '--installation', options.installation, '--host-config', options.hostConfig, '--state', options.state];
  if (platform === 'linux') return { filename: 'canaveral-runtime.service', content: `[Unit]\nDescription=Canaveral managed runtime\n\n[Service]\nType=simple\nExecStart=${args.map(systemdWord).join(' ')}\nEnvironment="NODE_OPTIONS=" "NODE_PATH="\nUMask=0077\nRestart=no\nKillMode=process\nSendSIGKILL=no\nTimeoutStopSec=infinity\n\n[Install]\nWantedBy=default.target\n` };
  return { filename: 'com.canaveral.runtime.plist', content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.canaveral.runtime</string>\n<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string></dict>\n<key>Umask</key><integer>63</integer>\n<key>RunAtLoad</key><false/>\n<key>KeepAlive</key><false/>\n<key>AbandonProcessGroup</key><true/>\n</dict></plist>\n` };
}
async function stableInputs(options: ServiceOptions): Promise<void> {
  updateDirectory(options.stableRoot, false);
  const rel = relative(options.stableRoot, options.launcher);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Launcher must be inside the separate stable module tree.');
  // The operator supplies the complete module closure. Refuse links and writable
  // shared files anywhere in that tree; bootstrap never executes it to probe it.
  const walk = async (path: string): Promise<void> => {
    absoluteBootstrapPath(path); const info = await fs.lstat(path);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Stable launcher closure must be private and owned by this user.');
    if (info.isDirectory()) { for (const name of await fs.readdir(path)) await walk(join(path, name)); }
    else if (!info.isFile() || info.nlink !== 1) throw new Error('Stable launcher closure must contain only directories and single-link regular files.');
  };
  await walk(options.stableRoot);
  const launcher = await fs.lstat(options.launcher), node = await fs.lstat(options.node);
  if (!launcher.isFile() || !node.isFile() || node.nlink !== 1 || !(node.mode & 0o100) || (node.mode & 0o022) !== 0 || (node.uid !== 0 && node.uid !== process.getuid?.())) throw new Error('Supply a regular stable launcher and protected executable Node binary.');
}
/** argv excludes `install`; import-safe, no process exit and no network calls. */
export async function installMain(argv: string[], io: InstallIO = {}): Promise<number> {
  const stdout = io.stdout ?? (text => { process.stdout.write(text); });
  const stderr = io.stderr ?? (text => { process.stderr.write(text); });
  let reserved = false;
  try {
    const { values, positionals, tokens } = parseArgs({ args: argv, strict: true, allowPositionals: true, tokens: true, options: { ...(Object.fromEntries(FLAGS.map(flag => [flag, { type: 'string' as const }])) as Record<typeof FLAGS[number], { type: 'string' }>), help: { type: 'boolean' } } });
    const seen = new Set<string>();
    for (const token of tokens) if (token.kind === 'option') { if (seen.has(token.name)) throw new Error('Duplicate install option.'); seen.add(token.name); }
    if (values.help && seen.size === 1 && !positionals.length) { stdout(HELP); return 0; }
    if (positionals.length || values.help || FLAGS.some(flag => typeof values[flag] !== 'string' || !values[flag])) throw new Error('Supply exactly the documented install flags; use --help.');
    const flag = (name: typeof FLAGS[number]): string => absoluteBootstrapPath(values[name] as string);
    if (process.platform !== 'linux' && process.platform !== 'darwin') { stderr('Unsupported bootstrap platform: Unix ownership and durability required; Windows ACL support is unproven.\n'); return 1; }
    unixBootstrapPlatform();
    const serviceOptions: ServiceOptions = { node: flag('node'), launcher: flag('launcher'), stableRoot: flag('stable-root'), hostConfig: flag('host-config'), installation: flag('installation'), state: flag('state') };
    const service = generateServiceDefinition(serviceOptions);
    await stableInputs(serviceOptions);
    const configInfo = await fs.lstat(serviceOptions.hostConfig);
    if (configInfo.uid !== process.getuid?.() || (configInfo.mode & 0o077) !== 0) throw new Error('Host config must be private and owned by this user.');
    const config = updateObject(await readBootstrapJSON(serviceOptions.hostConfig, 1024 * 1024));
    if (typeof config.url !== 'string' || !config.url) throw new Error('Supply the existing controller URL.');
    const updates = updateObject(config.updates), trust = updateObject(updates.trustedKeys);
    if (!Object.keys(trust).length || Object.entries(trust).some(([id, pem]) => !/^[A-Za-z0-9._-]{1,128}$/.test(id) || typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----'))) throw new Error('Pin public PEM keys in updates.trustedKeys.');
    if (!Array.isArray(updates.protectedPaths) || !updates.protectedPaths.length || updates.protectedPaths.some(path => typeof path !== 'string')) throw new Error('List every credential, provider and disk root in updates.protectedPaths.');
    const hostState = config.stateDir ?? config.agentStateDirectory;
    if (typeof hostState !== 'string') throw new Error('Supply existing persistent host state in host config.');
    updateDirectory(absoluteBootstrapPath(hostState), false);
    const nativeConfig = updates.nativeConfigFile;
    if (nativeConfig !== undefined && typeof nativeConfig !== 'string') throw new Error('Native config path must be absolute.');
    const protectedPaths = [...updates.protectedPaths as string[], absoluteBootstrapPath(hostState), serviceOptions.hostConfig, serviceOptions.stableRoot, serviceOptions.node, ...(typeof nativeConfig === 'string' ? [absoluteBootstrapPath(nativeConfig)] : [])];
    for (const path of protectedPaths) for (const root of [serviceOptions.installation, serviceOptions.state]) if (pathsOverlap(absoluteBootstrapPath(path), root)) throw new Error('Stable inputs and persistent state must be outside update roots.');
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    if (arch !== 'amd64' && arch !== 'arm64') throw new Error('Unsupported bootstrap architecture.');
    reserved = true;
    const result = await bootstrapInstall({ bundleDirectory: flag('bundle'), installationRoot: serviceOptions.installation, stateDirectory: serviceOptions.state, target: { os: process.platform, arch } as Target, trustedKeys: trust as TrustedKeys, protectedPaths });
    stdout(JSON.stringify({ ...result, service }) + '\n'); return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Avoid echoing input or config contents: errors may contain secrets.
    stderr(`Bootstrap installation failed${code === 'EEXIST' ? ': destination exists' : ''}. Check explicit paths, pinned trust, target and private ownership.${reserved ? ' Retain installation/state roots and identity for inspection; do not replay into or delete uncertain state.' : ''}\n`);
    return 1;
  }
}
