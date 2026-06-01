// One-shot migration: encrypt the existing
// `ai_extraction_suggestion.{obligationsJson, allocationJson,
// variableConsiderationJson}` Json columns in place. Idempotent — skips
// per-field if the column already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with these three columns (type "json")
//      in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-ai-extraction-suggestions.ts
//
// Paginated by id ASC. Conservative batch size — obligationsJson can be
// several KB per row (per-PO rationale + array of obligations).

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 100;
const COLUMNS = [
  "obligationsJson",
  "allocationJson",
  "variableConsiderationJson",
] as const;
type EncryptableField = (typeof COLUMNS)[number];

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly
  // (and read the verbatim on-disk JsonValue, not the auto-decrypted
  // shape).
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  const stats: Record<
    EncryptableField,
    { encrypted: number; skippedAlready: number; skippedEmpty: number }
  > = {
    obligationsJson: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
    allocationJson: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
    variableConsiderationJson: {
      encrypted: 0,
      skippedAlready: 0,
      skippedEmpty: 0,
    },
  };

  let total = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.aiExtractionSuggestion.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: {
        id: true,
        obligationsJson: true,
        allocationJson: true,
        variableConsiderationJson: true,
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      const updates: Partial<Record<EncryptableField, string>> = {};
      for (const col of COLUMNS) {
        const v = row[col];
        if (v === null || v === undefined) {
          stats[col].skippedEmpty++;
          continue;
        }
        // If the on-disk Json value is already a string that looks
        // encrypted, this row was migrated by a prior extension write —
        // skip.
        if (typeof v === "string" && looksEncrypted(v)) {
          stats[col].skippedAlready++;
          continue;
        }
        const ct = encryptField(JSON.stringify(v));
        if (!ct) {
          stats[col].skippedEmpty++;
          continue;
        }
        updates[col] = ct;
        stats[col].encrypted++;
      }
      if (Object.keys(updates).length === 0) continue;
      // updateMany with id-only selector. AiExtractionSuggestion is
      // not under an append-only RULE so this rewrites the row
      // unconditionally; idempotency comes from the looksEncrypted
      // check above.
      await prisma.aiExtractionSuggestion.updateMany({
        where: { id: row.id },
        data: updates,
      });
    }
    if (total % 500 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; obligationsJson.encrypted=${stats.obligationsJson.encrypted} allocationJson.encrypted=${stats.allocationJson.encrypted} variableConsiderationJson.encrypted=${stats.variableConsiderationJson.encrypted}`
      );
    }
  }

  console.log(`[migrate] complete. total_rows=${total}`);
  for (const col of COLUMNS) {
    const s = stats[col];
    console.log(
      `[migrate]   ${col}: encrypted=${s.encrypted} skipped_already=${s.skippedAlready} skipped_empty=${s.skippedEmpty}`
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
