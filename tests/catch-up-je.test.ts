// Catch-up JE builder tests. Pure function — no DB.
//
// Covers:
//   - Sign convention: positive → DR Deferred + CR Revenue;
//     negative → DR Revenue + CR Deferred
//   - Multi-PO assemblies with mixed signs
//   - Zero-amount POs excluded
//   - Σ DR = Σ CR invariant (balanced JE by construction)
//   - All-zero input throws
//   - Per-PO rounding to 2dp

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  buildCatchUpJe,
  CatchUpBuildError,
  type CatchUpPerObligationInput,
} from "../src/lib/accounting/catch-up-je";

function po(
  over: Partial<CatchUpPerObligationInput> = {}
): CatchUpPerObligationInput {
  return {
    obligationId: over.obligationId ?? "po-1",
    sequenceNo: over.sequenceNo ?? 1,
    revenueAccountCode: over.revenueAccountCode ?? "4000",
    deferredAccountCode: over.deferredAccountCode ?? "2200",
    catchUpAmount: over.catchUpAmount ?? 0,
  };
}

describe("buildCatchUpJe — sign convention", () => {
  it("positive catch-up → DR Deferred, CR Revenue (recognize more revenue)", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "estimate raised",
      perObligation: [po({ catchUpAmount: 5000 })],
    });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].accountCode).toBe("2200");
    expect(r.lines[0].debit?.toFixed(2)).toBe("5000.00");
    expect(r.lines[0].credit).toBeUndefined();
    expect(r.lines[1].accountCode).toBe("4000");
    expect(r.lines[1].credit?.toFixed(2)).toBe("5000.00");
    expect(r.lines[1].debit).toBeUndefined();
  });

  it("negative catch-up → DR Revenue, CR Deferred (reverse revenue)", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "estimate lowered",
      perObligation: [po({ catchUpAmount: -3000 })],
    });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].accountCode).toBe("4000"); // Revenue side gets the DR
    expect(r.lines[0].debit?.toFixed(2)).toBe("3000.00");
    expect(r.lines[1].accountCode).toBe("2200"); // Deferred side gets the CR
    expect(r.lines[1].credit?.toFixed(2)).toBe("3000.00");
  });
});

describe("buildCatchUpJe — multi-PO assemblies", () => {
  it("multiple POs with positive catch-ups produce N×2 lines", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "Q3 reassess",
      perObligation: [
        po({ obligationId: "po-1", sequenceNo: 1, catchUpAmount: 1000 }),
        po({
          obligationId: "po-2",
          sequenceNo: 2,
          revenueAccountCode: "4010",
          deferredAccountCode: "2200",
          catchUpAmount: 500,
        }),
      ],
    });
    expect(r.lines).toHaveLength(4);
    expect(r.participatingPoCount).toBe(2);
    expect(r.totalDebits.toFixed(2)).toBe("1500.00");
  });

  it("mixed signs across POs — each PO's pair balances separately", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "Q3 reassess",
      perObligation: [
        po({ obligationId: "po-1", sequenceNo: 1, catchUpAmount: 1000 }), // positive
        po({
          obligationId: "po-2",
          sequenceNo: 2,
          catchUpAmount: -200, // negative
        }),
      ],
    });
    expect(r.lines).toHaveLength(4);
    // Verify the JE balances: Σ DR = Σ CR
    const totalDr = r.lines.reduce(
      (acc, l) => acc.plus(l.debit ?? new Decimal(0)),
      new Decimal(0)
    );
    const totalCr = r.lines.reduce(
      (acc, l) => acc.plus(l.credit ?? new Decimal(0)),
      new Decimal(0)
    );
    expect(totalDr.toFixed(2)).toBe(totalCr.toFixed(2));
    // Each PO's contribution should be balanced on its own pair too.
    expect(r.lines[0].debit?.toFixed(2)).toBe("1000.00"); // po-1 DR
    expect(r.lines[1].credit?.toFixed(2)).toBe("1000.00"); // po-1 CR
    expect(r.lines[2].debit?.toFixed(2)).toBe("200.00"); // po-2 DR (reversal)
    expect(r.lines[3].credit?.toFixed(2)).toBe("200.00"); // po-2 CR
  });

  it("zero-amount POs are excluded from the JE", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "Q3 reassess",
      perObligation: [
        po({ obligationId: "po-1", catchUpAmount: 500 }),
        po({ obligationId: "po-2", catchUpAmount: 0 }),
        po({ obligationId: "po-3", catchUpAmount: 300 }),
      ],
    });
    expect(r.lines).toHaveLength(4); // 2 POs × 2 lines, po-2 excluded
    expect(r.participatingPoCount).toBe(2);
  });
});

describe("buildCatchUpJe — rejection cases", () => {
  it("throws if every PO has a zero catch-up", () => {
    expect(() =>
      buildCatchUpJe({
        contractCode: "ACME-2026-01",
        reassessmentDescription: "should never reach here",
        perObligation: [
          po({ obligationId: "po-1", catchUpAmount: 0 }),
          po({ obligationId: "po-2", catchUpAmount: 0 }),
        ],
      })
    ).toThrow(CatchUpBuildError);
  });

  it("throws on an empty per-PO array", () => {
    expect(() =>
      buildCatchUpJe({
        contractCode: "ACME-2026-01",
        reassessmentDescription: "x",
        perObligation: [],
      })
    ).toThrow(/nothing to post/);
  });
});

describe("buildCatchUpJe — rounding", () => {
  it("rounds each amount to 2dp using banker's rounding", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "fractional cents",
      perObligation: [
        // 100.005 ROUND_HALF_EVEN → 100.00 (rounds to even)
        po({ catchUpAmount: "100.005" }),
      ],
    });
    expect(r.lines[0].debit?.toFixed(2)).toBe("100.00");
    expect(r.lines[1].credit?.toFixed(2)).toBe("100.00");
  });

  it("Σ DR = Σ CR even when individual amounts have sub-cent precision", () => {
    const r = buildCatchUpJe({
      contractCode: "ACME-2026-01",
      reassessmentDescription: "x",
      perObligation: [
        po({ obligationId: "po-1", catchUpAmount: "33.333" }),
        po({ obligationId: "po-2", catchUpAmount: "33.334" }),
        po({ obligationId: "po-3", catchUpAmount: "33.333" }),
      ],
    });
    const totalDr = r.lines.reduce(
      (acc, l) => acc.plus(l.debit ?? new Decimal(0)),
      new Decimal(0)
    );
    const totalCr = r.lines.reduce(
      (acc, l) => acc.plus(l.credit ?? new Decimal(0)),
      new Decimal(0)
    );
    expect(totalDr.toFixed(2)).toBe(totalCr.toFixed(2));
  });
});

describe("buildCatchUpJe — line descriptions", () => {
  it("includes contract code + PO sequence number + reassessment description", () => {
    const r = buildCatchUpJe({
      contractCode: "INITECH-2026-01",
      reassessmentDescription: "Q4 volume rebate refined",
      perObligation: [
        po({ sequenceNo: 2, catchUpAmount: 1000 }),
      ],
    });
    expect(r.lines[0].description).toContain("INITECH-2026-01");
    expect(r.lines[0].description).toContain("PO2");
    expect(r.lines[0].description).toContain("Q4 volume rebate refined");
  });
});
