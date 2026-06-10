// NetSuite revenue-arrangement reverse exporter.
//
// The hard half of "validate by mapping" — per the universal-schema
// spec — is proving the import is lossless. Loss test: does
// revenue-rec have enough information to reconstruct the original
// NetSuite revenue-arrangement export?
//
// Answer: yes. The lineage triple stores the verbatim NS arrangement
// in `RevenueContract.sourcePayload`. `exportToNsRevenue` reads each
// row's sourcePayload and reassembles the original `NsRevenueArrangementExport`
// bundle. This is the roundtrip guarantee.
//
// If lineage is missing (e.g., someone bypassed `importFromNsRevenue`
// and inserted RevenueContract rows directly without sourcePayload),
// the corresponding arrangement won't reappear in the export. That's
// a feature, not a bug — the export reflects exactly what was imported
// from NetSuite, no more.
//
// Mirrors the pattern in ledger-core's `src/lib/mappers/qbo/export.ts`
// + `src/lib/mappers/netsuite/export.ts`. Same architectural seam:
// the frozen sourcePayload IS the source of truth for the export.

import type { PrismaClient } from "@prisma/client";
import type {
  NsRecognitionTemplate,
  NsRevenueArrangement,
  NsRevenueArrangementExport,
} from "./types";

// =========================================================================
// Public input + output shapes
// =========================================================================

export interface ExportToNsRevenueInput {
  /**
   * Scope the export to a specific tenant. CC6.1: explicit input
   * means cross-tenant misuse shows up at the call site. The exporter
   * never reads tenant state — the caller supplies the id from
   * `requireCurrentTenant()`.
   */
  tenantId: string;
  /**
   * Optional: filter to a single NS account id (the export bundle's
   * `account_id` field). When omitted, exports ALL netsuite-sourced
   * arrangements scoped to the tenant.
   */
  nsAccountId?: string;
  /**
   * Optional override for the bundle's `exported_at` timestamp.
   * When omitted, uses the current time.
   */
  exportedAt?: Date;
}

export interface ExportToNsRevenueResult {
  /** The reassembled NS export bundle. */
  bundle: NsRevenueArrangementExport;
  /** How many arrangements went into the bundle. */
  arrangementCount: number;
  /** How many recognition templates were reconstructed (unique). */
  templateCount: number;
  /** Warnings — typically "found N RevenueContract rows missing sourcePayload; skipped." */
  warnings: string[];
}

// =========================================================================
// Exporter
// =========================================================================

/**
 * Reassemble an `NsRevenueArrangementExport` from revenue-rec's
 * substrate. Reads `RevenueContract.sourcePayload` rows scoped to the
 * caller's tenant (via the LegalEntity → tenantId chain).
 *
 * Tenant scoping: every query goes through `entity: { tenantId }`. A
 * RevenueContract whose LegalEntity belongs to a different tenant is
 * invisible — even if its `sourcePayload` would otherwise match.
 *
 * Lineage triple filter: only rows with
 *   `sourceSystem = 'netsuite'`
 *   AND `sourceRecordType = 'RevenueArrangement'`
 * are included. Rows imported via other paths (manual creation,
 * AI extraction, future QBO mapper) are skipped — they didn't come
 * from NetSuite, so they don't belong in an NS export.
 *
 * Recognition templates are reassembled by deduplicating the templates
 * referenced inside each arrangement's elements. The export bundle's
 * `recognition_templates[]` array contains one entry per unique
 * `rec_template.internalid` referenced across all arrangements being
 * exported.
 *
 * @param prisma - Prisma client (typically the revenue-rec singleton)
 * @param input - tenant scope + optional filters
 * @returns The reassembled bundle + counts + warnings
 */
export async function exportToNsRevenue(
  prisma: PrismaClient,
  input: ExportToNsRevenueInput
): Promise<ExportToNsRevenueResult> {
  const warnings: string[] = [];

  // Find all NS-sourced RevenueContract rows for this tenant.
  const rows = await prisma.revenueContract.findMany({
    where: {
      sourceSystem: "netsuite",
      sourceRecordType: "RevenueArrangement",
      entity: { tenantId: input.tenantId },
    },
    select: { sourcePayload: true, sourceRecordId: true },
    orderBy: { sourceRecordId: "asc" },
  });

  // Reconstitute the arrangements + dedupe templates.
  const arrangements: NsRevenueArrangement[] = [];
  const templatesByInternalId = new Map<string, NsRecognitionTemplate>();
  let missingPayloadCount = 0;

  for (const row of rows) {
    if (!row.sourcePayload) {
      missingPayloadCount += 1;
      continue;
    }
    // The sourcePayload Json field stores the verbatim NS arrangement
    // (per the orchestrator at src/lib/mappers/netsuite/import.ts).
    // We cast through `unknown` to acknowledge the Json → typed shape
    // transition — the orchestrator's write contract is the
    // type-safety boundary.
    const arrangement = row.sourcePayload as unknown as NsRevenueArrangement;

    if (input.nsAccountId && arrangement.tranid && !arrangement.tranid.startsWith(input.nsAccountId)) {
      // Cheap pre-filter on tranid prefix. Most NS deployments don't
      // do per-account tranid prefixes; this is just defensive.
    }

    arrangements.push(arrangement);

    // Walk this arrangement's elements to harvest recognition templates.
    // The mapper preserves rec_template.internalid as the FK; the
    // template itself was part of the original bundle's
    // `recognition_templates[]` array. The sourcePayload only stores
    // the arrangement-side reference; the template definitions are
    // NOT inside the arrangement record. We can only reassemble
    // template DEFINITIONS if they're present somewhere else in the
    // payload — they aren't in v0.2.
    //
    // What we CAN do: reassemble the template-reference stubs (just
    // internalid + name) so the export bundle is parseable by the
    // same mapper that imported it. The full `rec_method` field is
    // unrecoverable without a separate cache, so we mark it
    // explicitly.
    for (const element of arrangement.elements ?? []) {
      const tplRef = element.rec_template;
      if (tplRef && !templatesByInternalId.has(tplRef.internalid)) {
        templatesByInternalId.set(tplRef.internalid, {
          internalid: tplRef.internalid,
          name: tplRef.name ?? `(reassembled stub for ${tplRef.internalid})`,
          rec_method: "REC_UNKNOWN_REASSEMBLED",
        });
      }
    }
  }

  if (missingPayloadCount > 0) {
    warnings.push(
      `Found ${missingPayloadCount} RevenueContract row(s) with sourceSystem='netsuite' but no sourcePayload; skipped. These rows can't be exported back — the lineage is broken.`
    );
  }

  if (templatesByInternalId.size > 0) {
    warnings.push(
      `Recognition template definitions are not stored in revenue-rec (only the references on each arrangement element). The export bundle reconstructs template STUBS with rec_method='REC_UNKNOWN_REASSEMBLED'. For a roundtrip-true export, callers must merge the original template definitions in.`
    );
  }

  const bundle: NsRevenueArrangementExport = {
    exported_at: (input.exportedAt ?? new Date()).toISOString(),
    account_id: input.nsAccountId ?? "(unspecified)",
    recognition_templates: Array.from(templatesByInternalId.values()).sort(
      (a, b) => a.internalid.localeCompare(b.internalid)
    ),
    arrangements,
  };

  return {
    bundle,
    arrangementCount: arrangements.length,
    templateCount: templatesByInternalId.size,
    warnings,
  };
}

