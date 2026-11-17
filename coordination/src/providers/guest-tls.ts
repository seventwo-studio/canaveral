import { spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate, createHash } from "node:crypto";
import { chmodSync, writeFileSync, readFileSync, openSync, fsyncSync, closeSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { ServiceError } from "../errors.ts";
export const PKCS12_PASSWORD = "canaveral-launch-v2";
export function launchServerName(launchId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(launchId)) throw new ServiceError("Invalid TLS launch identity.");
  return launchId + ".canaveral.invalid";
}
export interface LaunchTLS { pkcs12: string; leafDER: string; serverName: string; sha256: string }
/** Caller must durably hold tls-building before entering. No utility diagnostics escape. */
export async function buildLaunchTLS(directory: string, launchId: string, injected?: (argv: string[], output?: string) => Promise<void>): Promise<LaunchTLS> {
  const utility = "/usr/bin/openssl";
  const name = launchServerName(launchId), file = (n: string) => join(directory, n);
  const put = (n: string, bytes: string | Buffer) => { const fd = openSync(file(n), "wx", 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } };
  const run = async (args: string[], output?: string): Promise<void> => {
    if (injected) return injected([utility, ...args], output);
    const fd = output === undefined ? undefined : openSync(output, "wx", 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(utility, args, { cwd: directory, env: {}, stdio: ["ignore", fd ?? "ignore", "ignore"] });
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 30_000);
        child.on("error", () => { clearTimeout(timer); reject(new ServiceError("TLS utility completion is unconfirmed; custody remains held.")); });
        child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new ServiceError("TLS utility completion is unconfirmed; custody remains held.")); });
      });
    } finally { if (fd !== undefined) { fsyncSync(fd); closeSync(fd); } }
  };
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  put("key.pem", pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  put("passphrase", PKCS12_PASSWORD);
  put("profile.cnf", `[req]\ndistinguished_name=dn\nx509_extensions=leaf\nprompt=no\n[dn]\nCN=${name}\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${name}\n`);
  put("leaf.pem", ""); put("identity.p12", ""); put("unpacked.pem", "");
  await run(["req", "-new", "-x509", "-key", file("key.pem"), "-days", "2", "-config", file("profile.cnf"), "-out", file("leaf.pem")]);
  await run(["pkcs12", "-export", "-inkey", file("key.pem"), "-in", file("leaf.pem"), "-out", file("identity.p12"), "-passout", "file:" + file("passphrase"), "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha256"]);
  await run(["x509", "-in", file("leaf.pem"), "-text", "-noout"], file("profile.txt"));
  await run(["pkcs12", "-in", file("identity.p12"), "-clcerts", "-nokeys", "-out", file("unpacked.pem"), "-passin", "file:" + file("passphrase")]);
  const profile = readFileSync(file("profile.txt"), "utf8");
  if (!/X509v3 Basic Constraints: critical\s+CA:FALSE/.test(profile) || !/X509v3 Key Usage: critical\s+Digital Signature\s+X509v3/.test(profile)) throw new ServiceError("TLS certificate usage differs.");
  for (const n of ["leaf.pem", "identity.p12", "profile.txt", "unpacked.pem"]) {
    chmodSync(file(n), 0o600);
    const s = lstatSync(file(n)); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.size > 8192) throw new ServiceError("TLS output custody differs.");
    const fd = openSync(file(n), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const cert = new X509Certificate(readFileSync(file("leaf.pem"))), p12 = readFileSync(file("identity.p12"));
  if (!new X509Certificate(readFileSync(file("unpacked.pem"))).raw.equals(cert.raw) || cert.ca || !cert.verify(cert.publicKey) || !cert.checkPrivateKey(pair.privateKey) || cert.subjectAltName !== `DNS:${name}` || cert.checkHost(name) !== name || cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || cert.keyUsage?.join() !== "1.3.6.1.5.5.7.3.1") throw new ServiceError("TLS profile validation failed.");
  createSecureContext({ pfx: p12, passphrase: PKCS12_PASSWORD, minVersion: "TLSv1.3" });
  return { pkcs12: p12.toString("base64url"), leafDER: cert.raw.toString("base64url"), serverName: name, sha256: createHash("sha256").update(cert.raw).digest("hex") };
}
export function guestMAC(machineId: string): string {
  launchServerName(machineId);
  return "02:" + machineId.replaceAll("-", "").slice(0, 10).match(/../g)!.join(":");
}

/** Revalidate private custody before every reuse; never regenerate a sealed key. */
export function validateLaunchTLS(value: unknown, launchId: string): LaunchTLS {
  const tls = value as LaunchTLS;
  if (!tls || Object.keys(tls).sort().join() !== "leafDER,pkcs12,serverName,sha256" || tls.serverName !== launchServerName(launchId)) throw new ServiceError("TLS custody differs.");
  for (const encoded of [tls.pkcs12, tls.leafDER]) if (typeof encoded !== "string" || encoded.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw new ServiceError("TLS custody encoding differs.");
  const cert = new X509Certificate(Buffer.from(tls.leafDER, "base64url"));
  if (cert.ca || !cert.verify(cert.publicKey) || cert.subjectAltName !== `DNS:${tls.serverName}` || cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || cert.keyUsage?.join() !== "1.3.6.1.5.5.7.3.1" || createHash("sha256").update(cert.raw).digest("hex") !== tls.sha256) throw new ServiceError("TLS custody certificate differs.");
  // Read the context's local certificate without listening or connecting. Loading
  // two independently valid containers alone does not bind their certificates.
  const stream = new Socket();
  const socket = new TLSSocket(stream, { isServer: true, secureContext: createSecureContext({ pfx: Buffer.from(tls.pkcs12, "base64url"), passphrase: PKCS12_PASSWORD, minVersion: "TLSv1.3" }) });
  try {
    if (!socket.getX509Certificate()?.raw.equals(cert.raw)) throw new ServiceError("TLS custody PKCS12 leaf differs.");
  } finally { socket.destroy(); stream.destroy(); }
  return tls;
}

/** Clock validity gates boot, not custody inspection or positive owned cleanup. */
export function verifyLaunchTLSClock(tls: LaunchTLS, now = Date.now()): void {
  const cert = new X509Certificate(Buffer.from(tls.leafDER, "base64url"));
  if (!Number.isFinite(now) || !(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo))) throw new ServiceError("TLS launch certificate is not currently valid.");
}
