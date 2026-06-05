// Unit tests for the NetSuite revenue-arrangement import orchestrator.
//
// Mocks Prisma so the suite runs without a live DB. Tests the
// orchestration logic — idempotency dedup, per-arrangement error
// isolation, totals, warning propagation, customer-party resolution —
// without exercising the actual SQL.
//
// Integration tests against real Postgres land alongside the Server
// Action that wraps this orchestrator (future sprint PR).

import { describe, it, expect, vi } from "vitest";
import { importFromNsRevenue } from "../src/lib/mappers/netsuite";
import type {
  NsArrangementElement,
  NsRecognitionTemplate,
  NsRevenueArrangement,
  NsRevenueArrangementExport,
} from "../src/lib/mappers/netsuite";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function makeTemplate(
  overrides: Partial<NsRecognitionTemplate> = {}
): NsRecognitionTemplate {
  return {
    internalid: "tpl-100",
    name: "Even Across Dates",
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
    description: "Annual SaaS subscription",
    ssp: 12000,
    fair_value_method: "ESP",
    allocated_amount: 12000,
    allocation_method: "RELATIVE_SSP",
    quantity: 1,
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

function makeExport(
  overrides: Partial<NsRevenueArrangementExport> = {}
): NsRevenueArrangementExport {
  return {
    exported_at: "2026-06-05T00:00:00Z",
    account_id: "ns-acct-1",
    recognition_templates: [makeTemplate()],
    arrangements: [makeArrangement()],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mocked Prisma — minimal surface the orchestrator touches
// ─────────────────────────────────────────────────────────────────────────────

interface MockState {
  existingContracts: Map<string, string>; // sourceRecordId → contract id
  createdContractCount: number;
  createdObligationCount: number;
  capturedPoData: unknown[];
}

function makeMockPrisma(initial: Partial<MockState> = {}): {
  prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  state: MockState;
} {
  const state: MockState = {
    existingContracts: new Map(initial.existingContracts ?? []),
    createdContractCount: 0,
    createdObligationCount: 0,
    capturedPoData: [],
  };

  // Sub-mock for inside-transaction txClient.
  const makeTxClient = () => ({
    revenueContract: {
      create: vi.fn(async ({ data }: { data: { sourceRecordId?: string } }) => {
        state.createdContractCount += 1;
        const id = `contract-${state.createdContractCount}`;
        if (data.sourceRecordId) {
          state.existingContracts.set(data.sourceRecordId, id);
        }
        return { id };
      }),
    },
    performanceObligation: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        state.createdObligationCount += 1;
        state.capturedPoData.push(data);
        return { id: `po-${state.createdObligationCount}` };
      }),
    },
  });

  const prisma = {
    revenueContract: {
      findFirst: vi.fn(async ({ where }: { where: { sourceRecordId: string } }) => {
        const id = state.existingContracts.get(where.sourceRecordId);
        return id ? { id } : null;
      }),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb(makeTxClient());
    }),
  };

  return { prisma, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("importFromNsRevenue — orchestrator", () => {
  it("imports a single arrangement end-to-end (happy path)", async () => {
    const { prisma, state } = makeMockPrisma();
    const result = await importFromNsRevenue(prisma, {
      export: makeExport(),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(result.totals.arrangementsProcessed).toBe(1);
    expect(result.totals.arrangementsCreated).toBe(1);
    expect(result.totals.arrangementsSkipped).toBe(0);
    expect(result.totals.arrangementsErrored).toBe(0);
    expect(result.totals.obligationsCreated).toBe(1);
    expect(result.arrangements).toHaveLength(1);
    expect(result.arrangements[0].wasDuplicate).toBe(false);
    expect(result.arrangements[0].contractId).toBe("contract-1");
    expect(result.errors).toHaveLength(0);
    expect(state.capturedPoData).toHaveLength(1);
  });

  it("SKIPS arrangement when lineage triple matches existing contract (idempotency)", async () => {
    const { prisma, state } = makeMockPrisma({
      existingContracts: new Map([["ra-500", "contract-existing"]]),
    });
    const result = await importFromNsRevenue(prisma, {
      export: makeExport(),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(result.totals.arrangementsCreated).toBe(0);
    expect(result.totals.arrangementsSkipped).toBe(1);
    expect(result.arrangements[0].wasDuplicate).toBe(true);
    expect(result.arrangements[0].contractId).toBe("contract-existing");
    expect(state.createdContractCount).toBe(0); // no writes happened
    expect(state.createdObligationCount).toBe(0);
  });

  it("isolates per-arrangement failures — bad row doesn't sink the rest", async () => {
    const { prisma } = makeMockPrisma();
    const goodArrangement = makeArrangement({
      internalid: "ra-good",
      tranid: "RA-GOOD",
      customer: { internalid: "cust-1", name: "Good Customer" },
    });
    const badArrangement = makeArrangement({
      internalid: "ra-bad",
      tranid: "RA-BAD",
      customer: { internalid: "cust-bad", name: "Bad Customer" },
    });

    const result = await importFromNsRevenue(prisma, {
      export: makeExport({ arrangements: [goodArrangement, badArrangement] }),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      // Resolver throws for the bad arrangement only.
      resolveCustomerPartyId: async ({ nsCustomerInternalId }) => {
        if (nsCustomerInternalId === "cust-bad") {
          throw new Error("Customer not found in CRM");
        }
        return "party-1";
      },
    });

    expect(result.totals.arrangementsCreated).toBe(1);
    expect(result.totals.arrangementsErrored).toBe(1);
    expect(result.arrangements).toHaveLength(1);
    expect(result.arrangements[0].nsArrangementTranid).toBe("RA-GOOD");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].nsArrangementTranid).toBe("RA-BAD");
    expect(result.errors[0].message).toMatch(/CRM/);
  });

  it("propagates mapper warnings to the per-arrangement result", async () => {
    const { prisma } = makeMockPrisma();
    // Set up an arrangement whose template will surface a warning.
    const result = await importFromNsRevenue(prisma, {
      export: makeExport({
        recognition_templates: [
          makeTemplate({ rec_method: "REC_CUSTOM_THING" }),
        ],
      }),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(result.totals.warningCount).toBeGreaterThanOrEqual(1);
    expect(result.arrangements[0].warnings.some((w) => w.includes("REC_CUSTOM_THING"))).toBe(true);
  });

  it("throws (per-arrangement) when entity resolver returns empty", async () => {
    const { prisma } = makeMockPrisma();
    const result = await importFromNsRevenue(prisma, {
      export: makeExport(),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "", // empty → throw
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/LegalEntity/);
    expect(result.errors[0].message).toMatch(/bootstrapped/);
    expect(result.totals.arrangementsCreated).toBe(0);
  });

  it("throws (per-arrangement) when customer resolver returns empty", async () => {
    const { prisma } = makeMockPrisma();
    const result = await importFromNsRevenue(prisma, {
      export: makeExport(),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "", // empty → throw
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/Customer not resolvable/);
    expect(result.totals.arrangementsCreated).toBe(0);
  });

  it("handles a multi-element arrangement (writes all POs in one transaction)", async () => {
    const { prisma, state } = makeMockPrisma();
    const arrangement = makeArrangement({
      transaction_price: 22000,
      elements: [
        makeElement({
          line_internal_id: "ele-1",
          sequence_no: 1,
          ssp: 12000,
          allocated_amount: 12000,
        }),
        makeElement({
          line_internal_id: "ele-2",
          sequence_no: 2,
          description: "Implementation",
          ssp: 10000,
          allocated_amount: 10000,
        }),
      ],
    });

    const result = await importFromNsRevenue(prisma, {
      export: makeExport({ arrangements: [arrangement] }),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(result.arrangements[0].obligationsCreated).toBe(2);
    expect(state.createdObligationCount).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // one tx per arrangement
  });

  it("counts totals across multiple arrangements (some new, some duplicate, some errored)", async () => {
    const { prisma } = makeMockPrisma({
      existingContracts: new Map([["ra-dup", "contract-existing"]]),
    });

    const arrangements: NsRevenueArrangement[] = [
      makeArrangement({ internalid: "ra-new-1", tranid: "RA-N1" }),
      makeArrangement({ internalid: "ra-dup", tranid: "RA-DUP" }),
      makeArrangement({
        internalid: "ra-err",
        tranid: "RA-ERR",
        subsidiary: { internalid: "missing-sub" }, // entity resolver will return empty
      }),
      makeArrangement({ internalid: "ra-new-2", tranid: "RA-N2" }),
    ];

    const result = await importFromNsRevenue(prisma, {
      export: makeExport({ arrangements }),
      tenantId: "tenant-test-1",
      resolveEntityId: async ({ nsSubsidiaryInternalId }) =>
        nsSubsidiaryInternalId === "missing-sub" ? "" : "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(result.totals.arrangementsProcessed).toBe(4);
    expect(result.totals.arrangementsCreated).toBe(2);
    expect(result.totals.arrangementsSkipped).toBe(1);
    expect(result.totals.arrangementsErrored).toBe(1);
    expect(result.errors[0].nsArrangementTranid).toBe("RA-ERR");
  });

  it("writes mapped PO data with the new ASC 606 fields populated", async () => {
    const { prisma, state } = makeMockPrisma();
    const arrangement = makeArrangement({
      elements: [
        makeElement({
          ssp: 12000,
          allocated_amount: 9500, // divergent → non-null in DB
          allocation_method: "RESIDUAL",
          fair_value_method: "ESP",
          quantity: 1,
        }),
      ],
    });

    await importFromNsRevenue(prisma, {
      export: makeExport({ arrangements: [arrangement] }),
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    expect(state.capturedPoData).toHaveLength(1);
    const po = state.capturedPoData[0] as {
      allocatedAmount: string | null;
      allocationMethod: string | null;
      fairValueMethod: string | null;
      quantity: string;
    };
    expect(po.allocatedAmount).toBe("9500.0000");
    expect(po.allocationMethod).toBe("RESIDUAL");
    expect(po.fairValueMethod).toBe("ESP");
    expect(po.quantity).toBe("1.0000");
  });

  it("emits null allocatedAmount when SSP == allocated_amount (back-compat path)", async () => {
    const { prisma, state } = makeMockPrisma();
    await importFromNsRevenue(prisma, {
      export: makeExport(), // default: ssp=12000, allocated=12000
      tenantId: "tenant-test-1",
      resolveEntityId: async () => "entity-1",
      resolveCustomerPartyId: async () => "party-1",
    });

    const po = state.capturedPoData[0] as { allocatedAmount: string | null };
    expect(po.allocatedAmount).toBeNull();
  });
});
