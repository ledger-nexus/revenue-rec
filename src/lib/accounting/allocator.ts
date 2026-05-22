// ASC 606 Step 4: allocate the transaction price to the performance
// obligations in proportion to their standalone selling prices.
//
//   allocated_i = totalContractValue × (ssp_i / Σ ssp)
//
// When Σ SSP equals total contract value the contract is at SSP and the
// allocation is trivial (allocated_i = ssp_i). When the contract is
// discounted (Σ SSP > total), the discount is spread proportionally to
// all POs. When the contract is at a premium (Σ SSP < total), the same
// proportional math applies.
//
// Rounding: we compute each allocation at full Decimal precision then
// round to 2 decimal places. The last allocation absorbs any cumulative
// rounding residual so Σ allocations ≡ total exactly (penny-perfect).
//
// Out of scope for v0.1:
//   - Variable consideration (ASC 606-10-32-5..32-13) — handled by
//     adjusting the transaction price BEFORE calling this allocator
//   - Discount allocation to a subset of POs (ASC 606-10-32-37) — the
//     rare "discount tied to specific obligations" case. Edge case;
//     can be added when a contract requires it.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface AllocationInput {
  totalContractValue: Decimal | string | number;
  performanceObligations: Array<{
    sequenceNo: number;
    description: string;
    ssp: Decimal | string | number;
  }>;
}

export interface AllocationResult {
  sequenceNo: number;
  description: string;
  ssp: Decimal;
  allocatedAmount: Decimal;
  // Percentage of the contract this PO carries, for UI display.
  allocationPercent: Decimal;
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

function toDecimal(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

export function allocateTransactionPrice(input: AllocationInput): AllocationResult[] {
  const total = toDecimal(input.totalContractValue);
  if (total.isNegative() || total.isZero()) {
    throw new AllocationError(
      `totalContractValue must be positive (got ${total.toFixed(2)})`
    );
  }
  if (input.performanceObligations.length === 0) {
    throw new AllocationError("At least one performance obligation is required");
  }

  const poDecimals = input.performanceObligations.map((po) => ({
    sequenceNo: po.sequenceNo,
    description: po.description,
    ssp: toDecimal(po.ssp),
  }));

  for (const po of poDecimals) {
    if (po.ssp.isNegative()) {
      throw new AllocationError(
        `PO #${po.sequenceNo} (${po.description}) has negative SSP`
      );
    }
  }

  const sumSsp = poDecimals.reduce((acc, po) => acc.plus(po.ssp), new Decimal(0));
  if (sumSsp.isZero()) {
    throw new AllocationError("Sum of SSPs is zero — cannot allocate");
  }

  // Allocate each at full precision, round to 2dp. Track the rounding
  // residual and dump it on the last PO so totals tie exactly.
  const allocations: AllocationResult[] = [];
  let runningTotal = new Decimal(0);

  for (let i = 0; i < poDecimals.length; i += 1) {
    const po = poDecimals[i];
    const isLast = i === poDecimals.length - 1;
    const proportion = po.ssp.dividedBy(sumSsp);
    let allocated: Decimal;
    if (isLast) {
      allocated = total.minus(runningTotal);
    } else {
      allocated = total.times(proportion).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
      runningTotal = runningTotal.plus(allocated);
    }
    allocations.push({
      sequenceNo: po.sequenceNo,
      description: po.description,
      ssp: po.ssp,
      allocatedAmount: allocated,
      allocationPercent: proportion.times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
    });
  }

  return allocations;
}

// Convenience: was this contract at SSP (no allocation work), discounted,
// or sold at premium? Useful for the UI.
export function classifyContractEconomics(
  totalContractValue: Decimal | string | number,
  performanceObligations: Array<{ ssp: Decimal | string | number }>
): "AT_SSP" | "DISCOUNTED" | "PREMIUM" {
  const total = toDecimal(totalContractValue);
  const sumSsp = performanceObligations.reduce(
    (acc, po) => acc.plus(toDecimal(po.ssp)),
    new Decimal(0)
  );
  const diff = total.minus(sumSsp).abs();
  // Within 1 cent counts as at SSP — rounding noise.
  if (diff.lessThanOrEqualTo(new Decimal("0.01"))) return "AT_SSP";
  return total.lessThan(sumSsp) ? "DISCOUNTED" : "PREMIUM";
}
