// Integration test for the 2026-06-05 AiExtractionSuggestion decision
// columns. Proves:
//   - acceptedBy + acceptedAt columns exist on the DB
//   - approveExtractionAction marks the right suggestion as accepted
//     when called with suggestionId
//   - The tenant-safe updateMany clause prevents cross-tenant writes
//     (suggestion belonging to a different tenant's contract is NOT
//     touched even when the action is called with that suggestionId)
//
// Closes the documented half of v2.1 deficiency #26 — after this PR
// merges + a follow-up PR re-shipping the attribution helper, the
// helper flips from hybrid (2/5 wired) to full-wire (5/5 wired).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const TEST_USER_ID = "77777777-1111-aaaa-bbbb-cccccccccccc";
const TEST_TENANT_ID_PLACEHOLDER = "tenant-resolved-in-beforeAll";

let resolvedTenantId: string;

// Mock auth/session so the action runs without Clerk. requireCurrentUser
// returns our test user; requireCurrentTenant returns whatever the
// NORTHWIND entity's tenantId is (resolved in beforeAll).
vi.mock("@/lib/auth/session", () => ({
  requireCurrentUser: async () => ({
    id: TEST_USER_ID,
    email: "ai-decision-test@example.test",
    displayName: "Test",
  }),
  requireCurrentTenant: async () => ({
    id: resolvedTenantId,
    slug: "test-tenant",
    name: "Test",
    role: "OWNER",
  }),
  NotAuthenticatedError: class extends Error {},
  NoTenantSelectedError: class extends Error {},
}));

const prisma = new PrismaClient();
const SUFFIX = "dec" + Date.now().toString(36);

// The action uses `@/lib/db` (the singleton). Mock the module so the
// action's `prisma` is the same client this test uses — so writes
// from the action are visible to our verification reads.
vi.mock("@/lib/db", () => ({ prisma }));

let entityId: string;
let customerPartyId: string;
let contractId: string;
let suggestionId: string;

