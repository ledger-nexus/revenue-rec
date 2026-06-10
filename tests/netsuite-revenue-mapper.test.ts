// Unit tests for the NetSuite revenue-arrangement pure mappers.
//
// No DB access; tests run anywhere. Integration tests against real
// Postgres land alongside the orchestrator (import.ts) in the
// follow-up PR.

import { describe, it, expect } from "vitest";
import {
  mapAllocationMethod,
  mapArrangement,
  mapElement,
  mapFairValueMethod,
  mapRecognitionTemplate,
  NS_REVENUE_MAPPING_VERSION,
} from "../src/lib/mappers/netsuite";
import type {
  NsArrangementElement,
  NsRecognitionTemplate,
  NsRevenueArrangement,
} from "../src/lib/mappers/netsuite";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function makeTemplate(
  overrides: Partial<NsRecognitionTemplate> = {}
): NsRecognitionTemplate {
  return {
    internalid: "tpl-100",
    name: "Even Posting Across Dates",
    rec_method: "REC_EVEN_USING_DATES",
    ...overrides,
  };
}

function makeElement(
  overrides: Partial<NsArrangementElement> = {}
): NsArrangementElement {
  return {
    line_internal_id: "ele-1",
    sequence_no: 1,
    item: { internalid: "item-saas", name: "SaaS Subscription" },
    description: "Annual SaaS subscription — Standard tier",
    ssp: 12000,
    fair_value_method: "ESP",
    allocated_amount: 12000,
    allocation_method: "RELATIVE_SSP",
    quantity: 1,
    amount: 12000,
    rec_template: { internalid: "tpl-100" },
    rev_rec_start_date: "2026-01-01",
    rev_rec_end_date: "2026-12-31",
    revenue_account: { internalid: "4000" },
    deferred_revenue_account: { internalid: "2200" },
    ...overrides,
  };
}

