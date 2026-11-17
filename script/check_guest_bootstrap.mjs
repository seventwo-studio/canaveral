/** Portable provider -> launch bytes -> Swift bridge -> host proof. No App/VM runner. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'canaveral-bootstrap-check-'));
const exchange = join(scratch, 'exchange', 'storage', '11111111-1111-4111-8111-111111111111');
const env = { ...process.env, CANAVERAL_FIXTURE_ROOT: root, CANAVERAL_BOOTSTRAP_EXCHANGE: exchange, CANAVERAL_NODE: process.execPath };
function run(executable, args, cwd, extra = {}) {
  const result = spawnSync(executable, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Bootstrap portable check failed.');
}
try {
  mkdirSync(join(scratch, 'Sources'));
  mkdirSync(join(scratch, 'Tests', 'BootstrapTests'), { recursive: true });
  for (const target of ['CanaveralVMCore', 'CanaveralGuestPTYSupport', 'CanaveralMachines', 'CanaveralGuestDesktop']) {
    symlinkSync(join(root, 'VirtualMachines', 'Sources', target), join(scratch, 'Sources', target));
  }
  writeFileSync(join(scratch, 'Tests', 'BootstrapTests', 'GuestBootstrapTests.swift'), readFileSync(join(root, 'VirtualMachines/Tests/CanaveralMachineTests/GuestBootstrapTests.swift')));
  writeFileSync(join(scratch, 'Package.swift'), `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "BootstrapChecks", platforms: [.macOS("26.0")], targets: [
.target(name: "CanaveralGuestPTYSupport"),
.target(name: "CanaveralVMCore", dependencies: ["CanaveralGuestPTYSupport"]),
.target(name: "CanaveralGuestDesktop", dependencies: ["CanaveralVMCore"]),
.target(name: "CanaveralMachines", dependencies: ["CanaveralVMCore"], exclude: ["DesktopModel.swift", "DesktopsView.swift", "Views.swift"]),
.testTarget(name: "BootstrapTests", dependencies: ["CanaveralVMCore", "CanaveralMachines", "CanaveralGuestDesktop"])
])
`);
  writeFileSync(join(scratch, 'Tests', 'BootstrapTests', 'GuestTLSTests.swift'), readFileSync(join(root, 'VirtualMachines/Tests/CanaveralMachineTests/GuestTLSTests.swift')));
  const coordination = join(root, 'coordination');
  run(process.execPath, ['--test', '--test-name-pattern=real provider', 'dist/test/control/guest-bootstrap.test.js'], coordination);
  run('swift', ['test', '--package-path', scratch, '--jobs', '2'], root);
  run(process.execPath, ['--test', '--test-name-pattern=Swift bound', 'dist/test/control/guest-bootstrap.test.js'], coordination, { CANAVERAL_BOOTSTRAP_VERIFY: '1' });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
