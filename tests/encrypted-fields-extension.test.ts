// Real-DB roundtrip test for the revenue-rec encrypted-fields extension.
// Confidentiality TSC.
//
// Five columns in the registry:
//   - RevenueContract.description (String)
//   - RevenueContract.sourcePayload (Json)
//   - AiExtractionSuggestion.obligationsJson (Json)
//   - AiExtractionSuggestion.allocationJson (Json)
//   - AiExtractionSuggestion.variableConsiderationJson (Json)
//   - Party.displayName (READ side; ledger-core owns the write path)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { looksEncrypted } from "@/lib/soc2/field-encryption";

const rawPrisma = new PrismaClient();
const SUFFIX = randomBytes(4).toString("hex");

beforeAll(async () => {
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { _setKeyForTesting } = await import("@/lib/soc2/field-encryption");
  _setKeyForTesting(null);

  const entity = await rawPrisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    throw new Error(
      "NORTHWIND entity not found. Run pnpm db:seed in ledger-core first."
    );
  }
});

afterAll(async () => {
  // AI extraction suggestions FK-cascade off RevenueContract, but we
  // delete explicitly first to avoid the cascade chain. Match by the
  // SUFFIX-stamped modelName (plaintext analytics column).
  await rawPrisma.aiExtractionSuggestion.deleteMany({
    where: { modelName: { contains: SUFFIX } },
  });
  await rawPrisma.revenueContract.deleteMany({
    where: { code: { contains: SUFFIX } },
  });
  await rawPrisma.party.deleteMany({
    where: { code: { contains: SUFFIX } },
  });
  await rawPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// RevenueContract.description (String) + sourcePayload (Json)
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: RevenueContract (Confidentiality TSC)", () => {
  let contractId: string;
  let contractCode: string;
  let customerPartyId: string;
  const plaintextDescription = `Acme Corp 3-year SaaS subscription, Tier B with API access (${SUFFIX})`;
  const plaintextSourcePayload = {
    qboInvoiceId: `INV-${SUFFIX}`,
    customer: { value: "1234", name: `Acme Corp ${SUFFIX}` },
    lines: [
      { lineNum: 1, description: "Subscription Tier B", amount: 36000.0 },
      { lineNum: 2, description: "Implementation services", amount: 4000.0 },
    ],
    notes: "Negotiated 10% discount — see CRM thread",
  };

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const entity = await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: "NORTHWIND" },
      select: { id: true, tenantId: true },
    });
    const perTest = randomBytes(2).toString("hex");
    // Throwaway customer Party — revenue-rec's Party schema mirror
    // doesn't expose tenantId (same gap recon+fa-amort had). Use
    // raw SQL to populate the tenantId column.
    const tenantRow = await rawPrisma.tenant.findFirstOrThrow({
      select: { id: true },
    });
    const partyCode = `ENC-RR-PARTY-${SUFFIX}-${perTest}`;
    const partyRows = await rawPrisma.$queryRaw<{ id: string }[]>`
      INSERT INTO party (id, "tenantId", "entityId", code, "displayName", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantRow.id}::uuid, ${entity.id}::uuid, ${partyCode}, ${`Customer ${SUFFIX}`}, NOW(), NOW())
      RETURNING id::text
    `;
    customerPartyId = partyRows[0].id;
    contractCode = `ENC-RC-${SUFFIX}-${perTest}`;
    const created = await prisma.revenueContract.create({
      data: {
        tenantId: entity.tenantId,
        entityId: entity.id,
        code: contractCode,
        description: plaintextDescription,
        customerPartyId,
        contractStartDate: new Date("2026-01-01"),
        contractEndDate: new Date("2028-12-31"),
        totalContractValue: "40000.0000",
        currencyId: "USD",
        sourcePayload: plaintextSourcePayload,
      },
    });
    contractId = created.id;
  });

  it("on-disk RevenueContract.description is ciphertext (raw probe)", async () => {
    const raw = await rawPrisma.revenueContract.findUnique({
      where: { id: contractId },
      select: { description: true, code: true },
    });
    expect(raw?.description).not.toBe(plaintextDescription);
    expect(looksEncrypted(raw?.description)).toBe(true);
    // code stays plaintext — lookup key.
    expect(raw?.code).toBe(contractCode);
  });

  it("on-disk RevenueContract.sourcePayload is a STRING (ciphertext envelope), not the original object", async () => {
    const raw = await rawPrisma.revenueContract.findUnique({
      where: { id: contractId },
      select: { sourcePayload: true },
    });
    expect(typeof raw?.sourcePayload).toBe("string");
    expect(looksEncrypted(raw?.sourcePayload as string)).toBe(true);
    const rawStr = String(raw?.sourcePayload ?? "");
    expect(rawStr).not.toContain("Acme");
    expect(rawStr).not.toContain(SUFFIX);
  });

  it("app surface decrypts description AND sourcePayload on read", async () => {
    const { prisma } = await import("@/lib/db");
    const c = await prisma.revenueContract.findUnique({
      where: { id: contractId },
      select: { description: true, sourcePayload: true, code: true },
    });
    expect(c?.description).toBe(plaintextDescription);
    expect(c?.sourcePayload).toEqual(plaintextSourcePayload);
    expect(c?.code).toBe(contractCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AiExtractionSuggestion.{obligationsJson, allocationJson,
// variableConsiderationJson} — three Json columns
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: AiExtractionSuggestion (Json mode, Confidentiality TSC)", () => {
  let suggestionId: string;
  let aiContractId: string;
  let aiPartyId: string;
  const modelName = `claude-opus-4-7-test-${SUFFIX}`;
  const plaintextObligations = [
    {
      description: `Acme Corp SaaS subscription — Tier B (${SUFFIX})`,
      ssp: 36000,
      recognitionPattern: "OVER_TIME_STRAIGHT",
      startDate: "2026-01-01",
      endDate: "2028-12-31",
      rationale: "Standalone selling price benchmarked against published list price",
    },
    {
      description: "Implementation services",
      ssp: 4000,
      recognitionPattern: "POINT_IN_TIME",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      rationale: "One-time deliverable",
    },
  ];
  const plaintextAllocation = {
    method: "RELATIVE_SSP",
    notes: "Even allocation — discount applied uniformly",
  };
  const plaintextVc = [
    {
      description: "Performance bonus",
      method: "EXPECTED_VALUE",
      direction: "INCREASE",
      unconstrained: 5000,
      constrained: 3500,
      rationale: "Three scenarios — 60% base, 30% upside, 10% downside",
    },
  ];

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const entity = await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: "NORTHWIND" },
      select: { id: true },
    });
    const perTest = randomBytes(2).toString("hex");
    const tenantRow = await rawPrisma.tenant.findFirstOrThrow({
      select: { id: true },
    });
    const partyCode = `ENC-RR-PARTY-${SUFFIX}-${perTest}-ai`;
    const partyRows = await rawPrisma.$queryRaw<{ id: string }[]>`
      INSERT INTO party (id, "tenantId", "entityId", code, "displayName", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantRow.id}::uuid, ${entity.id}::uuid, ${partyCode}, ${`Customer AI ${SUFFIX}`}, NOW(), NOW())
      RETURNING id::text
    `;
    aiPartyId = partyRows[0].id;
    const tenantId2 = (await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: "NORTHWIND" },
      select: { tenantId: true },
    })).tenantId;
    const contract = await prisma.revenueContract.create({
      data: {
        tenantId: tenantId2,
        entityId: entity.id,
        code: `ENC-RC-${SUFFIX}-${perTest}-ai`,
        description: `AI extraction anchor contract ${SUFFIX}`,
        customerPartyId: aiPartyId,
        contractStartDate: new Date("2026-01-01"),
        totalContractValue: "40000.0000",
        currencyId: "USD",
      },
    });
    aiContractId = contract.id;
    const created = await prisma.aiExtractionSuggestion.create({
      data: {
        contractId: aiContractId,
        obligationsJson: plaintextObligations as unknown as object,
        allocationJson: plaintextAllocation as unknown as object,
        variableConsiderationJson: plaintextVc as unknown as object,
        modelName,
      },
    });
    suggestionId = created.id;
  });

  it("on-disk obligationsJson + allocationJson + variableConsiderationJson are ciphertext envelopes", async () => {
    const raw = await rawPrisma.aiExtractionSuggestion.findUnique({
      where: { id: suggestionId },
      select: {
        obligationsJson: true,
        allocationJson: true,
        variableConsiderationJson: true,
        modelName: true,
      },
    });
    for (const field of [
      "obligationsJson",
      "allocationJson",
      "variableConsiderationJson",
    ] as const) {
      const v = raw?.[field];
      expect(typeof v).toBe("string");
      expect(looksEncrypted(v as string)).toBe(true);
      expect(String(v)).not.toContain("Acme");
      expect(String(v)).not.toContain(SUFFIX);
    }
    expect(raw?.modelName).toBe(modelName);
  });

  it("app surface decrypts all three Json columns back into the exact original shapes", async () => {
    const { prisma } = await import("@/lib/db");
    const s = await prisma.aiExtractionSuggestion.findUnique({
      where: { id: suggestionId },
      select: {
        obligationsJson: true,
        allocationJson: true,
        variableConsiderationJson: true,
      },
    });
    expect(s?.obligationsJson).toEqual(plaintextObligations);
    expect(s?.allocationJson).toEqual(plaintextAllocation);
    expect(s?.variableConsiderationJson).toEqual(plaintextVc);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Party.displayName — READ side (revenue-rec joins via
// RevenueContract.customer)
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Party READ side (Confidentiality TSC)", () => {
  let partyId: string;
  let partyCode: string;
  const plaintextDisplayName = `Vendor Acme Corp ${SUFFIX}`;

  beforeEach(async () => {
    partyCode = `ENC-RR-PARTY-READ-${SUFFIX}-${randomBytes(2).toString("hex")}`;
    const entity = await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: "NORTHWIND" },
      select: { id: true },
    });
    const { encryptField } = await import("@/lib/soc2/field-encryption");
    const ct = encryptField(plaintextDisplayName);
    if (!ct) throw new Error("encryptField returned null");
    const tenantRow = await rawPrisma.tenant.findFirstOrThrow({
      select: { id: true },
    });
    const rows = await rawPrisma.$queryRaw<{ id: string }[]>`
      INSERT INTO party (id, "tenantId", "entityId", code, "displayName", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantRow.id}::uuid, ${entity.id}::uuid, ${partyCode}, ${ct}, NOW(), NOW())
      RETURNING id::text
    `;
    partyId = rows[0].id;
  });

  it("on-disk Party.displayName is ciphertext (raw probe)", async () => {
    const raw = await rawPrisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(raw?.displayName).not.toBe(plaintextDisplayName);
    expect(looksEncrypted(raw?.displayName)).toBe(true);
    expect(raw?.code).toBe(partyCode);
  });

  it("revenue-rec's customer.displayName join path sees plaintext", async () => {
    const { prisma } = await import("@/lib/db");
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(party?.displayName).toBe(plaintextDisplayName);
    expect(party?.code).toBe(partyCode);
  });
});
