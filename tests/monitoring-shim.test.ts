// Unit tests for the revenue-rec monitoring shim.
//
// Mirror of fa-amort PR #21 + recon PR #24 with revenue-rec-specific
// PII fields (rawText, counterpartyName, signatories) — the
// load-bearing carve-out per data-classification.md.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  redactPii,
  PII_FIELDS,
  stripStackPreamble,
  sanitizeErrorForCapture,
} from "../src/lib/soc2/redact-pii";
import {
  captureError,
  captureMessage,
} from "../src/lib/monitoring";

describe("redactPii — PII allowlist", () => {
  it("redacts every field in the canonical PII set", () => {
    const obj = {
      email: "alice@example.com",
      password: "hunter2",
      token: "tok_abc",
      apiKey: "key_xyz",
      rawText: "SOFTWARE LICENSE AGREEMENT between Acme Corp and...",
      counterpartyName: "Acme Corp",
      signatories: ["Jane Doe, CEO"],
      inputText: "extraction prompt",
      outputJson: { extracted: "value" },
      benign: "value",
    };
    const out = redactPii(obj);
    expect(out.email).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.rawText).toBe("[REDACTED]");
    expect(out.counterpartyName).toBe("[REDACTED]");
    expect(out.signatories).toBe("[REDACTED]");
    expect(out.inputText).toBe("[REDACTED]");
    expect(out.outputJson).toBe("[REDACTED]");
    // Non-PII field passes through.
    expect(out.benign).toBe("value");
  });

  it("does NOT mutate the input object", () => {
    const obj = { email: "x@y.com", benign: 1 };
    const out = redactPii(obj);
    expect(obj.email).toBe("x@y.com"); // input untouched
    expect(out.email).toBe("[REDACTED]");
  });

  it("traverses arrays of objects", () => {
    const arr = [{ email: "a@x.com" }, { email: "b@y.com" }];
    const out = redactPii(arr);
    expect(out[0].email).toBe("[REDACTED]");
    expect(out[1].email).toBe("[REDACTED]");
  });

  it("redacts nested PII deep inside an object tree", () => {
    const obj = {
      level1: { level2: { rawText: "buried contract text", other: "ok" } },
    };
    const out = redactPii(obj);
    expect(out.level1.level2.rawText).toBe("[REDACTED]");
    expect(out.level1.level2.other).toBe("ok");
  });

  it("preserves null + undefined + primitives", () => {
    expect(redactPii(null)).toBe(null);
    expect(redactPii(undefined)).toBe(undefined);
    expect(redactPii("hello")).toBe("hello");
    expect(redactPii(42)).toBe(42);
    expect(redactPii(true)).toBe(true);
  });

  it("redacts Error.message but keeps name + stack", () => {
    const err = new Error("Failed for user alice@example.com");
    const out = redactPii(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("[REDACTED]");
    expect(out.stack).toBeTruthy();
  });

  it("exports PII_FIELDS for audit trail (revenue-rec key fields present)", () => {
    expect(PII_FIELDS).toBeInstanceOf(Set);
    expect(PII_FIELDS.has("email")).toBe(true);
    expect(PII_FIELDS.has("rawText")).toBe(true); // load-bearing carve-out
    expect(PII_FIELDS.has("counterpartyName")).toBe(true);
    // 14th-pass M3: gap-filled fields that ASC 606 extraction
    // paths populate verbatim.
    expect(PII_FIELDS.has("signatoryEmail")).toBe(true);
    expect(PII_FIELDS.has("contractNumber")).toBe(true);
    expect(PII_FIELDS.has("purchaseOrderNumber")).toBe(true);
    expect(PII_FIELDS.has("invoiceNumber")).toBe(true);
    expect(PII_FIELDS.has("benign")).toBe(false);
  });

  it("14th-pass H1: strips PII from Error.stack preamble", () => {
    const err = new Error("Contract failed for Acme Corp + Jane Doe");
    const out = redactPii(err);
    expect(out.stack).not.toContain("Acme Corp");
    expect(out.stack).not.toContain("Jane Doe");
    expect(out.stack).toContain("    at ");
    expect(out.stack).toContain("[REDACTED]");
  });

  it("14th-pass H1: stripStackPreamble handles missing/edge stacks", () => {
    expect(stripStackPreamble(undefined)).toBe(undefined);
    expect(stripStackPreamble("custom format")).toBe("custom format");
  });

  it("14th-pass M3: redacts signatoryEmail (revenue-rec gap-fill)", () => {
    const obj = {
      signatoryEmail: "ceo@counterparty.com",
      contractNumber: "CONTRACT-2026-001",
      purchaseOrderNumber: "PO-Acme-100",
      invoiceNumber: "INV-2026-042",
      benign: "value",
    };
    const out = redactPii(obj);
    expect(out.signatoryEmail).toBe("[REDACTED]");
    expect(out.contractNumber).toBe("[REDACTED]");
    expect(out.purchaseOrderNumber).toBe("[REDACTED]");
    expect(out.invoiceNumber).toBe("[REDACTED]");
    expect(out.benign).toBe("value");
  });
});

describe("captureError — Sentry fallback path", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleErrorSpy.mockRestore();
  });

  it("calls console.error with [monitoring] prefix when DSN absent", () => {
    captureError(new Error("boom"), { context: "test" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe("[monitoring]");
  });

  it("does NOT pass raw err.message to console (contract text leak prevention)", () => {
    const err = new Error(
      "Contract with Acme Corp signed by Jane Doe violates constraint"
    );
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("Acme Corp");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).toContain("errName");
  });

  it("redacts PII from the extra context", () => {
    captureError(new Error("x"), {
      context: "test",
      extra: {
        email: "alice@example.com",
        counterpartyName: "Acme Corp",
        benign: "value",
      },
    });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("Acme Corp");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("value");
  });

  it("passes through non-Error primitives as errPrimitive", () => {
    captureError("string-error", { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).toContain("errPrimitive");
    expect(serialized).toContain("string-error");
  });

  it("14th-pass M1: caps err.code at 16 chars", () => {
    const err = new Error("boom");
    (err as { code?: string }).code =
      "ECONNREFUSED: 10.0.1.42:5432 server-side";
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("10.0.1.42");
    expect(serialized).toContain("ECONNREFUSED: 10");
  });
});

describe("sanitizeErrorForCapture — Sentry path safety (14th-pass H1)", () => {
  it("returns non-Errors unchanged", () => {
    expect(sanitizeErrorForCapture("string-error")).toBe("string-error");
  });

  it("returns a NEW Error (doesn't mutate the caller's err)", () => {
    const original = new Error("Failed for Acme Corp");
    const out = sanitizeErrorForCapture(original);
    expect(original.message).toBe("Failed for Acme Corp");
    expect((out as Error).message).toBe("[REDACTED]");
  });

  it("strips PII from the returned Error's .stack", () => {
    const original = new Error("Failed for Acme Corp");
    const out = sanitizeErrorForCapture(original) as Error;
    expect(out.stack).not.toContain("Acme Corp");
    expect(out.stack).toContain("[REDACTED]");
  });
});

describe("captureMessage — level routing", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("info → console.log", () => {
    captureMessage("informational", "info");
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("warning → console.warn", () => {
    captureMessage("warn", "warning");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("error → console.error", () => {
    captureMessage("err", "error");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
