// Integration test for the NS revenue-arrangement REVERSE EXPORTER.
//
// Proves the universal-schema "validate by mapping" thesis end-to-end:
//
//   1. Import an NS bundle (importFromNsRevenue) — writes
//      RevenueContract + PerformanceObligation rows with
//      sourcePayload populated.
//   2. Re-export (exportToNsRevenue) — reads sourcePayload back
//      and reassembles the bundle.
//   3. Diff against the original (diffNsRevenueExports).
//   4. Assert the diff is empty (modulo the documented exemptions:
//      exported_at + template rec_method).
//
// Tenant scoping: the export filter is `entity: { tenantId }` —
// arrangements imported under a different tenant must NOT appear in
// THIS tenant's export.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  exportToNsRevenue,
  importFromNsRevenue,
  diffNsRevenueExports,
} from "../src/lib/mappers/netsuite";
import type { NsRevenueArrangementExport } from "../src/lib/mappers/netsuite";

const prisma = new PrismaClient();
const SUFFIX = "rxprt" + Date.now().toString(36);

let tenantId: string;
let entityId: string;
let customerPartyId: string;

async function cleanup() {
  await prisma.revenueContract.deleteMany({
    where: { code: { startsWith: `NS-RA-RA-RXPRT-${SUFFIX}` } },
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
  tenantId = entity.tenantId;
  const someParty = await prisma.party.findFirst({ select: { id: true } });
  if (!someParty) throw new Error("No Party found.");
  customerPartyId = someParty.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function makeBundle(tranSuffix: string): NsRevenueArrangementExport {
  return {
    exported_at: "2026-06-05T00:00:00Z",
    account_id: "ns-acct-1",
    recognition_templates: [
      {
        internalid: "tpl-100",
        name: "Even Across Dates",
        rec_method: "REC_EVEN_USING_DATES",
      },
    ],
    arrangements: [
      {
        internalid: `ra-${tranSuffix}`,
        tranid: `RA-RXPRT-${SUFFIX}-${tranSuffix}`,
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
            item: { internalid: "item-saas", name: "SaaS" },
            description: "Annual SaaS subscription",
            ssp: 12000,
            fair_value_method: "ESP",
            allocated_amount: 12000,
            allocation_method: "RELATIVE_SSP",
            quantity: 1,
            rec_template: { internalid: "tpl-100", name: "Even Across Dates" },
            rev_rec_start_date: "2026-01-01",
            rev_rec_end_date: "2026-12-31",
            revenue_account: { internalid: "4000" },
            deferred_revenue_account: { internalid: "2200" },
          },
        ],
      },
    ],
  };
}

describe("exportToNsRevenue — roundtrip proof vs real Postgres", () => {
  it("imports a bundle, re-exports, and diffNsRevenueExports returns no structural differences", async () => {
    const original = makeBundle("A");

    // 1. Import.
    const importResult = await importFromNsRevenue(prisma, {
      export: original,
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => customerPartyId,
    });
    expect(importResult.totals.arrangementsCreated).toBe(1);
    expect(importResult.errors).toHaveLength(0);

    // 2. Re-export scoped to this tenant.
    const exportResult = await exportToNsRevenue(prisma, {
      tenantId,
    });
    expect(exportResult.arrangementCount).toBeGreaterThanOrEqual(1);

    // 3. Find our specific arrangement in the export.
    const reExportedArrangement = exportResult.bundle.arrangements.find(
      (a) => a.internalid === "ra-A"
    );
    expect(reExportedArrangement).toBeDefined();

    // 4. Diff: build a focused "single-arrangement bundle" view of both.
    const focusedReExport: NsRevenueArrangementExport = {
      ...exportResult.bundle,
      arrangements: [reExportedArrangement!],
      recognition_templates: exportResult.bundle.recognition_templates.filter(
        (t) => t.internalid === "tpl-100"
      ),
    };
    const diffs = diffNsRevenueExports(original, focusedReExport);

    // The structural arrangement diff should be empty. Template
    // rec_method is documented as not-roundtrip-true (we only have
    // the references; the definitions live elsewhere) — diffs about
    // rec_method are expected and shouldn't fail this test.
    const nonTemplateMethodDiffs = diffs.filter(
      (d) => !d.includes("recognition_template")
    );
    expect(nonTemplateMethodDiffs).toEqual([]);
  });

  it("preserves the ASC 606 fields (allocatedAmount, allocationMethod, fairValueMethod, quantity)", async () => {
    const original = makeBundle("B");
    // Set divergent values so we can verify they round-trip.
    original.arrangements[0].elements[0].allocated_amount = 9500; // ≠ ssp
    original.arrangements[0].elements[0].allocation_method = "RESIDUAL";
    original.arrangements[0].elements[0].fair_value_method = "VSOE";
    original.arrangements[0].elements[0].quantity = 5;

    await importFromNsRevenue(prisma, {
      export: original,
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => customerPartyId,
    });

    const exportResult = await exportToNsRevenue(prisma, { tenantId });
    const reExported = exportResult.bundle.arrangements.find(
      (a) => a.internalid === "ra-B"
    );
    expect(reExported).toBeDefined();
    const ele = reExported!.elements[0];
    expect(ele.allocated_amount).toBe(9500);
    expect(ele.allocation_method).toBe("RESIDUAL");
    expect(ele.fair_value_method).toBe("VSOE");
    expect(ele.quantity).toBe(5);
  });

  it("returns no rows for a foreign tenant (CC6.1 cross-tenant isolation)", async () => {
    // Import an arrangement under this tenant.
    await importFromNsRevenue(prisma, {
      export: makeBundle("C"),
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => customerPartyId,
    });

    // Re-export with a DIFFERENT tenantId (a uuid-shaped sentinel).
    const result = await exportToNsRevenue(prisma, {
      tenantId: "99999999-1111-aaaa-bbbb-cccccccccccc",
    });

    // Our just-imported arrangement must NOT be visible.
    const visibleInternalids = result.bundle.arrangements.map((a) => a.internalid);
    expect(visibleInternalids).not.toContain("ra-C");
  });

  it("includes warnings for missing template rec_method definitions (documented exemption)", async () => {
    await importFromNsRevenue(prisma, {
      export: makeBundle("D"),
      tenantId,
      resolveEntityId: async () => entityId,
      resolveCustomerPartyId: async () => customerPartyId,
    });

    const result = await exportToNsRevenue(prisma, { tenantId });
    // Template stubs are emitted with rec_method='REC_UNKNOWN_REASSEMBLED'.
    const reassembledTemplate = result.bundle.recognition_templates.find(
      (t) => t.internalid === "tpl-100"
    );
    expect(reassembledTemplate?.rec_method).toBe("REC_UNKNOWN_REASSEMBLED");
    expect(
      result.warnings.some((w) =>
        w.includes("REC_UNKNOWN_REASSEMBLED")
      )
    ).toBe(true);
  });

  it("uses input.exportedAt when provided", async () => {
    const stamp = new Date("2026-12-31T23:59:59.999Z");
    const result = await exportToNsRevenue(prisma, {
      tenantId,
      exportedAt: stamp,
    });
    expect(result.bundle.exported_at).toBe(stamp.toISOString());
  });
});
