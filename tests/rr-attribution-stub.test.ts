// Contract tests for the DSR revenue-rec attribution helper.
//
// Hybrid implementation: 2 wired counts (contractDocumentsUploaded,
// recognitionSchedulesApproved) + 3 schema gaps (revenueContractsCreated,
// aiExtractionsAccepted, aiExtractionsRejected). See the HYBRID
// IMPLEMENTATION note in `src/lib/privacy/rr-attribution.ts`.
//
// Runtime-behavior tests (counts vs. real Postgres) live in
// `rr-attribution-integration.test.ts`.

import { describe, it, expect, vi } from "vitest";
import {
  revenueRecAttribution,
  NotImplementedError,
  type RevenueRecAttribution,
} from "../src/lib/privacy/rr-attribution";

describe("DSR — revenue-rec attribution contract (Privacy TSC)", () => {
  it("exports the revenueRecAttribution function", () => {
    expect(typeof revenueRecAttribution).toBe("function");
  });

  it("retains the NotImplementedError class export (back-compat)", () => {
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("13th-pass M2-rev: throws when userId is empty string", async () => {
    const mockPrisma = {
      contractDocument: { count: vi.fn().mockResolvedValue(0) },
      recognitionEvent: { count: vi.fn().mockResolvedValue(0) },
      aiExtractionSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(revenueRecAttribution(mockPrisma, "")).rejects.toThrow(
      /userId is required/
    );
  });

  it("13th-pass M2-rev: throws when userId is null (TS bypass)", async () => {
    const mockPrisma = {
      contractDocument: { count: vi.fn().mockResolvedValue(0) },
      recognitionEvent: { count: vi.fn().mockResolvedValue(0) },
      aiExtractionSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      revenueRecAttribution(mockPrisma, null as any)
    ).rejects.toThrow(/userId is required/);
  });

  it("13th-pass M2-rev: throws when userId is undefined (TS bypass)", async () => {
    const mockPrisma = {
      contractDocument: { count: vi.fn().mockResolvedValue(0) },
      recognitionEvent: { count: vi.fn().mockResolvedValue(0) },
      aiExtractionSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      revenueRecAttribution(mockPrisma, undefined as any)
    ).rejects.toThrow(/userId is required/);
  });

  it("13th-pass H2-rev: revenueContractsCreated is hardcoded 0 (truthful — no schema, no delegation wired)", async () => {
    // After the H2-rev correction, revenueContractsCreated MUST be 0
    // regardless of how many revenue-contracts exist. The interface
    // promises this until either a createdBy column lands OR an
    // audit_log delegation is genuinely implemented.
    const mockPrisma = {
      contractDocument: { count: vi.fn().mockResolvedValue(99) },
      recognitionEvent: { count: vi.fn().mockResolvedValue(99) },
      aiExtractionSuggestion: { count: vi.fn().mockResolvedValue(99) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await revenueRecAttribution(mockPrisma, "subject-uuid");
    expect(result.revenueContractsCreated).toBe(0);
  });

  it("RevenueRecAttribution interface shape is stable (counts only, no contents)", () => {
    // Counterparty PII in ContractDocument.rawText is the load-bearing
    // carve-out from the DSR procedure — verifying the interface has
    // a COUNT field (contractDocumentsUploaded) and NOT a contents
    // field is the type-level enforcement of that carve-out.
    const shape: RevenueRecAttribution = {
      revenueContractsCreated: 0,
      contractDocumentsUploaded: 0,
      recognitionSchedulesApproved: 0,
      aiExtractionsAccepted: 0,
      aiExtractionsRejected: 0,
      snapshotAt: "2026-06-03T00:00:00.000Z",
    };
    expect(shape.contractDocumentsUploaded).toBe(0);

    // Sanity: the keys we DO have don't contain content-shaped names.
    const keys = Object.keys(shape);
    const forbidden = ["contents", "rawtext", "rawdata", "signatories", "description"];
    for (const k of keys) {
      for (const f of forbidden) {
        expect(k.toLowerCase()).not.toContain(f.toLowerCase());
      }
    }
  });
});
