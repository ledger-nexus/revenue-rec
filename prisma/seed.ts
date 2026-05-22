// revenue-rec seed. Idempotent. Assumes ledger-core's Northwind seed has
// already been run against the same database.
//
// Sets up:
//   - Initech customer party (created if missing) — Northwind's customer
//     in this fixture contract
//   - One RevenueContract: 12-month SaaS subscription + one-time
//     implementation, sold for $60,000 with a $10,000 discount on
//     implementation services
//   - Two PerformanceObligations:
//       PO1: Subscription, $60,000 SSP → $51,428.57 allocated, OVER_TIME_STRAIGHT
//       PO2: Implementation, $10,000 SSP → $8,571.43 allocated, POINT_IN_TIME
//   - Book attributes for US_GAAP (ACCRUAL)
//   - The full RecognitionSchedule (12 monthly rows for PO1 + 1 row for PO2)
//   - The contract document (raw text for the v0.2 AI extractor to read)

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allocateTransactionPrice } from "../src/lib/accounting/allocator";
import { generateSchedule } from "../src/lib/accounting/schedule";

const prisma = new PrismaClient();

async function main() {
  console.log("revenue-rec seed — wiring sample SaaS contract for Northwind/Initech...");

  // 1. Confirm NORTHWIND entity exists (created by ledger-core seed).
  const entity = await prisma.legalEntity.findUnique({
    where: { code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) {
    console.error(
      "NORTHWIND entity not found. Run ledger-core's seed first against the same DATABASE_URL."
    );
    process.exit(1);
  }

  // 2. Ensure US_GAAP book exists.
  const gaap = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!gaap) {
    console.error("US_GAAP book not found. Run ledger-core's seed first.");
    process.exit(1);
  }

  // 3. Upsert Initech as a customer party. Scoped to NORTHWIND entity.
  const customer = await prisma.party.upsert({
    where: { entityId_code: { entityId: entity.id, code: "INITECH" } },
    create: {
      entityId: entity.id,
      code: "INITECH",
      displayName: "Initech Industries, Inc.",
    },
    update: {},
  });
  console.log(`  ✓ Party ${customer.displayName}`);

  // 4. Allocate the transaction price. This is what would happen at
  // contract approval time in v0.2 — for v0.1 we precompute.
  const totalContractValue = new Decimal(60_000);
  const obligations = [
    { sequenceNo: 1, description: "Northwind Cloud Platform — 12-month subscription", ssp: 60_000 },
    { sequenceNo: 2, description: "Implementation services — data migration, configuration, training", ssp: 10_000 },
  ];
  const allocations = allocateTransactionPrice({
    totalContractValue,
    performanceObligations: obligations,
  });
  console.log(`  Allocation (discount spread proportionally):`);
  for (const a of allocations) {
    console.log(
      `    PO${a.sequenceNo}: SSP $${a.ssp.toFixed(2)} → allocated $${a.allocatedAmount.toFixed(2)} (${a.allocationPercent.toFixed(2)}%)`
    );
  }

  // 5. Upsert the RevenueContract.
  const existingContract = await prisma.revenueContract.findUnique({
    where: { entityId_code: { entityId: entity.id, code: "INITECH-2026-01" } },
    select: { id: true },
  });
  if (existingContract) {
    console.log(`  ✓ Contract INITECH-2026-01 already seeded (${existingContract.id.slice(0, 8)}). Skipping.`);
    return;
  }

  const contract = await prisma.revenueContract.create({
    data: {
      entityId: entity.id,
      code: "INITECH-2026-01",
      description: "Initech 2026 SaaS subscription + implementation",
      customerPartyId: customer.id,
      contractStartDate: new Date("2026-01-01"),
      contractEndDate: new Date("2026-12-31"),
      totalContractValue: totalContractValue.toFixed(4),
      currencyId: "USD",
      status: "ACTIVE",
      performanceObligations: {
        create: [
          {
            sequenceNo: 1,
            description: allocations[0].description,
            ssp: allocations[0].allocatedAmount.toFixed(4),
            recognitionPattern: "OVER_TIME_STRAIGHT",
            startDate: new Date("2026-01-01"),
            endDate: new Date("2026-12-31"),
            revenueAccountCode: "4000",
            deferredAccountCode: "2200",
          },
          {
            sequenceNo: 2,
            description: allocations[1].description,
            ssp: allocations[1].allocatedAmount.toFixed(4),
            recognitionPattern: "POINT_IN_TIME",
            startDate: new Date("2026-03-31"),
            endDate: new Date("2026-03-31"),
            revenueAccountCode: "4010",
            deferredAccountCode: "2200",
          },
        ],
      },
      bookAttributes: {
        create: [
          {
            bookId: gaap.id,
            recognitionBasis: "ACCRUAL",
          },
        ],
      },
      document: {
        create: {
          filename: "initech-saas-contract.md",
          format: "TEXT",
          rawText: readFileSync(
            join(__dirname, "fixtures", "initech-saas-contract.md"),
            "utf-8"
          ),
        },
      },
    },
    include: {
      performanceObligations: { orderBy: { sequenceNo: "asc" } },
    },
  });
  console.log(`  ✓ Contract ${contract.code} (${contract.id.slice(0, 8)}) created`);

  // 6. Generate and persist the recognition schedule for each PO under US_GAAP.
  for (const po of contract.performanceObligations) {
    const periods = generateSchedule({
      pattern: po.recognitionPattern as "OVER_TIME_STRAIGHT" | "POINT_IN_TIME",
      allocatedAmount: new Decimal(po.ssp.toString()),
      startDate: po.startDate,
      endDate: po.endDate ?? undefined,
    });
    await prisma.recognitionSchedule.createMany({
      data: periods.map((p) => ({
        contractId: contract.id,
        obligationId: po.id,
        bookCode: "US_GAAP",
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        plannedAmount: p.plannedAmount.toFixed(4),
        status: "PLANNED",
      })),
    });
    console.log(
      `    Schedule for PO${po.sequenceNo} (${po.recognitionPattern}): ${periods.length} period(s) planned`
    );
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
