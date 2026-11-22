import { NativeSelect } from "./ui/native-select";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import {
  RECORDING_DURATIONS,
  captureFileName,
  closeVideoSession,
  defaultCaptureName,
  readVideoSession,
  recordVideo,
  takeScreenshot,
  type Recording,
} from "@/lib/mobile-capture";
import type { Machine } from "@/lib/inventory";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Output = { url: string; name: string };
function useObjectUrl() {
  const [output, setOutput] = useState<Output>();
  useEffect(() => () => output && URL.revokeObjectURL(output.url), [output]);
  return [output, setOutput] as const;
}
const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + " MiB";

/** Screenshots and short MP4 recordings for an owned running device. */
export function MobileCapture({ machine }: { machine: Machine }) {
  const prefix = machine.template.os === "ios" ? "ios" : "android";
  const [shotName, setShotName] = useState(() =>
    defaultCaptureName(prefix + "-screenshot"),
  );
  const [clipName, setClipName] = useState(() =>
    defaultCaptureName(prefix + "-recording"),
  );
  const [duration, setDuration] = useState<number>(10);
  const [shot, setShot] = useObjectUrl();
  const [clip, setClip] = useObjectUrl();
  const [shotStatus, setShotStatus] = useState("");
  const [shotError, setShotError] = useState("");
  const [clipStatus, setClipStatus] = useState("");
  const [clipError, setClipError] = useState("");
  const [summary, setSummary] = useState<Recording>();
  const [shooting, setShooting] = useState(false);
  const [recording, setRecording] = useState(false);
  const live = useRef(true);
  // The open session is closed on cancel, failure, unmount and page unload.
  const active = useRef<{ id: string; abort: AbortController }>(undefined);
  useEffect(() => {
    live.current = true;
    const unload = () => {
      const session = active.current;
      if (!session) return;
      active.current = undefined;
      session.abort.abort();
      void closeVideoSession(machine.id, session.id, true);
    };
    window.addEventListener("pagehide", unload);
    return () => {
      live.current = false;
      window.removeEventListener("pagehide", unload);
      unload();
    };
  }, [machine.id]);

  async function screenshot() {
    if (shooting) return;
    setShotError("");
    let name: string;
    try {
      name = captureFileName(shotName, "png");
    } catch (e) {
      setShotError(errorMessage(e));
      return;
    }
    setShooting(true);
    setShotStatus("Capturing screenshot…");
    try {
      const png = await takeScreenshot(machine.id);
      if (!live.current) return;
      setShot({
        url: URL.createObjectURL(
          new Blob([png.bytes as BlobPart], { type: "image/png" }),
        ),
        name,
      });
      setShotStatus(`Screenshot ${png.width} × ${png.height} · ${name}`);
    } catch (e) {
      if (live.current) {
        setShotStatus("");
        setShotError(errorMessage(e));
      }
    } finally {
      if (live.current) setShooting(false);
    }
  }

  async function record() {
    if (recording) return;
    setClipError("");
    let name: string;
    try {
      name = captureFileName(clipName, "mp4");
    } catch (e) {
      setClipError(errorMessage(e));
      return;
    }
    setRecording(true);
    setSummary(undefined);
    setClip(undefined);
    setClipStatus("Requesting a recording session…");
    const abort = new AbortController();
    let sessionId: string | undefined, requested: string | undefined;
    try {
      const result = await recordVideo(machine.id, {
        durationSeconds: duration,
        signal: abort.signal,
        // Registered before the create request, so cancel and unmount can close it.
        onRequest(id) {
          requested = id;
          active.current = { id, abort };
        },
        onSession(session) {
          sessionId = session.id;
        },
        onProgress(state, bytes) {
          if (!live.current) return;
          setClipStatus(
            state === "attaching"
              ? "Attaching to the device stream…"
              : state === "recording"
                ? `Recording ${duration} s · ${mib(bytes)} received`
                : "Verifying the recording…",
          );
        },
      });
      active.current = undefined;
      if (!live.current) return;
      setSummary(result);
      setClip({
        url: URL.createObjectURL(
          new Blob([result.data as BlobPart], { type: "video/mp4" }),
        ),
        name,
      });
      const verified = `Recording verified · ${result.frames} frames · ${result.durationSeconds.toFixed(1)} s · ${result.width} × ${result.height} · ${mib(result.bytes)}`;
      setClipStatus(verified + " · confirming capture cleanup…");
      // The runner reports positive cleanup after it receives the acknowledgement.
      let released = false;
      try {
        for (let i = 0; i < 20 && live.current && !released; i++) {
          released =
            (await readVideoSession(machine.id, sessionId!)).state ===
            "finished";
          if (!released) await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        /* Reported below; the recording itself is already verified. */
      }
      if (live.current)
        setClipStatus(
          verified +
            (released
              ? " · capture session released"
              : " · capture cleanup is not yet confirmed; inspect session " +
                sessionId +
                " in System"),
        );
    } catch (e) {
      active.current = undefined;
      // Close by the requested ID even if unmount already tried: the create request
      // may have landed after that close.
      if (requested) {
        abort.abort();
        try {
          await closeVideoSession(machine.id, requested);
        } catch {
          /* Inspect the session in System; its reservation is held until cleanup. */
        }
      }
      if (live.current) {
        setClipStatus("");
        setClipError(
          errorMessage(e) +
            (requested ? " Session " + requested + " was closed." : ""),
        );
      }
    } finally {
      if (live.current) setRecording(false);
    }
  }

  function cancel() {
    active.current?.abort.abort();
  }

  return (
    <section className="grid gap-3 border-t pt-3" aria-label="Capture">
      <h3 className="text-sm font-medium">Capture</h3>
      <div className="grid gap-2">
        <label className="grid gap-1.5 text-[13px] font-medium">
          Screenshot name
          <Input
            value={shotName}
            maxLength={100}
            disabled={shooting}
            onChange={(e) => setShotName(e.target.value)}
          />
        </label>
        <Button disabled={shooting} onClick={screenshot}>
          Take screenshot
        </Button>
        {shotStatus && <p role="status">{shotStatus}</p>}
        {shotError && <p role="alert">{shotError}</p>}
        {shot && (
          <>
            <img
              src={shot.url}
              alt="Device screenshot"
              className="max-h-80 w-auto self-start rounded-sm border"
            />
            <a
              className="text-sm underline"
              href={shot.url}
              download={shot.name}
            >
              Download {shot.name}
            </a>
          </>
        )}
      </div>
      <div className="grid gap-2">
        <label className="grid gap-1.5 text-[13px] font-medium">
          Recording name
          <Input
            value={clipName}
            maxLength={100}
            disabled={recording}
            onChange={(e) => setClipName(e.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-[13px] font-medium">
          Recording length
          <NativeSelect
            value={duration}
            disabled={recording}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {RECORDING_DURATIONS.map((s) => (
              <option key={s} value={s}>
                {s < 60
                  ? `${s} seconds`
                  : s === 60
                    ? "1 minute"
                    : `${s / 60} minutes`}
              </option>
            ))}
          </NativeSelect>
        </label>
        <div className="flex gap-2">
          <Button disabled={recording} onClick={record}>
            Record MP4
          </Button>
          {recording && (
            <Button variant="outline" onClick={cancel}>
              Cancel recording
            </Button>
          )}
        </div>
        {clipStatus && <p role="status">{clipStatus}</p>}
        {clipError && <p role="alert">{clipError}</p>}
        {clip && summary && (
          <>
            <video
              src={clip.url}
              controls
              muted
              playsInline
              aria-label="Recording preview"
              className="max-h-80 w-auto self-start rounded-sm border"
              onError={() =>
                setClipError(
                  "This browser could not decode the verified recording.",
                )
              }
            />
            <a
              className="text-sm underline"
              href={clip.url}
              download={clip.name}
            >
              Download {clip.name}
            </a>
          </>
        )}
      </div>
    </section>
  );
}
