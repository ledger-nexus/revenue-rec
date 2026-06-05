// Integration tests for revenueRecAttribution against real Postgres.
//
// Hybrid implementation. The TWO wired counts
// (contractDocumentsUploaded + recognitionSchedulesApproved) get
// exercised against real rows; the THREE schema-gap counts
// (revenueContractsCreated, aiExtractionsAccepted, aiExtractionsRejected)
// are asserted to be exactly zero regardless of seeded data.
//
// Cleanup: every row is namespaced via a per-test-suite SUFFIX and
// cleaned up by `RevenueContract.code` startsWith match (which
// cascades to PerformanceObligation, ContractDocument, etc.).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Sentinel UUIDs stable across runs so cleanup works after a crash.
const TEST_SUBJECT_ID = "55555555-aaaa-bbbb-cccc-dddddddd0001";
const OTHER_SUBJECT_ID = "66666666-aaaa-bbbb-cccc-dddddddd0002";

const SUFFIX = "rr" + Date.now().toString(36);

let entityId: string;
let customerPartyId: string;
let postedEntryId: string;
let tenantId: string;

async function cleanup() {
  // Contracts cascade-delete PerformanceObligation, ContractDocument,
  // AiExtractionSuggestion, RecognitionSchedule, RecognitionEvent,
  // and RevenueContractBookAttributes via onDelete: Cascade.
  await prisma.revenueContract.deleteMany({
    where: { code: { startsWith: `DSR-RR-${SUFFIX}` } },
  });
  // We reuse an existing Party for the customer — no party cleanup
  // needed.
}

beforeAll(async () => {
  await cleanup();

  // Reuse NORTHWIND entity. Don't own the tenant chain.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run `pnpm db:seed` in ledger-core first."
    );
  }
  entityId = entity.id;

  // Need ANY existing JournalEntry id to use as RecognitionEvent.postedEntryId.
  const someEntry = await prisma.journalEntry.findFirst({
    select: { id: true },
  });
  if (!someEntry) {
    throw new Error("No JournalEntry found. Run `pnpm db:seed` in ledger-core.");
  }
  postedEntryId = someEntry.id;

  // Reuse any existing Party as the customer FK target. Party requires
  // tenantId (the schema mirror omits it but the DB enforces it), so
  // creating a throwaway party would require resolving a tenant chain
  // we don't own. Any party will do — the test asserts nothing about it.
  const someParty = await prisma.party.findFirst({ select: { id: true } });
  if (!someParty) {
    throw new Error("No Party found. Run `pnpm db:seed` in ledger-core first.");
  }
  customerPartyId = someParty.id;

  // RevenueContract ALSO carries tenantId in the DB (the schema mirror
  // here omits the column per "additive only" mirror discipline). We
  // resolve it from the existing LegalEntity row. Note: ledger-core's
  // SQL DDL uses camelCase column names (quoted), not snake_case.
  const entityRow = await prisma.$queryRaw<
    { tenantId: string }[]
  >`SELECT "tenantId"::text as "tenantId" FROM legal_entity WHERE id = ${entityId}::uuid LIMIT 1`;
  if (!entityRow[0]?.tenantId) {
    throw new Error("NORTHWIND entity has no tenantId — DB schema unexpected.");
  }
  tenantId = entityRow[0].tenantId;
});

/**
 * Create a RevenueContract with tenantId set (which the Prisma schema
 * mirror omits but the DB enforces). Returns the new contract id.
 */
