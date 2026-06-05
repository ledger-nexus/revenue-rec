// NetSuite revenue-arrangement import orchestrator.
//
// Idempotent end-to-end. Takes a parsed NS export bundle + a customer-
// party resolver callback, writes the mapped `RevenueContract` +
// `PerformanceObligation` rows to revenue-rec's substrate, and surfaces
// per-arrangement warnings from the pure mappers.
//
// Idempotency: every arrangement carries the lineage triple
// `(sourceSystem='netsuite', sourceRecordType='RevenueArrangement',
// sourceRecordId=NS internal id)`. Before creating a row we check
// for an existing contract with the same triple; if found, we SKIP
// (return wasDuplicate: true). The mapper version isn't part of the
// dedup key — re-importing the same NS export after a mapping-logic
// change yields the SAME contract row, not a duplicate.
//
// Transactional discipline: each arrangement's contract + POs are
// inserted in a single $transaction. If any element fails, the
// whole arrangement rolls back — partial arrangements never land.
// Across arrangements, failures don't cascade (per-arrangement
// try/catch); the import returns BOTH the successes AND the per-
// arrangement errors so the caller can surface them.
//
// Customer-party resolution: revenue-rec's `Party` is per-tenant; the
// NS customer's `internalid` doesn't map directly. The caller passes
// a `resolveCustomerPartyId` callback that takes the NS internal id +
// optional display name and returns the revenue-rec Party id. The
// orchestrator is agnostic to whether the resolver creates new
// parties or matches existing ones; the typical Server Action wraps
// `prisma.party.upsert` keyed by `code = "NS-CUST-{internalid}"`.

import type { PrismaClient } from "@prisma/client";
import {
  mapArrangement,
  type MappedRevenueContract,
} from "./mappers";
import type { NsRevenueArrangementExport, NsRevenueArrangement } from "./types";

// =========================================================================
// Public input + result shapes
// =========================================================================

export interface ImportFromNsRevenueInput {
  /** The NS export bundle (arrangements + templates). */
  export: NsRevenueArrangementExport;

  /**
   * Resolve a revenue-rec `LegalEntity` id from the NS subsidiary's
   * internal id. The orchestrator does NOT auto-create LegalEntities —
   * those are bootstrapped via the universal NetSuite mapper in
   * ledger-core (see ledger-core/src/lib/mappers/netsuite/bootstrap.ts).
   * The resolver throws with an actionable message when the subsidiary
   * hasn't been bootstrapped yet.
   */
  resolveEntityId: (args: {
    nsSubsidiaryInternalId: string;
    nsSubsidiaryName?: string;
  }) => Promise<string>;

  /**
   * Resolve (or create) a revenue-rec `Party` id for the NS customer.
   * Typical implementation: `prisma.party.upsert` keyed by
   * `code = "NS-CUST-{internalid}"`. The caller owns party creation
   * because Party.tenantId is set per session — the orchestrator
   * stays tenant-agnostic.
   */
  resolveCustomerPartyId: (args: {
    nsCustomerInternalId: string;
    nsCustomerName?: string;
  }) => Promise<string>;

  /**
   * When true, skip arrangements that resolve customers in a way the
   * orchestrator can't validate (e.g., resolver returns the empty
   * string). Default: false (errors throw the arrangement, rest of
   * the import continues).
   */
  strict?: boolean;
}

export interface ImportArrangementResult {
  nsArrangementInternalId: string;
  nsArrangementTranid: string;
  /** revenue-rec contract id. Always set (even when duplicate). */
  contractId: string;
  /** True if the lineage triple matched an existing contract — no rows written. */
  wasDuplicate: boolean;
  /** Number of POs created (0 when wasDuplicate). */
  obligationsCreated: number;
  /** Warnings from the mapper (template defaults, allocation mismatches, etc.). */
  warnings: string[];
}

export interface ImportFromNsRevenueResult {
  /** Per-arrangement success records. */
  arrangements: ImportArrangementResult[];
  /** Per-arrangement errors (mapping or DB failure). */
  errors: Array<{
    nsArrangementInternalId: string;
    nsArrangementTranid: string;
    message: string;
  }>;
  /** Totals for the operator/UI. */
  totals: {
    arrangementsProcessed: number;
    arrangementsCreated: number;
    arrangementsSkipped: number;
    arrangementsErrored: number;
    obligationsCreated: number;
    warningCount: number;
  };
}

// =========================================================================
// Orchestrator
// =========================================================================

/**
 * Import an NS revenue-arrangement export into revenue-rec.
 *
 * Per-arrangement flow:
 *   1. Resolve entity (LegalEntity id) — throws if subsidiary not bootstrapped.
 *   2. Check lineage-triple idempotency. If a contract with the same
 *      (netsuite, RevenueArrangement, internalid) exists, SKIP.
 *   3. Resolve customer party id via the callback.
 *   4. mapArrangement() → MappedRevenueContract + MappedPerformanceObligation[].
 *   5. Inside a $transaction: create RevenueContract + nested POs.
 *   6. Surface mapper warnings.
 *
 * @param prisma - revenue-rec's PrismaClient
 * @param input - bundle + resolvers + options
 * @returns per-arrangement results + portfolio totals
 */
