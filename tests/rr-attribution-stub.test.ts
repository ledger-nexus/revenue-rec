// Contract tests for the DSR revenue-rec attribution helper.
//
// Hybrid implementation: 2 wired counts (contractDocumentsUploaded,
// recognitionSchedulesApproved) + 3 schema gaps (revenueContractsCreated,
// aiExtractionsAccepted, aiExtractionsRejected). See the HYBRID
// IMPLEMENTATION note in `src/lib/privacy/rr-attribution.ts`.
//
// Runtime-behavior tests (counts vs. real Postgres) live in
// `rr-attribution-integration.test.ts`.

import { describe, it, expect } from "vitest";
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
