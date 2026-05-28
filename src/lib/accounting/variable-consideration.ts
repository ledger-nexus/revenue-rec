// ASC 606 Step 3 — variable consideration math.
//
// Pure functions. No DB, no Prisma, no I/O. Mirrors the discipline
// of allocator.ts and schedule.ts: everything load-bearing for the
// recognition engine lives in deterministic code that we can audit
// end-to-end with unit tests.
//
// The accounting model:
//
//   adjusted transaction price = totalContractValue
//     + Σ_ACTIVE_components (direction × constrainedAmount)
//
// where direction is +1 for INCREASE (bonuses, overages) and -1 for
// DECREASE (refund rights, rebates). REVERSED and RESOLVED components
// drop out of the active sum: RESOLVED amounts have already been
// realized via prior period entries, and REVERSED amounts no longer
// apply going forward.
//
// Estimation methods (ASC 606-10-32-8):
//
//   EXPECTED_VALUE — probability-weighted average across all outcomes.
//     Use when the contract has many possible outcomes or you have a
//     portfolio of similar contracts (Σ p_i × amount_i).
//   MOST_LIKELY_AMOUNT — the single most likely outcome. Use when
//     outcomes are binary or near-binary (bonus paid or not).
//
// Constraint (ASC 606-10-32-11): cap the included amount such that
// it's "probable" a significant reversal won't occur. The constraint
// is a JUDGMENT, not a formula — this module accepts an externally-
// supplied constrained amount + rationale and merely validates the
// invariant constrained ≤ unconstrained. The auditor reads the
// rationale; the math just respects the cap.
//
// Reassessment (ASC 606-10-32-14): each period, the entity revisits
// the estimate. When it changes, the cumulative catch-up is:
//
//   catch_up = Σ_PO (new_allocated_to_PO − old_allocated_to_PO) × progress_PO
//
// where progress_PO is recognizedToDate / oldAllocated for that PO.
// Negative catch-up = revenue reversal posted in the current period.
//
// Rounding: per the project rule, every dollar amount lands at 2dp
// using ROUND_HALF_EVEN (banker's rounding). Cumulative residuals
// land on the last element so totals tie.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export type VariableConsiderationMethod = "EXPECTED_VALUE" | "MOST_LIKELY_AMOUNT";
export type VariableConsiderationDirection = "INCREASE" | "DECREASE";
export type VariableConsiderationStatus = "ACTIVE" | "RESOLVED" | "REVERSED";

export interface VariableConsiderationOutcome {
  scenario: string;
  amount: Decimal | string | number;
  /** 0..100, four decimals of precision permitted. */
  probabilityPercent: Decimal | string | number;
}

export interface VariableConsiderationComponent {
  /** Caller-provided identifier; the math module doesn't generate one. */
  id?: string;
  description: string;
  method: VariableConsiderationMethod;
  direction: VariableConsiderationDirection;
  status: VariableConsiderationStatus;
  /** The constrained amount currently included in transaction price (>= 0). */
  constrainedAmount: Decimal | string | number;
  /** The unconstrained estimate (>= constrainedAmount). */
  unconstrainedAmount: Decimal | string | number;
}

export class VariableConsiderationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariableConsiderationError";
  }
}

