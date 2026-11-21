import { expect, test } from "vitest";
import { clockReading, controllerNow, duration, instant } from "./clock";

test("durations name the two units that matter and never go negative", () => {
  expect(duration(0)).toBe("0s");
  expect(duration(12.9)).toBe("12s");
  expect(duration(250)).toBe("4m 10s");
  expect(duration(7500)).toBe("2h 05m");
  expect(duration(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h");
  expect(duration(-30)).toBe("0s");
});

test("an instant is a UTC timestamp as the controller writes it", () => {
  expect(instant("2026-11-21T09:14:03.512Z")).toBe(true);
  expect(instant("2026-11-21T09:14:03Z")).toBe(true);
  for (const value of [
    "2026-11-21",
    "2026-11-21T09:14:03+01:00",
    "soon",
    1,
    null,
  ])
    expect(instant(value)).toBe(false);
});

test("the controller clock advances by local elapsed time, not by the browser's wall clock", () => {
  const reading = clockReading(Date.parse("2026-11-21T09:00:00Z"));
  // A browser clock that is hours wrong does not move the estimate.
  const estimate = controllerNow({
    ...reading,
    received: reading.received - 5000,
  });
  expect(Math.round((estimate - reading.observed) / 1000)).toBe(5);
});
