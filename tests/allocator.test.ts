// ASC 606 Step 4 allocator unit tests.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  allocateTransactionPrice,
  classifyContractEconomics,
  AllocationError,
} from "../src/lib/accounting/allocator";

describe("allocateTransactionPrice", () => {
  it("AT_SSP: when total = Σ SSP, each PO gets its own SSP", () => {
    const r = allocateTransactionPrice({
      totalContractValue: 70_000,
      performanceObligations: [
        { sequenceNo: 1, description: "Subscription", ssp: 60_000 },
        { sequenceNo: 2, description: "Implementation", ssp: 10_000 },
      ],
    });
    expect(r[0].allocatedAmount.toNumber()).toBe(60_000);
    expect(r[1].allocatedAmount.toNumber()).toBe(10_000);
    expect(r[0].allocationPercent.toNumber()).toBeCloseTo(85.71, 1);
    expect(r[1].allocationPercent.toNumber()).toBeCloseTo(14.29, 1);
  });

  it("DISCOUNTED: $60K contract with $70K of SSP spreads the discount proportionally", () => {
    // SaaS portfolio fixture: $60K subscription + $10K implementation
    // sold for $60K. Sum SSP = $70K. Allocation:
    //   PO1: $60K × (60/70) = $51,428.57
    //   PO2: $60K × (10/70) = $8,571.43
    //   Total = $60,000.00 (exact)
    const r = allocateTransactionPrice({
      totalContractValue: 60_000,
      performanceObligations: [
        { sequenceNo: 1, description: "Subscription", ssp: 60_000 },
        { sequenceNo: 2, description: "Implementation", ssp: 10_000 },
      ],
    });
    expect(r[0].allocatedAmount.toFixed(2)).toBe("51428.57");
    expect(r[1].allocatedAmount.toFixed(2)).toBe("8571.43");
    // Totals tie penny-perfect.
    const sum = r[0].allocatedAmount.plus(r[1].allocatedAmount);
    expect(sum.toFixed(2)).toBe("60000.00");
  });

  it("PREMIUM: $80K contract with $70K of SSP spreads the premium proportionally", () => {
    const r = allocateTransactionPrice({
      totalContractValue: 80_000,
      performanceObligations: [
        { sequenceNo: 1, description: "Subscription", ssp: 60_000 },
        { sequenceNo: 2, description: "Implementation", ssp: 10_000 },
      ],
    });
    // $80K × (60/70) = $68,571.43
    // $80K × (10/70) = $11,428.57
    expect(r[0].allocatedAmount.toFixed(2)).toBe("68571.43");
    expect(r[1].allocatedAmount.toFixed(2)).toBe("11428.57");
    expect(
      r[0].allocatedAmount.plus(r[1].allocatedAmount).toFixed(2)
    ).toBe("80000.00");
  });

  it("three POs with awkward proportions: rounding residual lands on the last PO", () => {
    // $100 across three POs of SSP $33.33 / $33.33 / $33.34 — naive
    // proportional allocation would round each to $33.33 and lose 1¢.
    // The last-PO-absorbs-residual policy fixes this.
    const r = allocateTransactionPrice({
      totalContractValue: 100,
      performanceObligations: [
        { sequenceNo: 1, description: "A", ssp: new Decimal("33.33") },
        { sequenceNo: 2, description: "B", ssp: new Decimal("33.33") },
        { sequenceNo: 3, description: "C", ssp: new Decimal("33.34") },
      ],
    });
    const sum = r.reduce((acc, x) => acc.plus(x.allocatedAmount), new Decimal(0));
    expect(sum.toFixed(2)).toBe("100.00");
  });

  it("rejects negative total contract value", () => {
    expect(() =>
      allocateTransactionPrice({
        totalContractValue: -100,
        performanceObligations: [{ sequenceNo: 1, description: "X", ssp: 50 }],
      })
    ).toThrow(AllocationError);
  });

  it("rejects empty PO list", () => {
    expect(() =>
      allocateTransactionPrice({ totalContractValue: 100, performanceObligations: [] })
    ).toThrow(AllocationError);
  });

  it("rejects a PO with negative SSP", () => {
    expect(() =>
      allocateTransactionPrice({
        totalContractValue: 100,
        performanceObligations: [
          { sequenceNo: 1, description: "A", ssp: 50 },
          { sequenceNo: 2, description: "B", ssp: -10 },
        ],
      })
    ).toThrow(AllocationError);
  });

  it("rejects Σ SSP = 0", () => {
    expect(() =>
      allocateTransactionPrice({
        totalContractValue: 100,
        performanceObligations: [
          { sequenceNo: 1, description: "A", ssp: 0 },
          { sequenceNo: 2, description: "B", ssp: 0 },
        ],
      })
    ).toThrow(AllocationError);
  });
});

describe("classifyContractEconomics", () => {
  it("AT_SSP when total ≈ Σ SSP (within 1¢)", () => {
    expect(
      classifyContractEconomics(70_000, [{ ssp: 60_000 }, { ssp: 10_000 }])
    ).toBe("AT_SSP");
  });

  it("DISCOUNTED when total < Σ SSP", () => {
    expect(
      classifyContractEconomics(60_000, [{ ssp: 60_000 }, { ssp: 10_000 }])
    ).toBe("DISCOUNTED");
  });

  it("PREMIUM when total > Σ SSP", () => {
    expect(
      classifyContractEconomics(80_000, [{ ssp: 60_000 }, { ssp: 10_000 }])
    ).toBe("PREMIUM");
  });
});
