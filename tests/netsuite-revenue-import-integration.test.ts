// Integration test for the NetSuite revenue-arrangement orchestrator.
//
// Proves that the schema-mirror gap closure (tenantId on RevenueContract
// + Party) actually closes the runtime path that was previously
// blocked. Mirrors the cleanup pattern from rr-attribution-integration
// (suffix-namespaced, cascade-friendly).
//
// Requires DATABASE_URL + seeded NORTHWIND entity + at least one Party.
// CI's test job is DB-free, so the whole suite skips (not fails) when
// DATABASE_URL is absent — same pattern as recon's ignore-line suite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { importFromNsRevenue } from "../src/lib/mappers/netsuite";
import type { NsRevenueArrangement } from "../src/lib/mappers/netsuite";

const HAS_DB = !!process.env.DATABASE_URL;

const prisma = new PrismaClient();
const SUFFIX = "nsint" + Date.now().toString(36);

let tenantId: string;
let entityId: string;
let partyId: string;

async function cleanup() {
  // Cascade-delete: RevenueContract → PerformanceObligation, etc.
  await prisma.revenueContract.deleteMany({
    where: { code: { startsWith: `NS-RA-RA-NS-INT-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  const entity = await prisma.legalEntity.findFirst({
    where: { code: "NORTHWIND" },
    select: { id: true, tenantId: true },
  });
  if (!entity) {
    throw new Error("NORTHWIND entity not found. Run ledger-core's seed first.");
  }
  entityId = entity.id;
  tenantId = entity.tenantId;

  // Reuse any Party (just need a valid FK; resolver returns it).
  const someParty = await prisma.party.findFirst({ select: { id: true } });
  if (!someParty) {
    throw new Error("No Party found. Run `pnpm db:seed` first.");
  }
  partyId = someParty.id;
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

function makeArrangement(code: string): NsRevenueArrangement {
  return {
    internalid: `int-${code}`,
    tranid: `RA-NS-INT-${SUFFIX}-${code}`,
    subsidiary: { internalid: "sub-1", name: "Acme US" },
    customer: { internalid: "cust-42", name: "Initech LLC" },
    currency: "USD",
    accounting_standard: "ASC_606",
    arrangement_date: "2026-01-01",
    transaction_price: 12000,
    elements: [
      {
        line_internal_id: "ele-1",
        sequence_no: 1,
        item: { internalid: "item-saas" },
        description: "Annual SaaS",
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
      },
    ],
  };
}

describe.skipIf(!HAS_DB)("importFromNsRevenue — integration vs real Postgres", () => {
  it("creates a RevenueContract + PerformanceObligation row end-to-end (schema-mirror gap closed)", async () => {
    const arrangement = makeArrangement("A");

    const result = await importFromNsRevenue(prisma, {
      export: {
        exported_at: "2026-06-05T00:00:00Z",
        account_id: "ns-acct-1",
        recognition_templates: [
          {
            internalid: "tpl-100",
            name: "Even Across Dates",
            rec_method: "REC_EVEN_USING_DATES",
          },
        ],
        arrangements: [arrangement],
      },
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => partyId,
    });

    expect(result.totals.arrangementsCreated).toBe(1);
    expect(result.totals.obligationsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify the row landed with tenantId populated.
    const contractId = result.arrangements[0].contractId;
    const written = await prisma.revenueContract.findUniqueOrThrow({
      where: { id: contractId },
      include: { performanceObligations: true },
    });
    expect(written.tenantId).toBe(tenantId);
    expect(written.entityId).toBe(entityId);
    expect(written.customerPartyId).toBe(partyId);
    expect(written.performanceObligations).toHaveLength(1);
    expect(written.performanceObligations[0].sequenceNo).toBe(1);
  });

  it("is idempotent (re-importing the same arrangement returns wasDuplicate)", async () => {
    const arrangement = makeArrangement("B");
    const exportBundle = {
      exported_at: "2026-06-05T00:00:00Z",
      account_id: "ns-acct-1",
      recognition_templates: [
        {
          internalid: "tpl-100",
          name: "Even",
          rec_method: "REC_EVEN_USING_DATES",
        },
      ],
      arrangements: [arrangement],
    };

    const first = await importFromNsRevenue(prisma, {
      export: exportBundle,
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => partyId,
    });
    expect(first.arrangements[0].wasDuplicate).toBe(false);

    const second = await importFromNsRevenue(prisma, {
      export: exportBundle,
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => partyId,
    });
    expect(second.arrangements[0].wasDuplicate).toBe(true);
    expect(second.totals.arrangementsCreated).toBe(0);
    expect(second.totals.arrangementsSkipped).toBe(1);
    expect(second.arrangements[0].contractId).toBe(first.arrangements[0].contractId);
  });

  it("writes the new ASC 606 fields (allocatedAmount + allocationMethod + fairValueMethod + quantity)", async () => {
    const arrangement = makeArrangement("C");
    // Make it residual so allocatedAmount diverges from SSP.
    arrangement.elements[0].ssp = 12000;
    arrangement.elements[0].allocated_amount = 9500;
    arrangement.elements[0].allocation_method = "RESIDUAL";
    arrangement.elements[0].quantity = 1;

    const result = await importFromNsRevenue(prisma, {
      export: {
        exported_at: "2026-06-05T00:00:00Z",
        account_id: "ns-acct-1",
        recognition_templates: [
          {
            internalid: "tpl-100",
            name: "Even",
            rec_method: "REC_EVEN_USING_DATES",
          },
        ],
        arrangements: [arrangement],
      },
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => partyId,
    });

    const contractId = result.arrangements[0].contractId;
    const po = await prisma.performanceObligation.findFirstOrThrow({
      where: { contractId },
    });
    expect(po.allocatedAmount?.toString()).toBe("9500");
    expect(po.allocationMethod).toBe("RESIDUAL");
    expect(po.fairValueMethod).toBe("ESP");
    expect(po.quantity.toString()).toBe("1");
  });
});
