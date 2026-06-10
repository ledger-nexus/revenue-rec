// Recognition schedule generator unit tests.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  generateSchedule,
  totalPlanned,
  ScheduleError,
} from "../src/lib/accounting/schedule";

describe("generateSchedule: POINT_IN_TIME", () => {
  it("emits a single period containing the startDate, with the full allocation", () => {
    const r = generateSchedule({
      pattern: "POINT_IN_TIME",
      allocatedAmount: 10_000,
      startDate: new Date("2026-03-15"),
    });
    expect(r).toHaveLength(1);
    expect(r[0].plannedAmount.toNumber()).toBe(10_000);
    expect(r[0].periodStart.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(r[0].periodEnd.toISOString().slice(0, 10)).toBe("2026-03-31");
  });
});

describe("generateSchedule: OVER_TIME_STRAIGHT", () => {
  it("12-month subscription emits 12 equal monthly periods", () => {
    const r = generateSchedule({
      pattern: "OVER_TIME_STRAIGHT",
      allocatedAmount: 60_000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
    });
    expect(r).toHaveLength(12);
    expect(r[0].plannedAmount.toNumber()).toBe(5_000);
    expect(r[11].plannedAmount.toNumber()).toBe(5_000);
    expect(totalPlanned(r).toFixed(2)).toBe("60000.00");
  });

  it("non-divisible total: rounding residual lands on the last period", () => {
    // $100 / 7 months = $14.29 per month; 7 × $14.29 = $100.03 (over).
    // Last period absorbs the residual so total ties to $100.00.
    const r = generateSchedule({
      pattern: "OVER_TIME_STRAIGHT",
      allocatedAmount: 100,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-07-31"),
    });
    expect(r).toHaveLength(7);
    for (let i = 0; i < 6; i += 1) {
      expect(r[i].plannedAmount.toFixed(2)).toBe("14.29");
    }
    expect(r[6].plannedAmount.toFixed(2)).toBe("14.26");
    expect(totalPlanned(r).toFixed(2)).toBe("100.00");
  });

  it("partial-month start: starts in the calendar month containing startDate", () => {
    // Subscription starts Jan 15 — the first period is January in full,
    // we DO NOT prorate. Proration is a v0.2+ concern (it's a judgment
    // call: does the customer get a partial month of access or not?).
    const r = generateSchedule({
      pattern: "OVER_TIME_STRAIGHT",
      allocatedAmount: 12_000,
      startDate: new Date("2026-01-15"),
      endDate: new Date("2026-12-14"),
    });
    expect(r).toHaveLength(12);
    expect(r[0].periodStart.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(r[11].periodEnd.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(totalPlanned(r).toFixed(2)).toBe("12000.00");
  });

  it("single-month subscription emits 1 row with the full amount", () => {
    const r = generateSchedule({
      pattern: "OVER_TIME_STRAIGHT",
      allocatedAmount: 5_000,
      startDate: new Date("2026-03-01"),
      endDate: new Date("2026-03-31"),
    });
    expect(r).toHaveLength(1);
    expect(r[0].plannedAmount.toNumber()).toBe(5_000);
  });

  it("rejects OVER_TIME_STRAIGHT with no endDate", () => {
    expect(() =>
      generateSchedule({
        pattern: "OVER_TIME_STRAIGHT",
        allocatedAmount: 100,
        startDate: new Date("2026-01-01"),
      })
    ).toThrow(ScheduleError);
  });

  it("rejects endDate before startDate", () => {
    expect(() =>
      generateSchedule({
        pattern: "OVER_TIME_STRAIGHT",
        allocatedAmount: 100,
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-01-01"),
      })
    ).toThrow(ScheduleError);
  });
});

describe("generateSchedule: event-driven patterns (2026-06-05 update)", () => {
  // USAGE + MILESTONE patterns are conceptually empty-schedule —
  // recognition is event-driven (usage telemetry / milestone events),
  // not forward-plannable from start+end dates alone. We accept these
  // patterns at the function boundary so the NetSuite mapper doesn't
  // crash on PO rows of these patterns; the recognition engine reads
  // RecognitionEvent rows directly for these POs.

  it("OVER_TIME_USAGE returns empty schedule (event-driven recognition)", () => {
    const result = generateSchedule({
      pattern: "OVER_TIME_USAGE",
      allocatedAmount: 100,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
    });
    expect(result).toEqual([]);
  });

  it("OVER_TIME_USAGE does NOT require endDate (no schedule generated)", () => {
    const result = generateSchedule({
      pattern: "OVER_TIME_USAGE",
      allocatedAmount: 100,
      startDate: new Date("2026-01-01"),
    });
    expect(result).toEqual([]);
  });

  it("OVER_TIME_MILESTONE returns empty schedule (event-driven recognition)", () => {
    const result = generateSchedule({
      pattern: "OVER_TIME_MILESTONE",
      allocatedAmount: 100,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
    });
    expect(result).toEqual([]);
  });

  it("OVER_TIME_MILESTONE does NOT require endDate (no schedule generated)", () => {
    const result = generateSchedule({
      pattern: "OVER_TIME_MILESTONE",
      allocatedAmount: 100,
      startDate: new Date("2026-01-01"),
    });
    expect(result).toEqual([]);
  });
});

describe("generateSchedule: validation", () => {
  it("rejects negative allocated amount", () => {
    expect(() =>
      generateSchedule({
        pattern: "POINT_IN_TIME",
        allocatedAmount: -10,
        startDate: new Date("2026-01-01"),
      })
    ).toThrow(ScheduleError);
  });

  it("zero amount produces a single zero period (no error)", () => {
    const r = generateSchedule({
      pattern: "POINT_IN_TIME",
      allocatedAmount: 0,
      startDate: new Date("2026-01-01"),
    });
    expect(r[0].plannedAmount.toNumber()).toBe(0);
  });
});
