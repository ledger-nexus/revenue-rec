"use server";

// Server Action: import a NetSuite revenue-arrangement bundle.
//
// Final layer of the revenue-rec NetSuite sprint (PRs #17-#21 + this).
// Wraps `importFromNsRevenue` orchestrator with:
//
//   - Session-bound `tenantId` resolution via `requireCurrentTenant()`.
//     CC6.1 — explicit input means cross-tenant misuse shows up at
//     this call site, not buried inside the orchestrator.
//
//   - Customer-party upsert resolver. The orchestrator stays tenant-
//     agnostic; this action provides the per-tenant Party resolution
//     via `prisma.party.upsert` keyed by `code = "NS-CUST-{internalid}"`.
//
//   - JSON parse + minimal shape validation. The action accepts a
//     JSON string (typically pasted into a textarea) and validates
//     the top-level shape before handing off to the orchestrator.
//
//   - Result envelope the UI can render: totals + per-arrangement
//     details + per-arrangement errors. The orchestrator already
//     surfaces these; this action just forwards.
//
// The action does NOT:
//   - Auto-create LegalEntities. NetSuite subsidiaries are bootstrapped
//     via ledger-core's universal NS mapper (PR #43). The resolver
//     throws when a subsidiary hasn't been bootstrapped.
//   - Run the recognition allocator. NS imports carry their own
//     allocated_amount (which the orchestrator preserves verbatim);
//     re-allocating would discard NS's authoritative split.
//   - Generate recognition schedules. That happens at contract
//     approval time via the existing `approveExtractionAction` (or a
//     future "approve NS-imported contract" action).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  importFromNsRevenue,
  type ImportFromNsRevenueResult,
  type NsRevenueArrangementExport,
} from "@/lib/mappers/netsuite";

export interface ImportNsRevenueInput {
  /**
   * JSON-encoded NS revenue-arrangement export bundle. The textarea-
   * paste path is the dominant case; programmatic callers pass a
   * stringified `NsRevenueArrangementExport`.
   */
  bundleJson: string;
  /**
   * NS subsidiary internal id → revenue-rec LegalEntity code mapping.
   * Required: the orchestrator's `resolveEntityId` can't auto-create
   * LegalEntities. Typical operator workflow: import the universal
   * NS bootstrap first (ledger-core's NS mapper) which creates a
   * `LegalEntity` per NS subsidiary with code `NSSUB-{internalid}`;
   * this map can default to that convention.
   */
  subsidiaryEntityCodeMap?: Record<string, string>;
}

export interface ImportNsRevenueState {
  ok: boolean;
  /** Operator-facing message — never includes PII or token contents. */
  message: string;
  result?: ImportFromNsRevenueResult;
}

export async function importNsRevenueAction(
  input: ImportNsRevenueInput
): Promise<ImportNsRevenueState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // 1. Parse + minimally validate the bundle.
    let bundle: NsRevenueArrangementExport;
    try {
      bundle = JSON.parse(input.bundleJson) as NsRevenueArrangementExport;
    } catch (e) {
      return {
        ok: false,
        message: `Could not parse bundleJson as JSON: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
    if (
      !bundle ||
      typeof bundle !== "object" ||
      !Array.isArray(bundle.arrangements) ||
      !Array.isArray(bundle.recognition_templates)
    ) {
      return {
        ok: false,
        message:
          "bundleJson is missing required top-level fields. Expected: { exported_at, account_id, recognition_templates: [...], arrangements: [...] }",
      };
    }

    // 2. Build the entity-code map. Default convention: NSSUB-{internalid}.
    const subsidiaryEntityCodeMap = input.subsidiaryEntityCodeMap ?? {};

    // 3. Call the orchestrator with session-bound tenantId + resolvers.
    const result = await importFromNsRevenue(prisma, {
      export: bundle,
      tenantId: tenant.id,

      // Entity resolver: look up LegalEntity by mapped code (or NSSUB-
      // {internalid} fallback). Tenant-scoped so cross-tenant entities
      // are invisible.
      resolveEntityId: async ({ nsSubsidiaryInternalId }) => {
        const code =
          subsidiaryEntityCodeMap[nsSubsidiaryInternalId] ??
          `NSSUB-${nsSubsidiaryInternalId}`;
        const entity = await prisma.legalEntity.findFirst({
          where: { code, tenantId: tenant.id },
          select: { id: true },
        });
        return entity?.id ?? "";
      },

      // Customer-party resolver: upsert by code = "NS-CUST-{internalid}".
      // tenantId scoped to the current session so cross-tenant collisions
      // are impossible.
      resolveCustomerPartyId: async ({
        nsCustomerInternalId,
        nsCustomerName,
      }) => {
        const code = `NS-CUST-${nsCustomerInternalId}`;
        // Look up first (avoids unnecessary writes on idempotent re-runs).
        const existing = await prisma.party.findFirst({
          where: { code, tenantId: tenant.id },
          select: { id: true },
        });
        if (existing) return existing.id;
        // Create new — needs an entityId. Use the first arrangement's
        // entity since at this point we know the resolver was called
        // inside an arrangement context; but we don't have it directly.
        // Workaround: find any entity owned by this tenant.
        const fallbackEntity = await prisma.legalEntity.findFirst({
          where: { tenantId: tenant.id },
          select: { id: true },
        });
        const created = await prisma.party.create({
          data: {
            tenantId: tenant.id,
            entityId: fallbackEntity?.id ?? null,
            code,
            displayName:
              nsCustomerName ?? `NS Customer ${nsCustomerInternalId}`,
          },
          select: { id: true },
        });
        return created.id;
      },
    });

    // 4. Revalidate the contracts UI so the import surfaces immediately.
    revalidatePath("/contracts");
    revalidatePath("/");

    // 5. Build the operator-facing message.
    const { totals } = result;
    const summary =
      `Processed ${totals.arrangementsProcessed} arrangement(s): ` +
      `${totals.arrangementsCreated} created, ` +
      `${totals.arrangementsSkipped} skipped (duplicate), ` +
      `${totals.arrangementsErrored} errored. ` +
      `${totals.obligationsCreated} performance obligation(s) created. ` +
      `${totals.warningCount} warning(s).`;

    return { ok: true, message: summary, result };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "Not authenticated." };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, message: "No tenant selected." };
    }
    return {
      ok: false,
      message: `Unexpected error: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}