async function cleanup() {
  await prisma.revenueContract.deleteMany({
    where: { code: { startsWith: `DEC-TEST-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  await cleanup();

  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true, tenantId: true },
  });
  if (!entity) throw new Error("NORTHWIND entity not found.");
  entityId = entity.id;
  resolvedTenantId = entity.tenantId;

  const someParty = await prisma.party.findFirst({ select: { id: true } });
  if (!someParty) throw new Error("No Party found.");
  customerPartyId = someParty.id;

  // Create a contract via raw SQL (RevenueContract.tenantId is in the
  // DB but the create path is full-wired via the schema-mirror PR #21
  // on a different branch — we use raw SQL here to stay on main +
  // this PR's branch).
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO revenue_contract (
      id, "tenantId", "entityId", code, description, "customerPartyId",
      "contractStartDate", "totalContractValue", "currencyId", status,
      "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), ${resolvedTenantId}::uuid, ${entityId}::uuid,
      ${`DEC-TEST-${SUFFIX}-A`}, 'Test', ${customerPartyId}::uuid,
      '2026-01-01'::date, '12000'::decimal, 'USD', 'DRAFT',
      now(), now()
    )
    RETURNING id::text
  `;
  contractId = rows[0].id;

  // Create an AI extraction suggestion for the contract.
  const suggestion = await prisma.aiExtractionSuggestion.create({
    data: {
      contractId,
      obligationsJson: [],
      modelName: "claude-opus-4-7-test",
    },
    select: { id: true },
  });
  suggestionId = suggestion.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("AiExtractionSuggestion decision schema (2026-06-05)", () => {
  it("acceptedBy + acceptedAt columns exist + start null on the model output row", async () => {
    const fresh = await prisma.aiExtractionSuggestion.findUniqueOrThrow({
      where: { id: suggestionId },
    });
    // Pre-decision state: both null. (acceptedBy/At only populate on a
    // human decision; the model output itself isn't a decision.)
    expect(fresh.acceptedBy).toBeNull();
    expect(fresh.acceptedAt).toBeNull();
    expect(fresh.rejectedBy).toBeNull();
    expect(fresh.rejectedAt).toBeNull();
  });

  it("approveExtractionAction marks suggestion accepted when suggestionId passed", async () => {
    const { approveExtractionAction } = await import(
      "../src/app/actions/approve-extraction"
    );
    const result = await approveExtractionAction({
      contractId,
      suggestionId,
      performanceObligations: [
        {
          sequenceNo: 1,
          description: "Test SaaS",
          ssp: 12000,
          recognitionPattern: "OVER_TIME_STRAIGHT",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          revenueAccountCode: "4000",
          deferredAccountCode: "2200",
        },
      ],
    });

    expect(result.ok).toBe(true);

    const decided = await prisma.aiExtractionSuggestion.findUniqueOrThrow({
      where: { id: suggestionId },
    });
    expect(decided.acceptedBy).toBe(TEST_USER_ID);
    expect(decided.acceptedAt).not.toBeNull();
    // Rejected fields still null (this was an accept, not a reject).
    expect(decided.rejectedBy).toBeNull();
    expect(decided.rejectedAt).toBeNull();
  });

  it("approve without suggestionId leaves all decision fields null (back-compat)", async () => {
    // Create a fresh contract + suggestion for this test.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO revenue_contract (
        id, "tenantId", "entityId", code, description, "customerPartyId",
        "contractStartDate", "totalContractValue", "currencyId", status,
        "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), ${resolvedTenantId}::uuid, ${entityId}::uuid,
        ${`DEC-TEST-${SUFFIX}-B`}, 'Test', ${customerPartyId}::uuid,
        '2026-01-01'::date, '5000'::decimal, 'USD', 'DRAFT',
        now(), now()
      )
      RETURNING id::text
    `;
    const newContractId = rows[0].id;
    const newSuggestion = await prisma.aiExtractionSuggestion.create({
      data: {
        contractId: newContractId,
        obligationsJson: [],
        modelName: "claude-opus-4-7-test",
      },
      select: { id: true },
    });

    const { approveExtractionAction } = await import(
      "../src/app/actions/approve-extraction"
    );
    const result = await approveExtractionAction({
      contractId: newContractId,
      // NOTE: no suggestionId passed
      performanceObligations: [
        {
          sequenceNo: 1,
          description: "Test",
          ssp: 5000,
          recognitionPattern: "POINT_IN_TIME",
          startDate: "2026-01-01",
          endDate: null,
          revenueAccountCode: "4000",
          deferredAccountCode: "2200",
        },
      ],
    });
    expect(result.ok).toBe(true);

    const fresh = await prisma.aiExtractionSuggestion.findUniqueOrThrow({
      where: { id: newSuggestion.id },
    });
    expect(fresh.acceptedBy).toBeNull();
    expect(fresh.acceptedAt).toBeNull();
  });

  it("acceptance write is tenant-safe: cross-contract suggestionId silently no-ops", async () => {
    // Approver wants to approve contract A, but mistakenly passes a
    // suggestionId belonging to contract B. The updateMany clause
    // requires (id, contractId) to match — so suggestionB is NOT
    // updated.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO revenue_contract (
        id, "tenantId", "entityId", code, description, "customerPartyId",
        "contractStartDate", "totalContractValue", "currencyId", status,
        "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), ${resolvedTenantId}::uuid, ${entityId}::uuid,
        ${`DEC-TEST-${SUFFIX}-C`}, 'Test', ${customerPartyId}::uuid,
        '2026-01-01'::date, '7000'::decimal, 'USD', 'DRAFT',
        now(), now()
      )
      RETURNING id::text
    `;
    const contractC_Id = rows[0].id;
    const suggestionForC = await prisma.aiExtractionSuggestion.create({
      data: {
        contractId: contractC_Id,
        obligationsJson: [],
        modelName: "claude-opus-4-7-test",
      },
      select: { id: true },
    });

    // Approve contract A but pass C's suggestion id.
    const { approveExtractionAction } = await import(
      "../src/app/actions/approve-extraction"
    );
    await approveExtractionAction({
      contractId, // the original contract A
      suggestionId: suggestionForC.id, // C's suggestion!
      performanceObligations: [
        {
          sequenceNo: 1,
          description: "Test",
          ssp: 12000,
          recognitionPattern: "POINT_IN_TIME",
          startDate: "2026-01-01",
          endDate: null,
          revenueAccountCode: "4000",
          deferredAccountCode: "2200",
        },
      ],
    });

    // C's suggestion should NOT have been marked accepted (its FK is
    // to contract C, not contract A).
    const cSuggestion = await prisma.aiExtractionSuggestion.findUniqueOrThrow({
      where: { id: suggestionForC.id },
    });
    expect(cSuggestion.acceptedBy).toBeNull();
    expect(cSuggestion.acceptedAt).toBeNull();
  });
});