function makeArrangement(
  overrides: Partial<NsRevenueArrangement> = {}
): NsRevenueArrangement {
  return {
    internalid: "ra-500",
    tranid: "RA-2026-001",
    subsidiary: { internalid: "sub-1", name: "Acme US" },
    customer: { internalid: "cust-42", name: "Initech LLC" },
    currency: "USD",
    accounting_standard: "ASC_606",
    arrangement_date: "2026-01-01",
    transaction_price: 12000,
    elements: [makeElement()],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recognition template translation
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRecognitionTemplate", () => {
  it("maps the four documented NS rec_methods to RecognitionPattern", () => {
    expect(mapRecognitionTemplate(makeTemplate({ rec_method: "REC_RECOGNITION_DATE" })).pattern).toBe("POINT_IN_TIME");
    expect(mapRecognitionTemplate(makeTemplate({ rec_method: "REC_EVEN_USING_DATES" })).pattern).toBe("OVER_TIME_STRAIGHT");
    expect(mapRecognitionTemplate(makeTemplate({ rec_method: "REC_USAGE" })).pattern).toBe("OVER_TIME_USAGE");
    expect(mapRecognitionTemplate(makeTemplate({ rec_method: "REC_PERCENT_COMPLETE" })).pattern).toBe("OVER_TIME_MILESTONE");
  });

  it("returns null + actionable reason for unmapped rec_methods", () => {
    const result = mapRecognitionTemplate(
      makeTemplate({ rec_method: "REC_CUSTOM_FOO", name: "Custom Template" })
    );
    expect(result.pattern).toBeNull();
    expect(result.reason).toContain("REC_CUSTOM_FOO");
    expect(result.reason).toContain("Custom Template");
    expect(result.reason).toContain("POINT_IN_TIME"); // suggests safe default
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allocation + fair-value method translation
// ─────────────────────────────────────────────────────────────────────────────

describe("mapAllocationMethod", () => {
  it("maps RELATIVE_SSP → PROPORTIONAL", () => {
    expect(mapAllocationMethod("RELATIVE_SSP")).toBe("PROPORTIONAL");
  });

  it("passes RESIDUAL + MANUAL through", () => {
    expect(mapAllocationMethod("RESIDUAL")).toBe("RESIDUAL");
    expect(mapAllocationMethod("MANUAL")).toBe("MANUAL");
  });

  it("returns null for undefined / unknown values", () => {
    expect(mapAllocationMethod(undefined)).toBeNull();
    expect(mapAllocationMethod("UNKNOWN")).toBeNull();
    expect(mapAllocationMethod("")).toBeNull();
  });
});

describe("mapFairValueMethod", () => {
  it("passes ESP/VSOE/TPE/RESIDUAL through", () => {
    expect(mapFairValueMethod("ESP")).toBe("ESP");
    expect(mapFairValueMethod("VSOE")).toBe("VSOE");
    expect(mapFairValueMethod("TPE")).toBe("TPE");
    expect(mapFairValueMethod("RESIDUAL")).toBe("RESIDUAL");
  });

  it("returns null for undefined / unknown values", () => {
    expect(mapFairValueMethod(undefined)).toBeNull();
    expect(mapFairValueMethod("BUNDLED")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-element mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapElement", () => {
  it("maps a vanilla element (ssp == allocated_amount, no quantity)", () => {
    const { obligation, warnings } = mapElement(makeElement(), makeTemplate());
    expect(obligation.sequenceNo).toBe(1);
    expect(obligation.description).toBe("Annual SaaS subscription — Standard tier");
    expect(obligation.ssp).toBe(12000);
    expect(obligation.allocatedAmount).toBeNull(); // ssp == allocated → null (back-compat)
    expect(obligation.allocationMethod).toBe("PROPORTIONAL");
    expect(obligation.fairValueMethod).toBe("ESP");
    expect(obligation.quantity).toBe(1);
    expect(obligation.recognitionPattern).toBe("OVER_TIME_STRAIGHT");
    expect(obligation.startDate).toBe("2026-01-01");
    expect(obligation.endDate).toBe("2026-12-31");
    expect(obligation.revenueAccountCode).toBe("4000");
    expect(obligation.deferredAccountCode).toBe("2200");
    expect(warnings).toHaveLength(0);
  });

  it("explicit allocatedAmount when divergent from SSP (residual case)", () => {
    const { obligation } = mapElement(
      makeElement({
        ssp: 12000,
        allocated_amount: 9500, // residual allocation skimmed value
        allocation_method: "RESIDUAL",
      }),
      makeTemplate()
    );
    expect(obligation.allocatedAmount).toBe(9500);
    expect(obligation.allocationMethod).toBe("RESIDUAL");
  });

  it("defaults quantity to 1 when NS omits it", () => {
    const elem = makeElement();
    delete (elem as Partial<NsArrangementElement>).quantity;
    const { obligation } = mapElement(elem, makeTemplate());
    expect(obligation.quantity).toBe(1);
  });

  it("preserves quantity > 1 (per-unit SSP case)", () => {
    const { obligation } = mapElement(
      makeElement({ ssp: 20, quantity: 500, allocated_amount: 20 }),
      makeTemplate()
    );
    expect(obligation.ssp).toBe(20);
    expect(obligation.quantity).toBe(500);
  });

  it("defaults to POINT_IN_TIME with a warning when template is missing", () => {
    const { obligation, warnings } = mapElement(makeElement(), undefined);
    expect(obligation.recognitionPattern).toBe("POINT_IN_TIME");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not found/);
  });

  it("defaults to POINT_IN_TIME with a warning when rec_method is unmapped", () => {
    const { obligation, warnings } = mapElement(
      makeElement(),
      makeTemplate({ rec_method: "REC_CUSTOM" })
    );
    expect(obligation.recognitionPattern).toBe("POINT_IN_TIME");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Unmapped NS rec_method/);
  });

  it("surfaces a warning for unmapped allocation_method (field left null)", () => {
    const { obligation, warnings } = mapElement(
      makeElement({ allocation_method: "MYSTERY_METHOD" }),
      makeTemplate()
    );
    expect(obligation.allocationMethod).toBeNull();
    expect(warnings.some((w) => w.includes("unmapped NS allocation_method"))).toBe(true);
  });

  it("surfaces a warning for unmapped fair_value_method", () => {
    const { obligation, warnings } = mapElement(
      makeElement({ fair_value_method: "BUNDLED" }),
      makeTemplate()
    );
    expect(obligation.fairValueMethod).toBeNull();
    expect(warnings.some((w) => w.includes("unmapped NS fair_value_method"))).toBe(true);
  });

  it("handles null rev_rec_end_date (POINT_IN_TIME case)", () => {
    const { obligation } = mapElement(
      makeElement({ rev_rec_end_date: null }),
      makeTemplate({ rec_method: "REC_RECOGNITION_DATE" })
    );
    expect(obligation.endDate).toBeNull();
    expect(obligation.recognitionPattern).toBe("POINT_IN_TIME");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full-arrangement mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapArrangement", () => {
  it("maps a single-element arrangement end-to-end", () => {
    const templates = new Map<string, NsRecognitionTemplate>([
      ["tpl-100", makeTemplate()],
    ]);
    const result = mapArrangement(makeArrangement(), templates);

    expect(result.contract.code).toBe("NS-RA-RA-2026-001");
    expect(result.contract.description).toContain("Initech LLC");
    expect(result.contract.totalContractValue).toBe(12000);
    expect(result.contract.currencyId).toBe("USD");
    expect(result.contract.sourceSystem).toBe("netsuite");
    expect(result.contract.sourceRecordType).toBe("RevenueArrangement");
    expect(result.contract.sourceRecordId).toBe("ra-500");
    expect(result.contract.mappingVersion).toBe(NS_REVENUE_MAPPING_VERSION);
    // Lineage payload preserved verbatim.
    expect(result.contract.sourcePayload.tranid).toBe("RA-2026-001");

    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0].recognitionPattern).toBe("OVER_TIME_STRAIGHT");
    expect(result.warnings).toHaveLength(0);
  });

  it("maps a multi-element arrangement with mixed templates", () => {
    const templates = new Map<string, NsRecognitionTemplate>([
      ["tpl-100", makeTemplate()],
      ["tpl-200", makeTemplate({ internalid: "tpl-200", rec_method: "REC_RECOGNITION_DATE", name: "On Date" })],
    ]);
    const arrangement = makeArrangement({
      transaction_price: 22000,
      elements: [
        makeElement({
          line_internal_id: "ele-1",
          sequence_no: 1,
          allocated_amount: 12000,
          ssp: 12000,
        }),
        makeElement({
          line_internal_id: "ele-2",
          sequence_no: 2,
          description: "Implementation services (one-time)",
          ssp: 10000,
          allocated_amount: 10000,
          rec_template: { internalid: "tpl-200" },
          rev_rec_end_date: null,
        }),
      ],
    });

    const result = mapArrangement(arrangement, templates);
    expect(result.obligations).toHaveLength(2);
    expect(result.obligations[0].recognitionPattern).toBe("OVER_TIME_STRAIGHT");
    expect(result.obligations[1].recognitionPattern).toBe("POINT_IN_TIME");
    expect(result.obligations[1].endDate).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it("surfaces a warning when arrangement.transaction_price ≠ Σ allocated_amount", () => {
    const templates = new Map([["tpl-100", makeTemplate()]]);
    const arrangement = makeArrangement({
      transaction_price: 12000, // declared
      elements: [makeElement({ allocated_amount: 11500 })], // actual sum
    });

    const result = mapArrangement(arrangement, templates);
    expect(result.warnings.some((w) => w.includes("transaction_price"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("12000.00"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("11500.00"))).toBe(true);
  });

  it("absorbs sub-penny rounding in the transaction_price check", () => {
    const templates = new Map([["tpl-100", makeTemplate()]]);
    const arrangement = makeArrangement({
      transaction_price: 12000.005, // half-penny off
      elements: [makeElement({ allocated_amount: 12000.0 })],
    });

    const result = mapArrangement(arrangement, templates);
    // No warning — within $0.01 tolerance.
    expect(result.warnings.some((w) => w.includes("transaction_price"))).toBe(false);
  });

  it("propagates per-element warnings to the arrangement-level warnings list", () => {
    const templates = new Map([
      ["tpl-100", makeTemplate({ rec_method: "REC_CUSTOM_FOO" })],
    ]);
    const arrangement = makeArrangement();
    const result = mapArrangement(arrangement, templates);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("REC_CUSTOM_FOO"))).toBe(true);
  });

  it("preserves the full NS arrangement in sourcePayload (roundtrip-ready)", () => {
    const templates = new Map([["tpl-100", makeTemplate()]]);
    const arrangement = makeArrangement({
      custom_body: { custbody_region: "EMEA", custbody_csm: "alice@acme.com" },
    });
    const result = mapArrangement(arrangement, templates);
    expect(result.contract.sourcePayload.custom_body).toEqual({
      custbody_region: "EMEA",
      custbody_csm: "alice@acme.com",
    });
  });
});
