// Unit tests for the importNsRevenueAction Server Action.
//
// Mocks the auth/session helpers + prisma so the suite runs without a
// live DB. Integration coverage (real Postgres) lands in the e2e
// smoke test or a follow-up integration suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_USER_ID = "user-1";
const FAKE_TENANT_ID = "tenant-1";

// Mock next/cache so revalidatePath is a no-op outside a Next request.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Mock the auth/session module — happy path returns user + tenant;
// override per-test for error cases.
const requireCurrentUser = vi.fn(async () => ({
  id: FAKE_USER_ID,
  email: "test@example.test",
  displayName: "Test",
}));
const requireCurrentTenant = vi.fn(async () => ({
  id: FAKE_TENANT_ID,
  slug: "test-tenant",
  name: "Test Tenant",
  role: "OWNER",
}));

class FakeNotAuthenticatedError extends Error {}
class FakeNoTenantSelectedError extends Error {}

vi.mock("@/lib/auth/session", () => ({
  requireCurrentUser: () => requireCurrentUser(),
  requireCurrentTenant: () => requireCurrentTenant(),
  NotAuthenticatedError: FakeNotAuthenticatedError,
  NoTenantSelectedError: FakeNoTenantSelectedError,
}));

// Mock Prisma client + the orchestrator. The Server Action's logic
// (parse + validate + build resolvers + call orchestrator + format
// summary) is what we're testing, not the orchestrator itself.
interface MockPrisma {
  legalEntity: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  party: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

const makeMockPrisma = (
  overrides: {
    entity?: { id: string } | null;
    existingParty?: { id: string } | null;
    createPartyReturns?: { id: string };
  } = {}
): MockPrisma => ({
  legalEntity: {
    findFirst: vi
      .fn()
      .mockResolvedValue(overrides.entity ?? { id: "entity-1" }),
  },
  party: {
    findFirst: vi.fn().mockResolvedValue(overrides.existingParty ?? null),
    create: vi
      .fn()
      .mockResolvedValue(overrides.createPartyReturns ?? { id: "party-new-1" }),
  },
});

let mockPrisma: MockPrisma;
vi.mock("@/lib/db", () => ({
  get prisma() {
    return mockPrisma;
  },
}));

const importFromNsRevenue = vi.fn();
vi.mock("@/lib/mappers/netsuite", () => ({
  importFromNsRevenue: (...args: unknown[]) => importFromNsRevenue(...args),
}));

const VALID_BUNDLE_JSON = JSON.stringify({
  exported_at: "2026-06-05T00:00:00Z",
  account_id: "ns-acct-1",
  recognition_templates: [
    { internalid: "tpl-1", name: "Even", rec_method: "REC_EVEN_USING_DATES" },
  ],
  arrangements: [
    {
      internalid: "ra-1",
      tranid: "RA-001",
      subsidiary: { internalid: "sub-1" },
      customer: { internalid: "cust-1" },
      currency: "USD",
      accounting_standard: "ASC_606",
      arrangement_date: "2026-01-01",
      transaction_price: 12000,
      elements: [],
    },
  ],
});

describe("importNsRevenueAction", () => {
  beforeEach(() => {
    mockPrisma = makeMockPrisma();
    requireCurrentUser.mockResolvedValue({
      id: FAKE_USER_ID,
      email: "test@example.test",
      displayName: "Test",
    });
    requireCurrentTenant.mockResolvedValue({
      id: FAKE_TENANT_ID,
      slug: "test-tenant",
      name: "Test Tenant",
      role: "OWNER",
    });
    importFromNsRevenue.mockResolvedValue({
      arrangements: [
        {
          nsArrangementInternalId: "ra-1",
          nsArrangementTranid: "RA-001",
          contractId: "contract-1",
          wasDuplicate: false,
          obligationsCreated: 1,
          warnings: [],
        },
      ],
      errors: [],
      totals: {
        arrangementsProcessed: 1,
        arrangementsCreated: 1,
        arrangementsSkipped: 0,
        arrangementsErrored: 0,
        obligationsCreated: 1,
        warningCount: 0,
      },
    });
  });

  afterEach(() => {
    importFromNsRevenue.mockReset();
  });

  it("happy path — parses bundle, calls orchestrator, returns formatted summary", async () => {
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    const state = await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    expect(state.ok).toBe(true);
    expect(state.message).toContain("1 arrangement");
    expect(state.message).toContain("1 created");
    expect(state.message).toContain("0 errored");
    expect(state.result?.totals.arrangementsCreated).toBe(1);
    expect(importFromNsRevenue).toHaveBeenCalledTimes(1);

    // Verify the orchestrator received session-bound tenantId.
    const passedInput = importFromNsRevenue.mock.calls[0][1];
    expect(passedInput.tenantId).toBe(FAKE_TENANT_ID);
  });

  it("returns 400-style state when bundleJson is not valid JSON", async () => {
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    const state = await importNsRevenueAction({ bundleJson: "{ not json" });

    expect(state.ok).toBe(false);
    expect(state.message).toContain("parse");
    expect(importFromNsRevenue).not.toHaveBeenCalled();
  });

  it("returns 400-style state when bundle is missing required top-level fields", async () => {
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    const state = await importNsRevenueAction({
      bundleJson: JSON.stringify({ exported_at: "x" }), // missing arrangements + templates
    });

    expect(state.ok).toBe(false);
    expect(state.message).toContain("missing required");
    expect(importFromNsRevenue).not.toHaveBeenCalled();
  });

  it("rejects when user is not authenticated", async () => {
    requireCurrentUser.mockRejectedValueOnce(new FakeNotAuthenticatedError());
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    const state = await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    expect(state.ok).toBe(false);
    expect(state.message).toBe("Not authenticated.");
    expect(importFromNsRevenue).not.toHaveBeenCalled();
  });

  it("rejects when no tenant is selected", async () => {
    requireCurrentTenant.mockRejectedValueOnce(new FakeNoTenantSelectedError());
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    const state = await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    expect(state.ok).toBe(false);
    expect(state.message).toBe("No tenant selected.");
    expect(importFromNsRevenue).not.toHaveBeenCalled();
  });

  it("entity resolver uses default NSSUB-{internalid} when no map provided", async () => {
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRevenue.mock.calls[0][1];
    const resolveEntity = passedInput.resolveEntityId;
    await resolveEntity({ nsSubsidiaryInternalId: "sub-99" });

    // The fake mock returns { id: "entity-1" } unconditionally, but we
    // care about which code was searched. Check the findFirst args.
    expect(mockPrisma.legalEntity.findFirst).toHaveBeenCalledWith({
      where: { code: "NSSUB-sub-99", tenantId: FAKE_TENANT_ID },
      select: { id: true },
    });
  });

  it("entity resolver uses caller-provided map when available", async () => {
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    await importNsRevenueAction({
      bundleJson: VALID_BUNDLE_JSON,
      subsidiaryEntityCodeMap: { "sub-1": "CUSTOM_ENTITY_CODE" },
    });

    const passedInput = importFromNsRevenue.mock.calls[0][1];
    const resolveEntity = passedInput.resolveEntityId;
    await resolveEntity({ nsSubsidiaryInternalId: "sub-1" });

    expect(mockPrisma.legalEntity.findFirst).toHaveBeenCalledWith({
      where: { code: "CUSTOM_ENTITY_CODE", tenantId: FAKE_TENANT_ID },
      select: { id: true },
    });
  });

  it("customer resolver returns existing party id (idempotency — no duplicate create)", async () => {
    mockPrisma = makeMockPrisma({ existingParty: { id: "party-existing" } });
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRevenue.mock.calls[0][1];
    const result = await passedInput.resolveCustomerPartyId({
      nsCustomerInternalId: "cust-1",
      nsCustomerName: "Initech",
    });
    expect(result).toBe("party-existing");
    expect(mockPrisma.party.create).not.toHaveBeenCalled();
  });

  it("customer resolver creates new party with NS-CUST-{internalid} code when none exists", async () => {
    mockPrisma = makeMockPrisma({
      existingParty: null,
      createPartyReturns: { id: "party-new-99" },
    });
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRevenue.mock.calls[0][1];
    const result = await passedInput.resolveCustomerPartyId({
      nsCustomerInternalId: "cust-99",
      nsCustomerName: "New Company",
    });
    expect(result).toBe("party-new-99");
    expect(mockPrisma.party.create).toHaveBeenCalledWith({
      data: {
        tenantId: FAKE_TENANT_ID,
        entityId: "entity-1", // fallback entity
        code: "NS-CUST-cust-99",
        displayName: "New Company",
      },
      select: { id: true },
    });
  });

  it("customer resolver falls back to 'NS Customer {id}' when name is missing", async () => {
    mockPrisma = makeMockPrisma({ existingParty: null });
    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    const passedInput = importFromNsRevenue.mock.calls[0][1];
    await passedInput.resolveCustomerPartyId({
      nsCustomerInternalId: "cust-no-name",
    });
    expect(mockPrisma.party.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: "NS Customer cust-no-name",
      }),
      select: { id: true },
    });
  });

  it("returns the orchestrator's full result on the state for UI rendering", async () => {
    importFromNsRevenue.mockResolvedValueOnce({
      arrangements: [
        {
          nsArrangementInternalId: "ra-1",
          nsArrangementTranid: "RA-001",
          contractId: "contract-1",
          wasDuplicate: false,
          obligationsCreated: 2,
          warnings: ["Unmapped NS rec_method"],
        },
      ],
      errors: [
        {
          nsArrangementInternalId: "ra-bad",
          nsArrangementTranid: "RA-BAD",
          message: "Customer not resolvable",
        },
      ],
      totals: {
        arrangementsProcessed: 2,
        arrangementsCreated: 1,
        arrangementsSkipped: 0,
        arrangementsErrored: 1,
        obligationsCreated: 2,
        warningCount: 1,
      },
    });

    const { importNsRevenueAction } = await import(
      "../src/app/actions/import-ns-revenue"
    );
    const state = await importNsRevenueAction({ bundleJson: VALID_BUNDLE_JSON });

    expect(state.ok).toBe(true);
    expect(state.result?.arrangements).toHaveLength(1);
    expect(state.result?.errors).toHaveLength(1);
    expect(state.message).toContain("1 created");
    expect(state.message).toContain("1 errored");
    expect(state.message).toContain("1 warning");
  });
});
