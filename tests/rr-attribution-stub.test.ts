// Test for the DSR attribution stub.
// See recon/tests/recon-attribution-stub.test.ts for rationale.

import { describe, it, expect } from "vitest";
import {
  revenueRecAttribution,
  NotImplementedError,
  type RevenueRecAttribution,
} from "../src/lib/privacy/rr-attribution";

describe("DSR — revenue-rec attribution stub (Privacy TSC contract)", () => {
  it("exports the revenueRecAttribution function", () => {
    expect(typeof revenueRecAttribution).toBe("function");
  });

  it("exports the NotImplementedError class", () => {
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("throws NotImplementedError when called (locks the contract)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    await expect(
      revenueRecAttribution(fakePrisma, "test-user-id")
    ).rejects.toThrow(NotImplementedError);
  });

  it("error message points at the DSR doc's Open items section", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    try {
      await revenueRecAttribution(fakePrisma, "test-user-id");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/data-subject-requests/);
      expect((e as Error).message).toMatch(/Open items/);
    }
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
  });
});