async function createContract(args: {
  code: string;
  description: string;
  contractStartDate: Date;
  totalContractValue: string;
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO revenue_contract (
      id, "tenantId", "entityId", code, description, "customerPartyId",
      "contractStartDate", "totalContractValue", "currencyId", status,
      "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), ${tenantId}::uuid, ${entityId}::uuid,
      ${args.code}, ${args.description}, ${customerPartyId}::uuid,
      ${args.contractStartDate}::date, ${args.totalContractValue}::decimal,
      'USD', 'ACTIVE', now(), now()
    )
    RETURNING id::text
  `;
  return rows[0].id;
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("revenueRecAttribution — integration vs real Postgres", () => {
  it("returns empty-but-valid shape for a user with no revenue-rec activity", async () => {
    const { revenueRecAttribution } = await import(
      "../src/lib/privacy/rr-attribution"
    );
    const result = await revenueRecAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.contractDocumentsUploaded).toBe(0);
    expect(result.recognitionSchedulesApproved).toBe(0);
    // Schema gaps — always zero regardless of seeded data.
    expect(result.revenueContractsCreated).toBe(0);
    expect(result.aiExtractionsAccepted).toBe(0);
    expect(result.aiExtractionsRejected).toBe(0);
    expect(result.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts contract documents the subject uploaded", async () => {
    // Spin up 2 contracts + 2 documents owned by TEST_SUBJECT.
    const contract1Id = await createContract({
      code: `DSR-RR-${SUFFIX}-A`,
      description: "DSR test contract A",
      contractStartDate: new Date("2026-01-01"),
      totalContractValue: "12000.0000",
    });
    await prisma.contractDocument.create({
      data: {
        contractId: contract1Id,
        rawText: "SENSITIVE COUNTERPARTY PII — should never appear in DSR export",
        format: "TEXT",
        uploadedBy: TEST_SUBJECT_ID,
      },
    });

    const contract2Id = await createContract({
      code: `DSR-RR-${SUFFIX}-B`,
      description: "DSR test contract B",
      contractStartDate: new Date("2026-02-01"),
      totalContractValue: "24000.0000",
    });
    await prisma.contractDocument.create({
      data: {
        contractId: contract2Id,
        rawText: "Another contract body with signatories",
        format: "TEXT",
        uploadedBy: TEST_SUBJECT_ID,
      },
    });

    const { revenueRecAttribution } = await import(
      "../src/lib/privacy/rr-attribution"
    );
    const result = await revenueRecAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.contractDocumentsUploaded).toBe(2);
  });

  it("counts recognition events the subject posted", async () => {
    // Reuse contract A; add a PerformanceObligation + 3 RecognitionEvents.
    const contract = await prisma.revenueContract.findFirstOrThrow({
      where: { code: `DSR-RR-${SUFFIX}-A` },
    });
    const obligation = await prisma.performanceObligation.create({
      data: {
        contractId: contract.id,
        sequenceNo: 1,
        description: "Annual SaaS subscription",
        ssp: "12000.0000",
        recognitionPattern: "OVER_TIME_STRAIGHT",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        revenueAccountCode: "4000",
        deferredAccountCode: "2300",
      },
    });

    // Two events posted by TEST_SUBJECT, one without a postedBy.
    await prisma.recognitionEvent.createMany({
      data: [
        {
          contractId: contract.id,
          obligationId: obligation.id,
          bookCode: "US_GAAP",
          periodStart: new Date("2026-01-01"),
          periodEnd: new Date("2026-01-31"),
          amount: "1000.0000",
          postedEntryId,
          entryNumber: `DSR-${SUFFIX}-1`,
          postedBy: TEST_SUBJECT_ID,
        },
        {
          contractId: contract.id,
          obligationId: obligation.id,
          bookCode: "US_GAAP",
          periodStart: new Date("2026-02-01"),
          periodEnd: new Date("2026-02-28"),
          amount: "1000.0000",
          postedEntryId,
          entryNumber: `DSR-${SUFFIX}-2`,
          postedBy: TEST_SUBJECT_ID,
        },
        {
          contractId: contract.id,
          obligationId: obligation.id,
          bookCode: "US_GAAP",
          periodStart: new Date("2026-03-01"),
          periodEnd: new Date("2026-03-31"),
          amount: "1000.0000",
          postedEntryId,
          entryNumber: `DSR-${SUFFIX}-3`,
          postedBy: null,
        },
      ],
    });

    const { revenueRecAttribution } = await import(
      "../src/lib/privacy/rr-attribution"
    );
    const result = await revenueRecAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.recognitionSchedulesApproved).toBe(2);
    expect(result.contractDocumentsUploaded).toBe(2); // unchanged
  });

  it("does not leak the other user's activity (cross-subject isolation)", async () => {
    // Create activity owned by OTHER_SUBJECT.
    const otherContractId = await createContract({
      code: `DSR-RR-${SUFFIX}-OTHER`,
      description: "Other user contract",
      contractStartDate: new Date("2026-04-01"),
      totalContractValue: "5000.0000",
    });
    await prisma.contractDocument.create({
      data: {
        contractId: otherContractId,
        rawText: "Other user's contract body",
        format: "TEXT",
        uploadedBy: OTHER_SUBJECT_ID,
      },
    });
    const obligation = await prisma.performanceObligation.create({
      data: {
        contractId: otherContractId,
        sequenceNo: 1,
        description: "Other obligation",
        ssp: "5000.0000",
        recognitionPattern: "POINT_IN_TIME",
        startDate: new Date("2026-04-01"),
        revenueAccountCode: "4000",
        deferredAccountCode: "2300",
      },
    });
    await prisma.recognitionEvent.create({
      data: {
        contractId: otherContractId,
        obligationId: obligation.id,
        bookCode: "US_GAAP",
        periodStart: new Date("2026-04-01"),
        periodEnd: new Date("2026-04-30"),
        amount: "5000.0000",
        postedEntryId,
        entryNumber: `DSR-${SUFFIX}-OTHER`,
        postedBy: OTHER_SUBJECT_ID,
      },
    });

    const { revenueRecAttribution } = await import(
      "../src/lib/privacy/rr-attribution"
    );
    const testResult = await revenueRecAttribution(prisma, TEST_SUBJECT_ID);
    const otherResult = await revenueRecAttribution(prisma, OTHER_SUBJECT_ID);

    // TEST_SUBJECT counts unchanged.
    expect(testResult.contractDocumentsUploaded).toBe(2);
    expect(testResult.recognitionSchedulesApproved).toBe(2);

    // OTHER_SUBJECT sees only its own.
    expect(otherResult.contractDocumentsUploaded).toBe(1);
    expect(otherResult.recognitionSchedulesApproved).toBe(1);
  });

  it("schema-gap fields stay zero even with seeded data (honest-gap enforcement)", async () => {
    // Even with contracts + AiExtractionSuggestions present, the three
    // gap fields must be exactly zero. If a future PR wires them, this
    // test will fail and force the contract to be re-documented.
    const contract = await prisma.revenueContract.findFirstOrThrow({
      where: { code: `DSR-RR-${SUFFIX}-A` },
    });
    await prisma.aiExtractionSuggestion.create({
      data: {
        contractId: contract.id,
        obligationsJson: { test: "data" },
        modelName: "claude-opus-4-7",
      },
    });

    const { revenueRecAttribution } = await import(
      "../src/lib/privacy/rr-attribution"
    );
    const result = await revenueRecAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.revenueContractsCreated).toBe(0);
    expect(result.aiExtractionsAccepted).toBe(0);
    expect(result.aiExtractionsRejected).toBe(0);
  });

  it("HARD INVARIANT: returned object contains no rawText / counterparty PII", async () => {
    // Defense-in-depth: the seeded ContractDocument.rawText contained
    // "SENSITIVE COUNTERPARTY PII". The JSON-serialized result must
    // not contain ANY substring of it.
    const { revenueRecAttribution } = await import(
      "../src/lib/privacy/rr-attribution"
    );
    const result = await revenueRecAttribution(prisma, TEST_SUBJECT_ID);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("SENSITIVE");
    expect(serialized).not.toContain("COUNTERPARTY");
    expect(serialized).not.toContain("signatories");
    expect(serialized.toLowerCase()).not.toContain("rawtext");
    expect(serialized.toLowerCase()).not.toContain("description");
  });
});