export async function importFromNsRevenue(
  prisma: PrismaClient,
  input: ImportFromNsRevenueInput
): Promise<ImportFromNsRevenueResult> {
  // Build template lookup once (orchestrator-internal helper).
  const templatesByInternalId = new Map(
    input.export.recognition_templates.map((t) => [t.internalid, t])
  );

  const arrangements: ImportArrangementResult[] = [];
  const errors: ImportFromNsRevenueResult["errors"] = [];
  let totalObligations = 0;
  let totalWarnings = 0;

  for (const ns of input.export.arrangements) {
    try {
      const result = await importOneArrangement(
        prisma,
        ns,
        templatesByInternalId,
        input
      );
      arrangements.push(result);
      totalObligations += result.obligationsCreated;
      totalWarnings += result.warnings.length;
    } catch (e) {
      errors.push({
        nsArrangementInternalId: ns.internalid,
        nsArrangementTranid: ns.tranid,
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return {
    arrangements,
    errors,
    totals: {
      arrangementsProcessed: input.export.arrangements.length,
      arrangementsCreated: arrangements.filter((a) => !a.wasDuplicate).length,
      arrangementsSkipped: arrangements.filter((a) => a.wasDuplicate).length,
      arrangementsErrored: errors.length,
      obligationsCreated: totalObligations,
      warningCount: totalWarnings,
    },
  };
}

/**
 * Import a single arrangement. Throws on hard failures (missing
 * entity, customer-resolver returns empty); the caller catches per-
 * arrangement so a bad row doesn't sink the whole import.
 */
async function importOneArrangement(
  prisma: PrismaClient,
  ns: NsRevenueArrangement,
  templatesByInternalId: Parameters<typeof mapArrangement>[1],
  input: ImportFromNsRevenueInput
): Promise<ImportArrangementResult> {
  // 1. Resolve entity (LegalEntity id).
  const entityId = await input.resolveEntityId({
    nsSubsidiaryInternalId: ns.subsidiary.internalid,
    nsSubsidiaryName: ns.subsidiary.name,
  });
  if (!entityId) {
    throw new Error(
      `Could not resolve LegalEntity for NS subsidiary internalid=${ns.subsidiary.internalid}. Has this subsidiary been bootstrapped via ledger-core's NetSuite mapper?`
    );
  }

  // 2. Lineage-triple idempotency check.
  const existing = await prisma.revenueContract.findFirst({
    where: {
      sourceSystem: "netsuite",
      sourceRecordType: "RevenueArrangement",
      sourceRecordId: ns.internalid,
    },
    select: { id: true },
  });
  if (existing) {
    return {
      nsArrangementInternalId: ns.internalid,
      nsArrangementTranid: ns.tranid,
      contractId: existing.id,
      wasDuplicate: true,
      obligationsCreated: 0,
      warnings: [],
    };
  }

  // 3. Resolve customer party.
  const customerPartyId = await input.resolveCustomerPartyId({
    nsCustomerInternalId: ns.customer.internalid,
    nsCustomerName: ns.customer.name,
  });
  if (!customerPartyId) {
    if (input.strict) {
      throw new Error(
        `resolveCustomerPartyId returned empty for NS customer internalid=${ns.customer.internalid}`
      );
    }
    throw new Error(
      `Customer not resolvable for NS arrangement ${ns.tranid} (customer internalid=${ns.customer.internalid}). Provide a resolver that creates parties on demand.`
    );
  }

  // 4. Pure mapping.
  const mapped = mapArrangement(ns, templatesByInternalId);

  // 5. Write contract + all POs inside a single transaction so partial
  // failures roll back. The lineage-triple check on retry will skip
  // the row a successful previous run created.
  const result = await prisma.$transaction(async (tx) => {
    const contract = await tx.revenueContract.create({
      data: contractCreateData(mapped.contract, entityId, customerPartyId),
      select: { id: true },
    });
    for (const po of mapped.obligations) {
      await tx.performanceObligation.create({
        data: {
          contractId: contract.id,
          sequenceNo: po.sequenceNo,
          description: po.description,
          ssp: po.ssp.toFixed(4),
          allocatedAmount: po.allocatedAmount?.toFixed(4) ?? null,
          allocationMethod: po.allocationMethod,
          fairValueMethod: po.fairValueMethod,
          quantity: po.quantity.toFixed(4),
          recognitionPattern: po.recognitionPattern,
          startDate: po.startDate,
          endDate: po.endDate,
          revenueAccountCode: po.revenueAccountCode,
          deferredAccountCode: po.deferredAccountCode,
        },
      });
    }
    return contract;
  });

  return {
    nsArrangementInternalId: ns.internalid,
    nsArrangementTranid: ns.tranid,
    contractId: result.id,
    wasDuplicate: false,
    obligationsCreated: mapped.obligations.length,
    warnings: mapped.warnings,
  };
}

/**
 * Translate a `MappedRevenueContract` to the Prisma create-input shape
 * for `RevenueContract`. Kept separate so tests can call it without
 * exercising the full orchestrator.
 */
function contractCreateData(
  mapped: MappedRevenueContract,
  entityId: string,
  customerPartyId: string
) {
  return {
    entityId,
    code: mapped.code,
    description: mapped.description,
    customerPartyId,
    contractStartDate: mapped.contractStartDate,
    totalContractValue: mapped.totalContractValue.toFixed(4),
    currencyId: mapped.currencyId,
    sourceSystem: mapped.sourceSystem,
    sourceRecordType: mapped.sourceRecordType,
    sourceRecordId: mapped.sourceRecordId,
    sourcePayload: mapped.sourcePayload as unknown as object,
    mappingVersion: mapped.mappingVersion,
  };
}