function toDecimal(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

function round2(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

// ─────────────────────────────────────────────────────────────────────────────
// Method 1: Expected value
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectedValueResult {
  /** Probability-weighted sum, rounded to 2dp. */
  expectedAmount: Decimal;
  /** Outcomes (echoed with normalized Decimals) for UI display. */
  outcomes: Array<{
    scenario: string;
    amount: Decimal;
    probabilityPercent: Decimal;
    /** amount × probability/100, rounded to 4dp. */
    contribution: Decimal;
  }>;
}

/**
 * Probability-weighted average of all outcomes. The probabilities must
 * sum to 100 ± 0.0001 (allow tiny rounding noise from the caller).
 * Empty outcome list throws — that's clearly a config error.
 */
export function computeExpectedValue(
  outcomes: VariableConsiderationOutcome[]
): ExpectedValueResult {
  if (outcomes.length === 0) {
    throw new VariableConsiderationError(
      "computeExpectedValue: at least one outcome is required"
    );
  }

  let probabilitySum = new Decimal(0);
  for (const o of outcomes) {
    const p = toDecimal(o.probabilityPercent);
    if (p.isNegative() || p.greaterThan(100)) {
      throw new VariableConsiderationError(
        `Outcome probability ${p.toFixed(4)}% out of range [0, 100] (scenario: "${o.scenario}")`
      );
    }
    probabilitySum = probabilitySum.plus(p);
  }
  const diff = probabilitySum.minus(100).abs();
  if (diff.greaterThan(new Decimal("0.0001"))) {
    throw new VariableConsiderationError(
      `Outcome probabilities must sum to 100%, got ${probabilitySum.toFixed(4)}%`
    );
  }

  const enriched = outcomes.map((o) => {
    const amount = toDecimal(o.amount);
    const probability = toDecimal(o.probabilityPercent);
    const contribution = amount
      .times(probability)
      .dividedBy(100)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
    return {
      scenario: o.scenario,
      amount,
      probabilityPercent: probability,
      contribution,
    };
  });

  const expectedAmount = round2(
    enriched.reduce((acc, o) => acc.plus(o.contribution), new Decimal(0))
  );

  return { expectedAmount, outcomes: enriched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Method 2: Most likely amount
// ─────────────────────────────────────────────────────────────────────────────

export interface MostLikelyResult {
  /** Amount of the highest-probability outcome. */
  mostLikelyAmount: Decimal;
  /** Which outcome was selected. */
  selectedScenario: string;
  /** Its probability (for display: "60% probability"). */
  selectedProbabilityPercent: Decimal;
}

/**
 * Pick the single outcome with the highest probability. Ties resolve
 * to the FIRST in the input order — the caller controls ordering.
 *
 * NOTE: this method is best for binary-ish outcomes ("bonus paid" vs
 * "no bonus"). When outcomes are many and continuous, EXPECTED_VALUE
 * is the better fit per ASC 606-10-32-8.
 */
export function computeMostLikelyAmount(
  outcomes: VariableConsiderationOutcome[]
): MostLikelyResult {
  if (outcomes.length === 0) {
    throw new VariableConsiderationError(
      "computeMostLikelyAmount: at least one outcome is required"
    );
  }
  let best = outcomes[0];
  let bestProb = toDecimal(outcomes[0].probabilityPercent);
  for (let i = 1; i < outcomes.length; i += 1) {
    const p = toDecimal(outcomes[i].probabilityPercent);
    if (p.greaterThan(bestProb)) {
      best = outcomes[i];
      bestProb = p;
    }
  }
  return {
    mostLikelyAmount: round2(toDecimal(best.amount)),
    selectedScenario: best.scenario,
    selectedProbabilityPercent: bestProb,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constraint validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a constrained amount is within bounds. Throws if not.
 * Returns the normalized Decimals for downstream use.
 *
 * Rules:
 *   - both amounts must be non-negative
 *   - constrained <= unconstrained
 *   - rationale must be non-empty (auditor invariant)
 *
 * The constraint AMOUNT itself is a judgment call — this function does
 * NOT compute a cap. The caller (operator or AI proposal) picks the
 * cap and provides reasoning. We validate the invariants only.
 */
export function validateConstraint(input: {
  unconstrainedAmount: Decimal | string | number;
  constrainedAmount: Decimal | string | number;
  rationale: string;
}): { unconstrained: Decimal; constrained: Decimal } {
  const unconstrained = toDecimal(input.unconstrainedAmount);
  const constrained = toDecimal(input.constrainedAmount);

  if (unconstrained.isNegative()) {
    throw new VariableConsiderationError(
      `Unconstrained amount must be non-negative (got ${unconstrained.toFixed(2)})`
    );
  }
  if (constrained.isNegative()) {
    throw new VariableConsiderationError(
      `Constrained amount must be non-negative (got ${constrained.toFixed(2)})`
    );
  }
  if (constrained.greaterThan(unconstrained)) {
    throw new VariableConsiderationError(
      `Constrained amount ${constrained.toFixed(2)} cannot exceed unconstrained ${unconstrained.toFixed(2)} — the constraint reduces the estimate, never increases it`
    );
  }
  if (!input.rationale || input.rationale.trim().length === 0) {
    throw new VariableConsiderationError(
      "Constraint rationale is required — auditor needs to know why the estimate was capped"
    );
  }

  return { unconstrained: round2(unconstrained), constrained: round2(constrained) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adjusted transaction price
// ─────────────────────────────────────────────────────────────────────────────

export interface AdjustedTransactionPrice {
  baseAmount: Decimal;
  /** Sum of (INCREASE constrained) − Sum of (DECREASE constrained) across ACTIVE rows. */
  netVariableAdjustment: Decimal;
  adjustedAmount: Decimal;
  /** Per-component breakdown for UI / audit logging. */
  components: Array<{
    id?: string;
    description: string;
    direction: VariableConsiderationDirection;
    status: VariableConsiderationStatus;
    signedAdjustment: Decimal; // +constrained for INCREASE, -constrained for DECREASE, 0 for non-ACTIVE
  }>;
}

/**
 * Compute the transaction price after applying all ACTIVE variable
 * consideration components. RESOLVED and REVERSED components are
 * preserved in the per-component breakdown (with signedAdjustment=0)
 * for the audit trail but excluded from the adjusted total.
 *
 * The result feeds into allocator.allocateTransactionPrice. The
 * allocator itself is unchanged — it always allocates whatever
 * transaction price it's handed.
 *
 * Edge case: a DECREASE so large it would drive the transaction price
 * below zero throws. ASC 606 doesn't envision a negative transaction
 * price; if you really have one, that's a refund liability not
 * revenue.
 */
export function computeAdjustedTransactionPrice(input: {
  baseAmount: Decimal | string | number;
  components: VariableConsiderationComponent[];
}): AdjustedTransactionPrice {
  const base = toDecimal(input.baseAmount);
  if (base.isNegative()) {
    throw new VariableConsiderationError(
      `Base transaction price must be non-negative (got ${base.toFixed(2)})`
    );
  }

  const breakdown: AdjustedTransactionPrice["components"] = [];
  let netAdjustment = new Decimal(0);

  for (const c of input.components) {
    const constrained = toDecimal(c.constrainedAmount);
    const unconstrained = toDecimal(c.unconstrainedAmount);
    if (constrained.greaterThan(unconstrained)) {
      throw new VariableConsiderationError(
        `Component "${c.description}": constrained ${constrained.toFixed(2)} > unconstrained ${unconstrained.toFixed(2)}`
      );
    }
    let signed = new Decimal(0);
    if (c.status === "ACTIVE") {
      signed = c.direction === "INCREASE" ? constrained : constrained.negated();
      netAdjustment = netAdjustment.plus(signed);
    }
    breakdown.push({
      id: c.id,
      description: c.description,
      direction: c.direction,
      status: c.status,
      signedAdjustment: round2(signed),
    });
  }

  const adjusted = round2(base.plus(netAdjustment));
  if (adjusted.isNegative()) {
    throw new VariableConsiderationError(
      `Net variable consideration drives transaction price below zero: base ${base.toFixed(2)} + adjustment ${netAdjustment.toFixed(2)} = ${adjusted.toFixed(2)}. A refund liability — not a revenue contract — at this point.`
    );
  }

  return {
    baseAmount: round2(base),
    netVariableAdjustment: round2(netAdjustment),
    adjustedAmount: adjusted,
    components: breakdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cumulative catch-up on reassessment (ASC 606-10-32-14)
// ─────────────────────────────────────────────────────────────────────────────

export interface CatchUpPerformanceObligation {
  id: string;
  /** Old amount allocated to this PO under the prior estimate. */
  oldAllocated: Decimal | string | number;
  /** New amount allocated to this PO under the new estimate. */
  newAllocated: Decimal | string | number;
  /** Revenue recognized to date for this PO (under the old estimate). */
  recognizedToDate: Decimal | string | number;
}

export interface CatchUpResult {
  /** Total catch-up amount to post this period. Positive = additional revenue; negative = reversal. */
  totalCatchUp: Decimal;
  /** Per-PO catch-up breakdown. Sum equals totalCatchUp exactly (residual lands on last element). */
  perObligation: Array<{
    id: string;
    /** Progress 0..1; recognizedToDate / oldAllocated. 1 means fully recognized. */
    progressRatio: Decimal;
    /** (newAllocated − oldAllocated) × progressRatio, rounded to 2dp. */
    catchUp: Decimal;
    /** What the PO's recognizedToDate becomes after this catch-up posts. */
    newRecognizedToDate: Decimal;
  }>;
}

/**
 * Compute the cumulative catch-up JE amount when an estimate of
 * variable consideration changes mid-contract.
 *
 * For each PO:
 *   progress = recognizedToDate / oldAllocated  (cap to 1 — if oldAllocated is
 *              zero we treat progress as 0; the new allocation will recognize
 *              prospectively)
 *   catch_up_PO = (newAllocated − oldAllocated) × progress
 *
 * This matches the "cumulative catch-up" pattern in ASC 606-10-32-14:
 * the change in estimate is applied retrospectively to satisfied
 * portions of the PO and prospectively to remaining portions.
 *
 * The function does NOT decide whether the catch-up is recognized as
 * one JE or split per PO — that's a posting concern for the caller.
 * It returns both totals and per-PO breakdown.
 */
export function computeReassessmentCatchUp(input: {
  obligations: CatchUpPerformanceObligation[];
}): CatchUpResult {
  if (input.obligations.length === 0) {
    throw new VariableConsiderationError(
      "computeReassessmentCatchUp: at least one PO required"
    );
  }

  // Pre-compute progress + raw catch-up for each PO at full precision.
  const raw = input.obligations.map((po) => {
    const oldAlloc = toDecimal(po.oldAllocated);
    const newAlloc = toDecimal(po.newAllocated);
    const recog = toDecimal(po.recognizedToDate);

    let progress: Decimal;
    if (oldAlloc.isZero()) {
      // Brand new PO carved out by the new estimate, or PO that
      // previously had zero allocation. Either way: no historical
      // progress, so no catch-up for the historical portion.
      progress = new Decimal(0);
    } else {
      progress = recog.dividedBy(oldAlloc);
      // Cap to 1 — recognized cannot logically exceed allocated, but
      // floating point + manual JEs make it possible. Clip and surface
      // would be ideal, but ASC 606 doesn't define this case; we choose
      // conservative clipping.
      if (progress.greaterThan(1)) progress = new Decimal(1);
      if (progress.isNegative()) progress = new Decimal(0);
    }
    const rawCatchUp = newAlloc.minus(oldAlloc).times(progress);
    return { po, oldAlloc, newAlloc, recog, progress, rawCatchUp };
  });

  // Compute total at full precision so the last-element residual is
  // tiny rounding noise rather than the sum of N rounding errors.
  const rawTotal = raw.reduce((acc, r) => acc.plus(r.rawCatchUp), new Decimal(0));
  const roundedTotal = round2(rawTotal);

  // Round each per-PO catch-up to 2dp; absorb residual on the last PO.
  const perObligation: CatchUpResult["perObligation"] = [];
  let runningRounded = new Decimal(0);

  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    const isLast = i === raw.length - 1;
    let catchUp: Decimal;
    if (isLast) {
      catchUp = roundedTotal.minus(runningRounded);
    } else {
      catchUp = round2(r.rawCatchUp);
      runningRounded = runningRounded.plus(catchUp);
    }
    perObligation.push({
      id: r.po.id,
      progressRatio: r.progress.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN),
      catchUp,
      newRecognizedToDate: round2(r.recog.plus(catchUp)),
    });
  }

  return {
    totalCatchUp: roundedTotal,
    perObligation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: full reassessment flow (transaction price → allocation → catch-up)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReassessmentSnapshot {
  oldAdjusted: AdjustedTransactionPrice;
  newAdjusted: AdjustedTransactionPrice;
  catchUp: CatchUpResult;
}

/**
 * Convenience wrapper for the common reassessment path: take the base
 * contract value, the old + new component lists, and a snapshot of
 * each PO's current allocation/recognition state, and return both
 * adjusted transaction prices + the catch-up to post.
 *
 * NOTE: this assumes the SSP-based reallocation is already done by
 * the caller and reflected in `newAllocated`. The math module doesn't
 * re-run the allocator itself; doing so would couple two pure modules
 * unnecessarily. The server-action layer wires them together.
 */
export function summarizeReassessment(input: {
  baseAmount: Decimal | string | number;
  oldComponents: VariableConsiderationComponent[];
  newComponents: VariableConsiderationComponent[];
  obligations: CatchUpPerformanceObligation[];
}): ReassessmentSnapshot {
  const oldAdjusted = computeAdjustedTransactionPrice({
    baseAmount: input.baseAmount,
    components: input.oldComponents,
  });
  const newAdjusted = computeAdjustedTransactionPrice({
    baseAmount: input.baseAmount,
    components: input.newComponents,
  });
  const catchUp = computeReassessmentCatchUp({ obligations: input.obligations });
  return { oldAdjusted, newAdjusted, catchUp };
}
