import { useEffect, useState } from "react";

/** A UTC instant as the controller writes it. */
export const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT.*Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** A length of time in the two largest units that matter: `12s`, `4m 10s`, `2h 05m`, `3d 4h`. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
  if (total < 86400)
    return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
  return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h`;
}

/** The controller's clock at one read, and the local monotonic time that read arrived.
 * Waiting time and time remaining are computed against the clock that set the deadline, so a browser
 * whose clock is wrong does not show a wrong countdown. Between reads the estimate advances locally. */
export interface ClockReading {
  /** Controller time of the read, milliseconds since the epoch. */
  observed: number;
  /** `performance.now()` when the read arrived. */
  received: number;
}
export const clockReading = (observedMs: number): ClockReading => ({
  observed: observedMs,
  received: performance.now(),
});
export const controllerNow = (reading: ClockReading): number =>
  reading.observed + (performance.now() - reading.received);

/** Re-renders once a second while the tab is visible, for countdowns. */
export function useTick(intervalMs = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setTick((value) => value + 1);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

export const localTime = (value: string | number): string =>
  new Date(value).toLocaleString();
