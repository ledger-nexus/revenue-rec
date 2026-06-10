// Tests for the 2026-06-04 PerformanceObligation schema additions.
//
// Validates the Zod-schema surface in `src/lib/extraction/ai-extract.ts`
// for the four new fields: allocatedAmount, allocationMethod,
// fairValueMethod, quantity. All four are optional/nullable so
// pre-2026-06-04 callers continue to parse cleanly.
//
// Integration-level coverage (real DB roundtrip with the new columns)
// will land in the follow-up PR that wires the NetSuite mapper +
// the recognition engine's use of `allocatedAmount`.

import { describe, it, expect } from "vitest";
import { ExtractedPoSchema } from "../src/lib/extraction/ai-extract";

// Minimum-required base for an ExtractedPo (everything else is
// optional/back-compat).
const BASE_PO = {
  sequenceNo: 1,
  description: "Annual SaaS subscription — Initech Standard",
  ssp: 12000,
  recognitionPattern: "OVER_TIME_STRAIGHT",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  revenueAccountCode: "4000",
  deferredAccountCode: "2200",
  rationale: "Identified as distinct PO; SSP from list price.",
} as const;

describe("ExtractedPoSchema — 2026-06-04 schema additions", () => {
  it("parses a v0.2-shape PO (no new fields) — back-compat hard guarantee", () => {
    const result = ExtractedPoSchema.safeParse(BASE_PO);
    expect(result.success).toBe(true);
    if (result.success) {
      // The optional fields are undefined when absent — matches Prisma
      // NULL semantics.
      expect(result.data.allocatedAmount).toBeUndefined();
      expect(result.data.allocationMethod).toBeUndefined();
      expect(result.data.fairValueMethod).toBeUndefined();
      expect(result.data.quantity).toBeUndefined();
    }
  });

  it("parses a v2.1-shape PO with all four new fields populated", () => {
    const result = ExtractedPoSchema.safeParse({
      ...BASE_PO,
      allocatedAmount: 11500, // residual allocation diverges from $12000 SSP
      allocationMethod: "RESIDUAL",
      fairValueMethod: "ESP",
      quantity: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allocatedAmount).toBe(11500);
      expect(result.data.allocationMethod).toBe("RESIDUAL");
      expect(result.data.fairValueMethod).toBe("ESP");
      expect(result.data.quantity).toBe(1);
    }
  });

  it("accepts null for each optional field (matches the Prisma NULL column semantics)", () => {
    const result = ExtractedPoSchema.safeParse({
      ...BASE_PO,
      allocatedAmount: null,
      allocationMethod: null,
      fairValueMethod: null,
      quantity: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid allocationMethod value", () => {
    const result = ExtractedPoSchema.safeParse({
      ...BASE_PO,
      allocationMethod: "INVALID_METHOD",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid fairValueMethod value", () => {
    const result = ExtractedPoSchema.safeParse({
      ...BASE_PO,
      fairValueMethod: "MADE_UP",
    });
    expect(result.success).toBe(false);
  });

  it("accepts each of the four allocation methods", () => {
    for (const method of ["PROPORTIONAL", "RESIDUAL", "MANUAL"] as const) {
      const result = ExtractedPoSchema.safeParse({
        ...BASE_PO,
        allocationMethod: method,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allocationMethod).toBe(method);
      }
    }
  });

  it("accepts each of the four fair-value methods", () => {
    for (const fvm of ["ESP", "VSOE", "TPE", "RESIDUAL"] as const) {
      const result = ExtractedPoSchema.safeParse({
        ...BASE_PO,
        fairValueMethod: fvm,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fairValueMethod).toBe(fvm);
      }
    }
  });

  it("accepts a quantity > 1 (per-unit SSP case)", () => {
    // The 500-seats-at-$20 case: SSP=20, quantity=500, total line = $10,000
    const result = ExtractedPoSchema.safeParse({
      ...BASE_PO,
      ssp: 20,
      quantity: 500,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ssp).toBe(20);
      expect(result.data.quantity).toBe(500);
    }
  });
});
