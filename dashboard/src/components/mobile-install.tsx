import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { operationReceipt, record } from "@/lib/types";
import type { Machine } from "@/lib/inventory";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const chunkBytes = 512 * 1024;
const limit = 64 * 1024 * 1024;
export function mobileInstallEligible(m: Machine, user: string) {
  return (
    m.ownerId === user &&
    m.ready &&
    m.desired === "running" &&
    m.observed === "running" &&
    !m.powerOffRequest &&
    m.template.mode === "device" &&
    ["ios", "android"].includes(m.template.os)
  );
}
export function MobileInstall({ machine }: { machine: Machine }) {
  const android = machine.template.os === "android";
  const [file, setFile] = useState<File>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function install() {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      if (
        file.size < 1 ||
        file.size > limit ||
        !file.name.toLowerCase().endsWith(android ? ".apk" : ".tar")
      )
        throw Error(
          "Choose a nonempty " +
            (android ? "APK" : "Simulator app tar archive") +
            " of at most 64 MiB.",
        );
      setStatus("Checking file…");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const format = android ? "apk" : "ios-app-tar";
      const key = JSON.stringify([
        "mobile-install",
        machine.ownerId,
        machine.hostId,
        machine.id,
        format,
        sha256,
      ]);
      const stored = sessionStorage.getItem(key);
      const intent = stored
        ? JSON.parse(stored)
        : { artifact: crypto.randomUUID(), operation: crypto.randomUUID() };
      if (!stored) sessionStorage.setItem(key, JSON.stringify(intent));
      const { artifact, operation } = intent;
      const path = "app-artifacts/" + encodeURIComponent(artifact);
      async function releaseUpload() {
        setStatus("Installation succeeded · releasing upload storage…");
        await api(path + "/delete", {}, (value) => {
          const r = record(value);
          if (
            r.id !== artifact ||
            r.machineId !== machine.id ||
            r.state !== "deleted"
          )
            throw Error("Upload removal is unconfirmed.");
        });
        sessionStorage.removeItem(key);
        if (live.current) setStatus("Installation succeeded · " + operation);
      }
      if (intent.releasePending) {
        await releaseUpload();
        return;
      }
      function uploadReceipt(value: unknown) {
        const r = record(value);
        const offset = Number(r.received);
        if (
          r.id !== artifact ||
          r.machineId !== machine.id ||
          r.format !== format ||
          r.bytes !== file!.size ||
          r.sha256 !== sha256 ||
          r.chunkBytes !== chunkBytes ||
          offset !== r.received ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > file!.size ||
          (offset !== file!.size && offset % chunkBytes !== 0) ||
          !["ready", "uploading"].includes(String(r.state)) ||
          (r.state === "ready" && offset !== file!.size)
        )
          throw Error("Invalid upload receipt.");
        return { offset, state: r.state };
      }
      if (!live.current) return;
      let receipt = await api(
        "machines/" + machine.id + "/app-artifacts",
        { id: artifact, bytes: file.size, format, sha256 },
        uploadReceipt,
      );
      while (receipt.offset < file.size && live.current) {
        const offset = receipt.offset;
        setStatus("Uploading " + Math.floor((100 * offset) / file.size) + "%…");
        const chunk = new Uint8Array(
          await file.slice(offset, offset + chunkBytes).arrayBuffer(),
        );
        let raw = "";
        for (let i = 0; i < chunk.length; i += 8192)
          raw += String.fromCharCode(...chunk.subarray(i, i + 8192));
        if (!live.current) return;
        receipt = await api(
          path + "/chunks",
          { offset, data: btoa(raw) },
          uploadReceipt,
        );
        if (receipt.offset !== offset + chunk.length)
          throw Error("Unexpected upload offset.");
      }
      if (!live.current) return;
      if (
        receipt.state !== "ready" &&
        (await api(path + "/complete", {}, uploadReceipt)).state !== "ready"
      )
        throw Error("Artifact verification incomplete.");
      if (!live.current) return;
      function installReceipt(value: unknown) {
        const r = record(value);
        if (
          r.id !== operation ||
          r.machineId !== machine.id ||
          r.hostId !== machine.hostId
        )
          throw Error("Invalid installation receipt.");
        return operationReceipt(r);
      }
      let result = await api(
        "machines/" + machine.id + "/operations",
        { id: operation, action: "install-uploaded", arguments: { artifact } },
        installReceipt,
      );
      while (live.current) {
        setStatus("Installation " + result.state + " · " + operation);
        if (result.state !== "queued") {
          if (result.state !== "succeeded")
            throw Error(
              result.result?.detail || "Installation " + result.state,
            );
          const proof = result.result;
          if (
            proof?.installed !== true ||
            proof.artifactCleaned !== true ||
            proof.sha256 !== sha256 ||
            proof.bytes !== file.size
          )
            throw Error(
              "The runner did not confirm installation and cleanup of the selected file.",
            );
          sessionStorage.setItem(
            key,
            JSON.stringify({ artifact, operation, releasePending: true }),
          );
          await releaseUpload();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!live.current) return;
        result = await api(
          "operations/" + operation,
          undefined,
          installReceipt,
        );
      }
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="grid gap-2">
      <label>
        {android
          ? "Android APK"
          : "iOS Simulator .app in an uncompressed ustar archive"}{" "}
        (64 MiB maximum)
        <Input
          type="file"
          accept={android ? ".apk" : ".tar"}
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0]);
            setStatus("");
            setError("");
          }}
        />
      </label>
      <Button disabled={!file || busy} onClick={install}>
        Upload and install
      </Button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
