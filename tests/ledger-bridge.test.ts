// Ledger-core bridge tests — mocked fetch, no real network. Same shape
// as recon's bridge tests because the wire contract is the same.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  postEntryViaLedgerCore,
  setFetchForTesting,
  LedgerCoreError,
  type LedgerJournalEntryInput,
} from "../src/lib/ledger-bridge";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseInput: LedgerJournalEntryInput = {
  entityCode: "NORTHWIND",
  documentDate: new Date("2026-03-31"),
  memo: "Recognize INITECH-2026-01 PO1",
  source: "AI_APPROVED",
  lines: [
    { accountCode: "2200", debit: new Decimal("4285.71") },
    { accountCode: "4000", credit: new Decimal("4285.71") },
  ],
};

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.LEDGER_CORE_INTERNAL_TOKEN = "test-token-secret";
  process.env.LEDGER_CORE_URL = "http://test-ledger:3000";
  setFetchForTesting(null);
});

afterEach(() => {
  process.env = { ...originalEnv };
  setFetchForTesting(null);
});

describe("postEntryViaLedgerCore", () => {
  it("returns the parsed result on a successful 200", async () => {
    setFetchForTesting(async () =>
      jsonResponse({
        ok: true,
        id: "uuid-1",
        entryNumber: "NORTHWIND-US_GAAP-00042",
        bookCode: "US_GAAP",
      })
    );
    const r = await postEntryViaLedgerCore(baseInput);
    expect(r.entryNumber).toBe("NORTHWIND-US_GAAP-00042");
  });

  it("decimals serialize as strings, not numbers", async () => {
    let capturedBody: string | null = null;
    setFetchForTesting(async (_url, init) => {
      capturedBody = init?.body as string;
      return jsonResponse({ ok: true, id: "x", entryNumber: "x", bookCode: "x" });
    });
    await postEntryViaLedgerCore(baseInput);
    const body = JSON.parse(capturedBody!);
    expect(typeof body.lines[0].debit).toBe("string");
    expect(body.lines[0].debit).toBe("4285.71");
  });

  it("auth header carries the bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    setFetchForTesting(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ ok: true, id: "x", entryNumber: "x", bookCode: "x" });
    });
    await postEntryViaLedgerCore(baseInput);
    expect(capturedHeaders["Authorization"]).toBe("Bearer test-token-secret");
  });

  it("maps UNBALANCED 422 to LedgerCoreError", async () => {
    setFetchForTesting(async () =>
      jsonResponse(
        { ok: false, error: { code: "UNBALANCED", message: "debits ≠ credits" } },
        422
      )
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      name: "LedgerCoreError",
      code: "UNBALANCED",
      status: 422,
    });
  });

  it("maps PERIOD_CLOSED 409 to LedgerCoreError", async () => {
    setFetchForTesting(async () =>
      jsonResponse(
        { ok: false, error: { code: "PERIOD_CLOSED", message: "Period closed" } },
        409
      )
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "PERIOD_CLOSED",
    });
  });

  it("fetch throw becomes TRANSPORT_ERROR", async () => {
    setFetchForTesting(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("non-JSON response becomes TRANSPORT_ERROR with status", async () => {
    setFetchForTesting(
      async () =>
        new Response("not json", { status: 502, headers: { "Content-Type": "text/plain" } })
    );
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      status: 502,
    });
  });

  it("missing token short-circuits with UNAUTHORIZED — no fetch", async () => {
    delete process.env.LEDGER_CORE_INTERNAL_TOKEN;
    let called = false;
    setFetchForTesting(async () => {
      called = true;
      return jsonResponse({ ok: true, id: "x", entryNumber: "x", bookCode: "x" });
    });
    await expect(postEntryViaLedgerCore(baseInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(called).toBe(false);
  });

  it("LedgerCoreError is recognizable via instanceof", async () => {
    setFetchForTesting(async () =>
      jsonResponse({ ok: false, error: { code: "UNKNOWN_ACCOUNT", message: "x" } }, 422)
    );
    try {
      await postEntryViaLedgerCore(baseInput);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerCoreError);
    }
  });
});
