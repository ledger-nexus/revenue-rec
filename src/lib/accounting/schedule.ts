// ASC 606 Step 5: recognition schedule generator.
//
// Given a performance obligation with an allocated amount and a
// recognition pattern, emit the planned per-period recognition amounts.
// The output is a list of {periodStart, periodEnd, plannedAmount} rows
// that will be persisted to RecognitionSchedule at contract approval.
//
// Patterns supported in v0.1:
//
//   POINT_IN_TIME       — single row at the PO's startDate. Amount = the
//                         full allocated amount. For one-time deliverables
//                         (implementation, perpetual license delivery).
//
//   OVER_TIME_STRAIGHT  — equal monthly amounts spanning [startDate,
//                         endDate]. Standard for subscriptions, SaaS,
//                         maintenance contracts. Penny rounding lands on
//                         the last period to keep Σ = allocated.
//
// Out of scope for v0.1:
//
//   OVER_TIME_USAGE     — recognize as the customer consumes (usage-based
//                         billing). Schedule can't be planned ahead; it's
//                         emitted as usage events arrive.
//   OVER_TIME_MILESTONE — recognize at named project milestones. The
//                         schedule needs milestone-level inputs (estimated
//                         completion %), not just date math.
//
// Both will land in v0.2 alongside the AI extractor.
//
// All math uses Decimal. Periods are monthly, identified by the calendar
// month containing the start. We compute (year, month) windows because
// fiscal periods can be 4-4-5 etc. — but we DO NOT pretend to know about
// the entity's fiscal calendar here. The downstream posting code maps
// our calendar-month boundaries to the entity's Period rows.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type RecognitionPattern =
  | "POINT_IN_TIME"
  | "OVER_TIME_STRAIGHT"
  | "OVER_TIME_USAGE"
  | "OVER_TIME_MILESTONE";

export interface ScheduleInput {
  pattern: RecognitionPattern;
  allocatedAmount: Decimal | string | number;
  startDate: Date;
  endDate?: Date;
}

export interface SchedulePeriod {
  periodStart: Date;  // first day of the calendar month
  periodEnd: Date;    // last day of the calendar month
  plannedAmount: Decimal;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

function toDecimal(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

// First day of the calendar month containing d (UTC).
function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Last day of the calendar month containing d (UTC).
function endOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function addMonthsUTC(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
}

// Inclusive count of calendar months between two dates (both already
// snapped to start-of-month). Same month = 1.
function monthsInclusive(a: Date, b: Date): number {
  const years = b.getUTCFullYear() - a.getUTCFullYear();
  const months = b.getUTCMonth() - a.getUTCMonth();
  return years * 12 + months + 1;
}

export function generateSchedule(input: ScheduleInput): SchedulePeriod[] {
  const allocated = toDecimal(input.allocatedAmount);
  if (allocated.isNegative()) {
    throw new ScheduleError(
      `allocatedAmount must be non-negative (got ${allocated.toFixed(2)})`
    );
  }

  if (input.pattern === "POINT_IN_TIME") {
    return [
      {
        periodStart: startOfMonthUTC(input.startDate),
        periodEnd: endOfMonthUTC(input.startDate),
        plannedAmount: allocated,
      },
    ];
  }

  if (input.pattern === "OVER_TIME_STRAIGHT") {
    if (!input.endDate) {
      throw new ScheduleError("OVER_TIME_STRAIGHT requires endDate");
    }
    if (input.endDate < input.startDate) {
      throw new ScheduleError("endDate must be on or after startDate");
    }

    const firstMonth = startOfMonthUTC(input.startDate);
    const lastMonth = startOfMonthUTC(input.endDate);
    const n = monthsInclusive(firstMonth, lastMonth);

    if (n <= 0) {
      throw new ScheduleError(`Calculated 0 months — check date inputs`);
    }

    // Per-period amount at full precision, rounded to 2dp. The last
    // period absorbs the rounding residual so totals tie.
    const perPeriod = allocated.dividedBy(n).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    const periods: SchedulePeriod[] = [];
    let runningTotal = new Decimal(0);

    for (let i = 0; i < n; i += 1) {
      const month = addMonthsUTC(firstMonth, i);
      const isLast = i === n - 1;
      const amount = isLast ? allocated.minus(runningTotal) : perPeriod;
      runningTotal = runningTotal.plus(amount);
      periods.push({
        periodStart: startOfMonthUTC(month),
        periodEnd: endOfMonthUTC(month),
        plannedAmount: amount,
      });
    }
    return periods;
  }

  if (input.pattern === "OVER_TIME_USAGE") {
    // USAGE recognition is event-driven, not schedule-driven. We
    // cannot plan periods up-front because recognition timing depends
    // on the customer's actual consumption (Plaid-style transaction
    // ingestion, metering events, etc.).
    //
    // Returning an empty schedule (with no thrown error) lets the
    // mapper produce USAGE-pattern POs without crashing the engine.
    // The Server Action that posts recognition reads `RecognitionEvent`
    // rows triggered by inbound usage events; the planned schedule
    // simply isn't applicable.
    //
    // To eagerly populate planned amounts, callers would supply a
    // usage forecast (out of scope for this function — pattern-
    // agnostic forecasts belong in a separate forecaster module).
    return [];
  }

  if (input.pattern === "OVER_TIME_MILESTONE") {
    // MILESTONE recognition is driven by named project completion
    // events (e.g., "design phase 50%", "go-live 100%"). The schedule
    // requires Milestone[] input — start/end dates alone aren't
    // sufficient. We accept the pattern at the function boundary so
    // mappers don't crash, but emit nothing without milestone data.
    //
    // A future Server Action will accept Milestone[] and call a
    // dedicated `generateMilestoneSchedule()` helper. The mapper's
    // start/end dates are still useful as period bounds; we just
    // don't emit anything planned without milestone input here.
    return [];
  }

  // Compile-time exhaustiveness: if a new pattern is added to the
  // union, the unhandled case becomes a TypeScript error.
  const _exhaustive: never = input.pattern;
  throw new ScheduleError(
    `Pattern ${_exhaustive as string} is not supported`
  );
}

// Convenience: how much has been planned across all periods for one PO?
// Sanity check the caller can use to verify Σ = allocated.
export function totalPlanned(periods: SchedulePeriod[]): Decimal {
  return periods.reduce((acc, p) => acc.plus(p.plannedAmount), new Decimal(0));
}
