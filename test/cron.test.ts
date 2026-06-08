import { describe, expect, it } from "vitest";
import { getNextRuns, validateCron } from "../src/cron";

describe("validateCron", () => {
  it("accepts a standard 5-field pattern", () => {
    const r = validateCron("*/15 * * * *");
    expect(r.valid).toBe(true);
    expect(r.fieldCount).toBe(5);
    expect(r.hasSeconds).toBe(false);
    expect(r.fields?.[0]?.values).toEqual([0, 15, 30, 45]);
  });

  it("accepts a 6-field (seconds) pattern", () => {
    const r = validateCron("0 0 * * * *");
    expect(r.valid).toBe(true);
    expect(r.hasSeconds).toBe(true);
    expect(r.fieldCount).toBe(6);
  });

  it("resolves month and day names", () => {
    const r = validateCron("0 0 1 jan-mar mon");
    expect(r.valid).toBe(true);
    expect(r.fields?.[3]?.values).toEqual([1, 2, 3]); // month
    expect(r.fields?.[4]?.values).toEqual([1]); // monday
  });

  it("treats dow 7 as Sunday (0)", () => {
    const r = validateCron("0 0 * * 7");
    expect(r.fields?.[4]?.values).toEqual([0]);
  });

  it("treats ? as a wildcard", () => {
    const r = validateCron("0 0 ? * *");
    expect(r.valid).toBe(true);
    expect(r.fields?.[2]?.wildcard).toBe(true);
  });

  it("rejects the wrong number of fields", () => {
    expect(validateCron("* * *").valid).toBe(false);
    expect(validateCron("").valid).toBe(false);
  });

  it("rejects out-of-range values", () => {
    const r = validateCron("99 * * * *");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/out of range/);
  });

  it("rejects inverted ranges and zero steps", () => {
    expect(validateCron("30-10 * * * *").valid).toBe(false);
    expect(validateCron("*/0 * * * *").valid).toBe(false);
  });

  it("rejects unsupported L/W/# syntax with a clear message", () => {
    const r = validateCron("0 0 L * *");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/unsupported/);
  });

  it("warns on every-minute schedules", () => {
    expect(validateCron("* * * * *").warnings).toContain(
      "runs every minute — high frequency, double-check this is intended",
    );
  });

  it("warns when the day-of-month can never occur", () => {
    const r = validateCron("0 0 31 2 *"); // Feb 31
    expect(r.valid).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/never/);
  });
});

describe("getNextRuns", () => {
  it("computes the next runs for an hourly schedule", () => {
    const from = new Date("2026-01-01T10:30:00.000Z");
    const runs = getNextRuns("0 * * * *", { count: 3, from });
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-01-01T11:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T13:00:00.000Z",
    ]);
  });

  it("never returns `from` itself", () => {
    const from = new Date("2026-01-01T11:00:00.000Z");
    const [first] = getNextRuns("0 * * * *", { count: 1, from });
    expect(first?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("honors a specific day-of-week", () => {
    const from = new Date("2026-06-08T00:00:00.000Z"); // a Monday
    const runs = getNextRuns("0 9 * * 1", { count: 1, from }); // Mondays 09:00
    expect(runs[0]?.toISOString()).toBe("2026-06-08T09:00:00.000Z");
  });

  it("applies the OR rule when both dom and dow are restricted", () => {
    // 15th of the month OR any Monday.
    const from = new Date("2026-06-08T12:00:00.000Z"); // Monday the 8th, past 00:00
    const runs = getNextRuns("0 0 15 * 1", { count: 2, from });
    // Next Monday (the 15th, which is both) ... 15th is a Monday in June 2026.
    expect(runs[0]?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("handles 6-field seconds patterns", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const runs = getNextRuns("*/30 * * * * *", { count: 2, from });
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-01-01T00:00:30.000Z",
      "2026-01-01T00:01:00.000Z",
    ]);
  });

  it("returns nothing for impossible schedules", () => {
    const runs = getNextRuns("0 0 31 2 *", { count: 1, from: new Date("2026-01-01T00:00:00Z") });
    expect(runs).toEqual([]);
  });

  it("throws on an invalid pattern", () => {
    expect(() => getNextRuns("nonsense")).toThrow(/invalid cron/);
  });
});
