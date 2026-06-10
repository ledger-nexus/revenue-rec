// Variable consideration math tests.
//
// Pure-function module — no DB. Same shape as allocator.test.ts /
// schedule.test.ts: cover the happy path, the rounding-residual
// invariants, and the ASC 606 boundary cases. If new variable-
// consideration logic gets added, the residual invariant test
// gets written first.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  computeExpectedValue,
  computeMostLikelyAmount,
  validateConstraint,
  computeAdjustedTransactionPrice,
  computeReassessmentCatchUp,
  summarizeReassessment,
  allocateWithVariableConsideration,
  VariableConsiderationError,
  type VariableConsiderationComponent,
  type PerformanceObligationForAllocation,
} from "../src/lib/accounting/variable-consideration";

// ─────────────────────────────────────────────────────────────────────────────
// computeExpectedValue
// ─────────────────────────────────────────────────────────────────────────────

describe("computeExpectedValue", () => {
  it("computes probability-weighted average across outcomes", () => {
    // 40% × $100k + 50% × $150k + 10% × $200k = $40k + $75k + $20k = $135k
    const r = computeExpectedValue([
      { scenario: "Low usage", amount: 100_000, probabilityPercent: 40 },
      { scenario: "Mid usage", amount: 150_000, probabilityPercent: 50 },
      { scenario: "High usage", amount: 200_000, probabilityPercent: 10 },
    ]);
    expect(r.expectedAmount.toFixed(2)).toBe("135000.00");
    expect(r.outcomes).toHaveLength(3);
    expect(r.outcomes[0].contribution.toFixed(2)).toBe("40000.00");
    expect(r.outcomes[2].contribution.toFixed(2)).toBe("20000.00");
  });

  it("accepts fractional probabilities (sum to 100 exactly)", () => {
    const r = computeExpectedValue([
      { scenario: "A", amount: 100, probabilityPercent: 33.3333 },
      { scenario: "B", amount: 200, probabilityPercent: 33.3333 },
      { scenario: "C", amount: 300, probabilityPercent: 33.3334 },
    ]);
    // Mean ≈ 200
    expect(r.expectedAmount.toFixed(2)).toBe("200.00");
  });

  it("rejects probabilities that don't sum to 100%", () => {
    expect(() =>
      computeExpectedValue([
        { scenario: "A", amount: 100, probabilityPercent: 50 },
        { scenario: "B", amount: 200, probabilityPercent: 40 },
      ])
    ).toThrow(/sum to 100%/);
  });

  it("allows tiny rounding noise in probability sums (within 0.0001)", () => {
    expect(() =>
      computeExpectedValue([
        { scenario: "A", amount: 100, probabilityPercent: 50.00005 },
        { scenario: "B", amount: 200, probabilityPercent: 49.99995 },
      ])
    ).not.toThrow();
  });

  it("rejects negative probabilities", () => {
    expect(() =>
      computeExpectedValue([
        { scenario: "A", amount: 100, probabilityPercent: -10 },
        { scenario: "B", amount: 200, probabilityPercent: 110 },
      ])
    ).toThrow(/out of range/);
  });

  it("rejects probabilities >100", () => {
    expect(() =>
      computeExpectedValue([{ scenario: "A", amount: 100, probabilityPercent: 150 }])
    ).toThrow(/out of range/);
  });

  it("throws on empty outcome list", () => {
    expect(() => computeExpectedValue([])).toThrow(/at least one outcome/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeMostLikelyAmount
// ─────────────────────────────────────────────────────────────────────────────

describe("computeMostLikelyAmount", () => {
  it("picks the highest-probability outcome", () => {
    const r = computeMostLikelyAmount([
      { scenario: "No bonus", amount: 0, probabilityPercent: 30 },
      { scenario: "Full bonus", amount: 50_000, probabilityPercent: 70 },
    ]);
    expect(r.selectedScenario).toBe("Full bonus");
    expect(r.mostLikelyAmount.toFixed(2)).toBe("50000.00");
    expect(r.selectedProbabilityPercent.toFixed(2)).toBe("70.00");
  });

  it("ties go to the first outcome in input order (caller controls ordering)", () => {
    const r = computeMostLikelyAmount([
      { scenario: "First", amount: 100, probabilityPercent: 50 },
      { scenario: "Second", amount: 200, probabilityPercent: 50 },
    ]);
    expect(r.selectedScenario).toBe("First");
  });

  it("works with a single outcome", () => {
    const r = computeMostLikelyAmount([
      { scenario: "Only", amount: 1234.56, probabilityPercent: 100 },
    ]);
    expect(r.mostLikelyAmount.toFixed(2)).toBe("1234.56");
  });

  it("throws on empty outcome list", () => {
    expect(() => computeMostLikelyAmount([])).toThrow(/at least one outcome/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateConstraint
// ─────────────────────────────────────────────────────────────────────────────

describe("validateConstraint", () => {
  it("accepts a valid constraint with rationale", () => {
    const r = validateConstraint({
      unconstrainedAmount: 100_000,
      constrainedAmount: 70_000,
      rationale: "70% based on historical achievement rate of similar contracts",
    });
    expect(r.unconstrained.toFixed(2)).toBe("100000.00");
    expect(r.constrained.toFixed(2)).toBe("70000.00");
  });

  it("accepts constrained === unconstrained (no constraint applied)", () => {
    const r = validateConstraint({
      unconstrainedAmount: 100_000,
      constrainedAmount: 100_000,
      rationale: "Highly predictable; full estimate included",
    });
    expect(r.constrained.equals(r.unconstrained)).toBe(true);
  });

  it("rejects constrained > unconstrained", () => {
    expect(() =>
      validateConstraint({
        unconstrainedAmount: 100,
        constrainedAmount: 200,
        rationale: "x",
      })
    ).toThrow(/cannot exceed unconstrained/);
  });

  it("rejects negative amounts", () => {
    expect(() =>
      validateConstraint({
        unconstrainedAmount: -100,
        constrainedAmount: 0,
        rationale: "x",
      })
    ).toThrow(/Unconstrained.*non-negative/);

    expect(() =>
      validateConstraint({
        unconstrainedAmount: 100,
        constrainedAmount: -10,
        rationale: "x",
      })
    ).toThrow(/Constrained.*non-negative/);
  });

  it("rejects empty rationale", () => {
    expect(() =>
      validateConstraint({
        unconstrainedAmount: 100,
        constrainedAmount: 50,
        rationale: "",
      })
    ).toThrow(/rationale is required/);

    expect(() =>
      validateConstraint({
        unconstrainedAmount: 100,
        constrainedAmount: 50,
        rationale: "   ",
      })
    ).toThrow(/rationale is required/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeAdjustedTransactionPrice
// ─────────────────────────────────────────────────────────────────────────────

function comp(
  description: string,
  direction: "INCREASE" | "DECREASE",
  constrained: number,
  unconstrained: number = constrained,
  status: "ACTIVE" | "RESOLVED" | "REVERSED" = "ACTIVE"
): VariableConsiderationComponent {
  return {
    description,
    direction,
    method: "MOST_LIKELY_AMOUNT",
    status,
    constrainedAmount: constrained,
    unconstrainedAmount: unconstrained,
  };
}

describe("computeAdjustedTransactionPrice", () => {
  it("no components → adjusted == base", () => {
    const r = computeAdjustedTransactionPrice({
      baseAmount: 100_000,
      components: [],
    });
    expect(r.adjustedAmount.toFixed(2)).toBe("100000.00");
    expect(r.netVariableAdjustment.toFixed(2)).toBe("0.00");
  });

  it("INCREASE adds, DECREASE subtracts", () => {
    const r = computeAdjustedTransactionPrice({
      baseAmount: 100_000,
      components: [
        comp("Performance bonus", "INCREASE", 20_000),
        comp("Refund right", "DECREASE", 5_000),
      ],
    });
    // 100k + 20k − 5k = 115k
    expect(r.adjustedAmount.toFixed(2)).toBe("115000.00");
    expect(r.netVariableAdjustment.toFixed(2)).toBe("15000.00");
  });

  it("RESOLVED and REVERSED components are excluded from the active sum but kept in the breakdown", () => {
    const r = computeAdjustedTransactionPrice({
      baseAmount: 100_000,
      components: [
        comp("Active bonus", "INCREASE", 10_000),
        comp("Already paid bonus", "INCREASE", 5_000, 5_000, "RESOLVED"),
        comp("Cancelled refund", "DECREASE", 3_000, 3_000, "REVERSED"),
      ],
    });
    // Only the ACTIVE bonus counts
    expect(r.adjustedAmount.toFixed(2)).toBe("110000.00");
    expect(r.components).toHaveLength(3);
    expect(r.components[1].signedAdjustment.toFixed(2)).toBe("0.00");
    expect(r.components[2].signedAdjustment.toFixed(2)).toBe("0.00");
  });

  it("throws when constrained > unconstrained on a component", () => {
    expect(() =>
      computeAdjustedTransactionPrice({
        baseAmount: 100_000,
        components: [comp("Bad", "INCREASE", 200, 100)],
      })
    ).toThrow(/constrained 200.*unconstrained 100/);
  });

  it("throws when net adjustment drives price below zero", () => {
    expect(() =>
      computeAdjustedTransactionPrice({
        baseAmount: 10_000,
        components: [comp("Huge refund", "DECREASE", 20_000)],
      })
    ).toThrow(/below zero/);
  });

  it("throws on negative base", () => {
    expect(() =>
      computeAdjustedTransactionPrice({
        baseAmount: -100,
        components: [],
      })
    ).toThrow(/non-negative/);
  });

  it("handles multiple active components correctly", () => {
    const r = computeAdjustedTransactionPrice({
      baseAmount: 500_000,
      components: [
        comp("Bonus A", "INCREASE", 25_000),
        comp("Bonus B", "INCREASE", 15_000),
        comp("Refund right", "DECREASE", 12_000),
        comp("Volume rebate", "DECREASE", 8_000),
      ],
    });
    // 500k + 25k + 15k − 12k − 8k = 520k
    expect(r.adjustedAmount.toFixed(2)).toBe("520000.00");
    expect(r.netVariableAdjustment.toFixed(2)).toBe("20000.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeReassessmentCatchUp
// ─────────────────────────────────────────────────────────────────────────────

describe("computeReassessmentCatchUp", () => {
  it("zero progress (nothing recognized) → no catch-up regardless of allocation change", () => {
    const r = computeReassessmentCatchUp({
      obligations: [
        { id: "po-1", oldAllocated: 100_000, newAllocated: 120_000, recognizedToDate: 0 },
        { id: "po-2", oldAllocated: 50_000, newAllocated: 60_000, recognizedToDate: 0 },
      ],
    });
    expect(r.totalCatchUp.toFixed(2)).toBe("0.00");
    expect(r.perObligation[0].catchUp.toFixed(2)).toBe("0.00");
    expect(r.perObligation[1].catchUp.toFixed(2)).toBe("0.00");
  });

  it("fully recognized PO (progress=1) → full delta posts as catch-up", () => {
    const r = computeReassessmentCatchUp({
      obligations: [
        // PO fully recognized at $100k allocation; new estimate raises
        // allocation to $120k — catch up the full $20k now.
        { id: "po-1", oldAllocated: 100_000, newAllocated: 120_000, recognizedToDate: 100_000 },
      ],
    });
    expect(r.totalCatchUp.toFixed(2)).toBe("20000.00");
    expect(r.perObligation[0].progressRatio.toFixed(2)).toBe("1.00");
  });

  it("half-recognized PO → half the delta catches up", () => {
    const r = computeReassessmentCatchUp({
      obligations: [
        { id: "po-1", oldAllocated: 100_000, newAllocated: 140_000, recognizedToDate: 50_000 },
      ],
    });
    // delta = 40k, progress = 0.5, catch-up = 20k
    expect(r.totalCatchUp.toFixed(2)).toBe("20000.00");
    expect(r.perObligation[0].catchUp.toFixed(2)).toBe("20000.00");
    expect(r.perObligation[0].newRecognizedToDate.toFixed(2)).toBe("70000.00");
  });

  it("negative catch-up (estimate revised down) reverses revenue", () => {
    const r = computeReassessmentCatchUp({
      obligations: [
        { id: "po-1", oldAllocated: 100_000, newAllocated: 80_000, recognizedToDate: 100_000 },
      ],
    });
    // delta = -20k, progress = 1, catch-up = -20k
    expect(r.totalCatchUp.toFixed(2)).toBe("-20000.00");
    expect(r.perObligation[0].catchUp.toFixed(2)).toBe("-20000.00");
  });

  it("brand-new PO (oldAllocated=0) gets no historical catch-up", () => {
    const r = computeReassessmentCatchUp({
      obligations: [
        { id: "po-new", oldAllocated: 0, newAllocated: 30_000, recognizedToDate: 0 },
      ],
    });
    expect(r.totalCatchUp.toFixed(2)).toBe("0.00");
    expect(r.perObligation[0].progressRatio.toFixed(2)).toBe("0.00");
  });

  it("clips progress > 1 to 1 (defensive — over-recognized PO)", () => {
    const r = computeReassessmentCatchUp({
      obligations: [
        // Manual JE pushed recognition above allocation. Clip to 1 to
        // avoid amplifying the over-recognition.
        { id: "po-1", oldAllocated: 100, newAllocated: 200, recognizedToDate: 150 },
      ],
    });
    expect(r.perObligation[0].progressRatio.toFixed(2)).toBe("1.00");
    expect(r.totalCatchUp.toFixed(2)).toBe("100.00");
  });

  it("per-PO catch-ups sum exactly to the total (penny-perfect)", () => {
    // Three POs with non-trivial proportions that risk rounding drift.
    const r = computeReassessmentCatchUp({
      obligations: [
        { id: "po-1", oldAllocated: "33333.33", newAllocated: "40000.01", recognizedToDate: "16666.67" },
        { id: "po-2", oldAllocated: "33333.33", newAllocated: "40000.01", recognizedToDate: "10000.00" },
        { id: "po-3", oldAllocated: "33333.34", newAllocated: "40000.01", recognizedToDate: "5555.55" },
      ],
    });
    const sum = r.perObligation.reduce((acc, p) => acc.plus(p.catchUp), new Decimal(0));
    expect(sum.toFixed(2)).toBe(r.totalCatchUp.toFixed(2));
  });

  it("throws on empty obligation list", () => {
    expect(() => computeReassessmentCatchUp({ obligations: [] })).toThrow(/at least one PO/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summarizeReassessment (the convenience wrapper)
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeReassessment", () => {
  it("end-to-end: estimate raised → larger transaction price → positive catch-up on partially-recognized contract", () => {
    const r = summarizeReassessment({
      baseAmount: 100_000,
      oldComponents: [comp("Bonus", "INCREASE", 20_000)], // adjusted = 120k
      newComponents: [comp("Bonus", "INCREASE", 30_000)], // adjusted = 130k
      obligations: [
        // Single PO carrying the whole contract; 50% recognized at old allocation
        { id: "po-1", oldAllocated: 120_000, newAllocated: 130_000, recognizedToDate: 60_000 },
      ],
    });

    expect(r.oldAdjusted.adjustedAmount.toFixed(2)).toBe("120000.00");
    expect(r.newAdjusted.adjustedAmount.toFixed(2)).toBe("130000.00");
    // delta = 10k, progress = 0.5 → catch-up = 5k
    expect(r.catchUp.totalCatchUp.toFixed(2)).toBe("5000.00");
  });

  it("end-to-end: refund estimate revised UP → smaller transaction price → reversal posts", () => {
    const r = summarizeReassessment({
      baseAmount: 100_000,
      oldComponents: [comp("Refund right", "DECREASE", 5_000)],  // 95k
      newComponents: [comp("Refund right", "DECREASE", 15_000)], // 85k
      obligations: [
        // PO fully recognized — full delta catches up as a reversal.
        { id: "po-1", oldAllocated: 95_000, newAllocated: 85_000, recognizedToDate: 95_000 },
      ],
    });
    expect(r.catchUp.totalCatchUp.toFixed(2)).toBe("-10000.00");
  });

  it("end-to-end: component RESOLVED in new list → its adjustment drops out of active price", () => {
    const r = summarizeReassessment({
      baseAmount: 100_000,
      oldComponents: [comp("Bonus", "INCREASE", 20_000)],
      newComponents: [comp("Bonus", "INCREASE", 20_000, 20_000, "RESOLVED")],
      obligations: [
        { id: "po-1", oldAllocated: 120_000, newAllocated: 100_000, recognizedToDate: 60_000 },
      ],
    });
    expect(r.oldAdjusted.adjustedAmount.toFixed(2)).toBe("120000.00");
    expect(r.newAdjusted.adjustedAmount.toFixed(2)).toBe("100000.00");
    // delta = -20k, progress = 0.5 → catch-up = -10k
    expect(r.catchUp.totalCatchUp.toFixed(2)).toBe("-10000.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// allocateWithVariableConsideration (ASC 606-10-32-39 per-PO targeting)
// ─────────────────────────────────────────────────────────────────────────────

function po(
  over: Partial<PerformanceObligationForAllocation> = {}
): PerformanceObligationForAllocation {
  return {
    id: over.id ?? "po-1",
    sequenceNo: over.sequenceNo ?? 1,
    description: over.description ?? "Test PO",
    ssp: over.ssp ?? 1000,
  };
}

describe("allocateWithVariableConsideration — no VC components", () => {
  it("falls back to plain SSP allocation when there are no VC components", () => {
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 60_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
      ],
      components: [],
    });
    expect(r.contractWidePrice.toFixed(2)).toBe("100000.00");
    expect(r.totalAdjustedPrice.toFixed(2)).toBe("100000.00");
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("60000.00");
    expect(r.perObligation[1].allocated.toFixed(2)).toBe("40000.00");
  });
});

describe("allocateWithVariableConsideration — contract-wide VC only", () => {
  it("distributes contract-wide adjustment by SSP", () => {
    // Base $100k + $20k bonus → $120k allocated 60/40.
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 60_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
      ],
      components: [
        comp("Bonus", "INCREASE", 20_000),
      ],
    });
    expect(r.contractWidePrice.toFixed(2)).toBe("120000.00");
    expect(r.totalAdjustedPrice.toFixed(2)).toBe("120000.00");
    // 60% × 120k = 72k, 40% × 120k = 48k
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("72000.00");
    expect(r.perObligation[1].allocated.toFixed(2)).toBe("48000.00");
    // Targeted is zero for both
    expect(r.perObligation[0].targetedAdjustment.toFixed(2)).toBe("0.00");
  });
});

describe("allocateWithVariableConsideration — per-PO targeted VC", () => {
  it("lands a per-PO targeted bonus entirely on the targeted PO", () => {
    // ASC 606-10-32-39: bonus tied to PO-2 (implementation) shouldn't
    // distribute to PO-1 (subscription).
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 60_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
      ],
      components: [
        {
          ...comp("On-time delivery bonus", "INCREASE", 5_000),
          targetObligationId: "po-2",
        },
      ],
    });
    // Contract-wide stream: base 100k, no contract-wide adjustments
    expect(r.contractWidePrice.toFixed(2)).toBe("100000.00");
    // PO-1: 60k (unchanged); PO-2: 40k + 5k targeted = 45k
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("60000.00");
    expect(r.perObligation[0].targetedAdjustment.toFixed(2)).toBe("0.00");
    expect(r.perObligation[1].allocated.toFixed(2)).toBe("45000.00");
    expect(r.perObligation[1].targetedAdjustment.toFixed(2)).toBe("5000.00");
    // Total = 105k
    expect(r.totalAdjustedPrice.toFixed(2)).toBe("105000.00");
  });

  it("lands a per-PO targeted refund as a negative on the targeted PO", () => {
    // Refund right on PO-2 (implementation services). 30-day money-back
    // window, estimate $3k of returns. constrained = 1.5k.
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 60_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
      ],
      components: [
        {
          ...comp("Implementation refund right", "DECREASE", 1_500),
          targetObligationId: "po-2",
        },
      ],
    });
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("60000.00");
    expect(r.perObligation[1].allocated.toFixed(2)).toBe("38500.00");
    expect(r.perObligation[1].targetedAdjustment.toFixed(2)).toBe("-1500.00");
    expect(r.totalAdjustedPrice.toFixed(2)).toBe("98500.00");
  });

  it("sums multiple targeted components to the same PO", () => {
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [po({ id: "po-1", sequenceNo: 1, ssp: 100_000 })],
      components: [
        { ...comp("Bonus A", "INCREASE", 2_000), targetObligationId: "po-1" },
        { ...comp("Bonus B", "INCREASE", 3_000), targetObligationId: "po-1" },
        { ...comp("Refund", "DECREASE", 1_000), targetObligationId: "po-1" },
      ],
    });
    // Net targeted = +2k +3k -1k = +4k
    expect(r.perObligation[0].targetedAdjustment.toFixed(2)).toBe("4000.00");
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("104000.00");
  });
});

describe("allocateWithVariableConsideration — mixed contract-wide + per-PO", () => {
  it("layers per-PO targeting on top of contract-wide distribution", () => {
    // Base 100k + 10k contract-wide bonus → 110k allocated 60/40.
    // Plus 5k targeted to PO-2.
    // Expected: PO-1 = 66k (60% × 110k), PO-2 = 44k + 5k = 49k.
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 60_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
      ],
      components: [
        comp("Contract-wide bonus", "INCREASE", 10_000),
        {
          ...comp("PO-2 delivery bonus", "INCREASE", 5_000),
          targetObligationId: "po-2",
        },
      ],
    });
    expect(r.contractWidePrice.toFixed(2)).toBe("110000.00");
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("66000.00");
    expect(r.perObligation[0].targetedAdjustment.toFixed(2)).toBe("0.00");
    expect(r.perObligation[1].allocated.toFixed(2)).toBe("49000.00");
    expect(r.perObligation[1].targetedAdjustment.toFixed(2)).toBe("5000.00");
    expect(r.totalAdjustedPrice.toFixed(2)).toBe("115000.00");
  });

  it("Σ allocated equals base + Σ all signed adjustments exactly", () => {
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 30_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
        po({ id: "po-3", sequenceNo: 3, ssp: 30_000 }),
      ],
      components: [
        comp("Contract bonus", "INCREASE", 7_000),
        { ...comp("PO-1 refund", "DECREASE", 500), targetObligationId: "po-1" },
        { ...comp("PO-2 bonus", "INCREASE", 2_500), targetObligationId: "po-2" },
      ],
    });
    // Net signed = +7k -500 +2.5k = +9k
    expect(r.totalAdjustedPrice.toFixed(2)).toBe("109000.00");
    const sum = r.perObligation.reduce(
      (acc, p) => acc.plus(p.allocated),
      new Decimal(0)
    );
    expect(sum.toFixed(2)).toBe("109000.00");
  });
});

describe("allocateWithVariableConsideration — rejection cases", () => {
  it("rejects a target obligationId not in the contract", () => {
    expect(() =>
      allocateWithVariableConsideration({
        baseAmount: 100_000,
        pos: [po({ id: "po-1", sequenceNo: 1, ssp: 100_000 })],
        components: [
          {
            ...comp("Targets nonexistent", "INCREASE", 5_000),
            targetObligationId: "po-MISSING",
          },
        ],
      })
    ).toThrow(/targets obligationId=po-MISSING/);
  });

  it("rejects when a PO's net allocation would go negative", () => {
    // PO-1 gets 60% of 100k = 60k contract-wide. Targeted refund of
    // 65k drives PO-1's net to -5k — unsupported.
    expect(() =>
      allocateWithVariableConsideration({
        baseAmount: 100_000,
        pos: [
          po({ id: "po-1", sequenceNo: 1, ssp: 60_000 }),
          po({ id: "po-2", sequenceNo: 2, ssp: 40_000 }),
        ],
        components: [
          {
            ...comp("Massive refund", "DECREASE", 65_000),
            targetObligationId: "po-1",
          },
        ],
      })
    ).toThrow(/net allocation is negative/);
  });

  it("ignores RESOLVED/REVERSED components even when they have a target", () => {
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [po({ id: "po-1", sequenceNo: 1, ssp: 100_000 })],
      components: [
        {
          ...comp("Inactive", "INCREASE", 50_000, 50_000, "RESOLVED"),
          targetObligationId: "po-1",
        },
      ],
    });
    expect(r.perObligation[0].targetedAdjustment.toFixed(2)).toBe("0.00");
    expect(r.perObligation[0].allocated.toFixed(2)).toBe("100000.00");
  });

  it("rejects negative base amount", () => {
    expect(() =>
      allocateWithVariableConsideration({
        baseAmount: -100,
        pos: [po()],
        components: [],
      })
    ).toThrow(/non-negative/);
  });

  it("rejects components where constrained > unconstrained", () => {
    expect(() =>
      allocateWithVariableConsideration({
        baseAmount: 100_000,
        pos: [po()],
        components: [
          {
            ...comp("Bad", "INCREASE", 500, 100),
            targetObligationId: undefined,
          },
        ],
      })
    ).toThrow(/constrained 500.*unconstrained 100/);
  });
});

describe("allocateWithVariableConsideration — penny-perfect totals", () => {
  it("preserves the last-residual invariant from the underlying allocator", () => {
    // 100k contract-wide split 33/33/34. The allocator's residual
    // lands on the last PO. Per-PO targeted on PO-1 shouldn't disturb
    // the contract-wide residual.
    const r = allocateWithVariableConsideration({
      baseAmount: 100_000,
      pos: [
        po({ id: "po-1", sequenceNo: 1, ssp: 33_000 }),
        po({ id: "po-2", sequenceNo: 2, ssp: 33_000 }),
        po({ id: "po-3", sequenceNo: 3, ssp: 34_000 }),
      ],
      components: [
        { ...comp("PO-1 bonus", "INCREASE", 100), targetObligationId: "po-1" },
      ],
    });
    // Σ contract-wide allocations exactly = contract-wide price (100k)
    const cw = r.perObligation.reduce(
      (acc, p) => acc.plus(p.contractWideAllocated),
      new Decimal(0)
    );
    expect(cw.toFixed(2)).toBe("100000.00");
    // PO-1 gets the targeted bonus on top
    expect(r.perObligation[0].targetedAdjustment.toFixed(2)).toBe("100.00");
  });
});
