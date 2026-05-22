// Live end-to-end smoke test. Exercises the full v0.2 loop against
// real infrastructure:
//
//   1. Read the first contract from the seeded DB
//   2. Run the AI extractor against its ContractDocument
//   3. Print the proposed POs + cache stats + token usage
//   4. Post the FIRST PLANNED RecognitionSchedule row via the bridge
//   5. Print the resulting ledger-core entry number
//
// Prerequisites:
//   - DATABASE_URL points at a Postgres seeded with ledger-core + revenue-rec
//   - ANTHROPIC_API_KEY set
//   - LEDGER_CORE_URL + LEDGER_CORE_INTERNAL_TOKEN set
//   - ledger-core dev server running on LEDGER_CORE_URL
//
// Run:  tsx scripts/smoke-test-e2e.ts
//
// Skipped from CI (no live infrastructure). This is the test that
// proves the integration actually works.

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { extractContractAction } from "../src/app/actions/extract-contract";
import { postRecognitionAction } from "../src/app/actions/post-recognition";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set.");
    process.exit(1);
  }
  if (!process.env.LEDGER_CORE_INTERNAL_TOKEN) {
    console.error("LEDGER_CORE_INTERNAL_TOKEN not set.");
    process.exit(1);
  }

  console.log("revenue-rec end-to-end smoke test...");
  console.log("");

  const contract = await prisma.revenueContract.findFirst({
    select: {
      id: true,
      code: true,
      customer: { select: { displayName: true } },
      _count: { select: { recognitionSchedules: true } },
    },
  });
  if (!contract) {
    console.error("No contracts in DB. Run `pnpm db:seed` first.");
    process.exit(1);
  }
  console.log(`Target contract: ${contract.code} (${contract.customer.displayName})`);
  console.log(`Schedule rows in DB: ${contract._count.recognitionSchedules}`);
  console.log("");

  // ─── Step 1: AI extraction ───────────────────────────────────────────
  console.log("── AI extraction ─────────────────────────────────────────");
  const extractRes = await extractContractAction(contract.id);
  if (!extractRes.ok) {
    console.error(`Extraction failed: ${extractRes.message}`);
    process.exit(1);
  }
  console.log(`  ok:              ${extractRes.ok}`);
  console.log(`  message:         ${extractRes.message}`);
  console.log(`  latency:         ${extractRes.latencyMs}ms`);
  console.log(
    `  cache:           read=${extractRes.cacheReadTokens ?? 0} created=${extractRes.cacheCreationTokens ?? 0}`
  );
  console.log(`  suggestion id:   ${extractRes.suggestionId}`);
  if (extractRes.proposal) {
    console.log(
      `  contract:        ${extractRes.proposal.contractCode} · ${extractRes.proposal.customerName}`
    );
    console.log(`  total value:     $${extractRes.proposal.totalContractValue.toLocaleString()}`);
    console.log(`  POs:`);
    for (const po of extractRes.proposal.performanceObligations) {
      console.log(
        `    PO${po.sequenceNo}: ${po.recognitionPattern.padEnd(20)} $${po.ssp.toLocaleString()}  ${po.description}`
      );
    }
    console.log(`  notes:           ${extractRes.proposal.notes}`);
  }
  console.log("");

  // ─── Step 2: pick the first PLANNED schedule row and post it ─────────
  console.log("── Post recognition ──────────────────────────────────────");
  const planned = await prisma.recognitionSchedule.findFirst({
    where: { contractId: contract.id, status: "PLANNED" },
    orderBy: { periodStart: "asc" },
    select: {
      id: true,
      periodStart: true,
      plannedAmount: true,
      obligation: { select: { sequenceNo: true } },
    },
  });
  if (!planned) {
    console.log("  No PLANNED schedule rows left — all recognition already posted.");
    return;
  }
  console.log(
    `  Posting PO${planned.obligation.sequenceNo} / ${planned.periodStart.toISOString().slice(0, 7)} / $${planned.plannedAmount.toString()}`
  );
  const postRes = await postRecognitionAction({ scheduleId: planned.id });
  console.log(`  ok:              ${postRes.ok}`);
  console.log(`  message:         ${postRes.message}`);
  if (postRes.entryNumber) {
    console.log(`  ledger-core entry: ${postRes.entryNumber}`);
  }
  console.log("");

  console.log("Done. Open /contracts/<id> in the browser to see the updated schedule.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