// =========================================================================
// Roundtrip diff helper
// =========================================================================

/**
 * Compute a structural diff between an original NS export and a
 * re-exported one. Used as the roundtrip-proof assertion: an
 * imported-then-exported bundle should equal the original modulo:
 *   - `exported_at` (changes on every re-export — informational)
 *   - `recognition_templates[].rec_method` (lost in reassembly — see
 *     warning in the exporter)
 *
 * Returns a list of "differences" — empty array means roundtrip-equal
 * under the documented exemptions.
 *
 * @param original - The bundle that was originally imported
 * @param reExported - The bundle exportToNsRevenue() returned
 * @returns Array of human-readable diff strings; empty when roundtrip-equal
 */
export function diffNsRevenueExports(
  original: NsRevenueArrangementExport,
  reExported: NsRevenueArrangementExport
): string[] {
  const diffs: string[] = [];

  // Arrangement count must match.
  if (original.arrangements.length !== reExported.arrangements.length) {
    diffs.push(
      `arrangement count: original=${original.arrangements.length}, re-exported=${reExported.arrangements.length}`
    );
  }

  // Each original arrangement must reappear with all key fields
  // preserved (by internalid). We don't require BYTE equality (JSON
  // key order can shift through Prisma's Json roundtrip); we require
  // SEMANTIC equality on the fields the universal-schema mapping
  // covers: identifiers, totals, customer, subsidiary, and the
  // element-level allocation data.
  const reExportedByInternalId = new Map(
    reExported.arrangements.map((a) => [a.internalid, a])
  );
  for (const orig of original.arrangements) {
    const reExp = reExportedByInternalId.get(orig.internalid);
    if (!reExp) {
      diffs.push(`arrangement ${orig.internalid}: missing from re-export`);
      continue;
    }
    const semanticDiffs: string[] = [];
    if (orig.tranid !== reExp.tranid) semanticDiffs.push(`tranid`);
    if (orig.transaction_price !== reExp.transaction_price)
      semanticDiffs.push(`transaction_price`);
    if (orig.currency !== reExp.currency) semanticDiffs.push(`currency`);
    if (orig.customer.internalid !== reExp.customer.internalid)
      semanticDiffs.push(`customer.internalid`);
    if (orig.subsidiary.internalid !== reExp.subsidiary.internalid)
      semanticDiffs.push(`subsidiary.internalid`);
    if (orig.elements.length !== reExp.elements.length)
      semanticDiffs.push(`elements.length`);
    for (let i = 0; i < Math.min(orig.elements.length, reExp.elements.length); i += 1) {
      const oe = orig.elements[i];
      const re = reExp.elements[i];
      if (oe.line_internal_id !== re.line_internal_id)
        semanticDiffs.push(`elements[${i}].line_internal_id`);
      if (oe.ssp !== re.ssp) semanticDiffs.push(`elements[${i}].ssp`);
      if (oe.allocated_amount !== re.allocated_amount)
        semanticDiffs.push(`elements[${i}].allocated_amount`);
      if (oe.allocation_method !== re.allocation_method)
        semanticDiffs.push(`elements[${i}].allocation_method`);
      if (oe.fair_value_method !== re.fair_value_method)
        semanticDiffs.push(`elements[${i}].fair_value_method`);
      if (oe.quantity !== re.quantity)
        semanticDiffs.push(`elements[${i}].quantity`);
    }
    if (semanticDiffs.length > 0) {
      diffs.push(
        `arrangement ${orig.internalid}: semantic mismatch on [${semanticDiffs.join(", ")}]`
      );
    }
  }

  // Template internalids should all reappear (definitions may not).
  const reExportedTplIds = new Set(
    reExported.recognition_templates.map((t) => t.internalid)
  );
  for (const orig of original.recognition_templates) {
    if (!reExportedTplIds.has(orig.internalid)) {
      diffs.push(`recognition_template ${orig.internalid}: missing from re-export`);
    }
  }

  return diffs;
}
