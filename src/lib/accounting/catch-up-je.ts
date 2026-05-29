// Pure helper: build the per-PO catch-up JE lines from a frozen
// reassessment breakdown. Lives separate from the server action so
// the line-construction logic is unit-testable without DB/HTTP.
//
// Semantics:
//
//   Each PO with a non-zero catch-up amount contributes two lines.
//   Positive catch-up (more revenue should be recognized):
//     DR Deferred Revenue   amount
//     CR Revenue            amount
//   Negative catch-up (revenue must be reversed):
//     DR Revenue            amount
//     CR Deferred Revenue   amount
//
//   POs with a zero catch-up are excluded entirely — no need to clutter
//   the JE with $0 rows.
//
//   The whole entry is balanced by construction: per-PO debit/credit
//   pairs each balance, so Σ debits = Σ credits across the JE.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface CatchUpPerObligationInput {
  obligationId: string;
  sequenceNo: number;
  revenueAccountCode: string;
  deferredAccountCode: string;
  /** Signed catch-up amount: positive = additional revenue; negative = reversal. */
  catchUpAmount: Decimal | string | number;
}

export interface CatchUpJeLine {
  accountCode: string;
  debit?: Decimal;
  credit?: Decimal;
  description: string;
}

export class CatchUpBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatchUpBuildError";
  }
}

function toDecimal(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

function round2(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

export interface BuildCatchUpJeResult {
  lines: CatchUpJeLine[];
  /** Σ DR across the JE (rounded). Equals Σ CR by construction. */
  totalDebits: Decimal;
  /** Number of POs whose catch-up was non-zero and contributed lines. */
  participatingPoCount: number;
}

/**
 * Build the JE lines for a variable consideration catch-up. Per-PO
 * input contributes two lines; rounding happens per-PO (2dp). The
 * result is balanced (Σ DR = Σ CR) by construction.
 *
 * Throws CatchUpBuildError if NO PO contributed any lines (entire
 * catch-up is zero — caller should short-circuit before calling).
 */
export function buildCatchUpJe(input: {
  contractCode: string;
  reassessmentDescription: string;
  perObligation: CatchUpPerObligationInput[];
}): BuildCatchUpJeResult {
  const lines: CatchUpJeLine[] = [];
  let totalDebits = new Decimal(0);
  let participating = 0;

  for (const po of input.perObligation) {
    const amount = round2(toDecimal(po.catchUpAmount));
    if (amount.isZero()) continue;

    const abs = amount.abs();
    const isPositive = amount.isPositive();
    // Positive: recognize more revenue → DR Deferred, CR Revenue.
    // Negative: reverse revenue → DR Revenue, CR Deferred.
    const drCode = isPositive ? po.deferredAccountCode : po.revenueAccountCode;
    const crCode = isPositive ? po.revenueAccountCode : po.deferredAccountCode;
    const desc = `${input.contractCode} PO${po.sequenceNo} catch-up: ${input.reassessmentDescription}`;

    lines.push({
      accountCode: drCode,
      debit: abs,
      description: desc,
    });
    lines.push({
      accountCode: crCode,
      credit: abs,
      description: desc,
    });
    totalDebits = totalDebits.plus(abs);
    participating += 1;
  }

  if (participating === 0) {
    throw new CatchUpBuildError(
      "All per-PO catch-up amounts are zero — nothing to post"
    );
  }

  return {
    lines,
    totalDebits: round2(totalDebits),
    participatingPoCount: participating,
  };
}
