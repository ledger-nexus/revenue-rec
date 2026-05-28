"use server";

// Server Action: set pricePerUnit + unitName on an OVER_TIME_USAGE PO.
//
// Needed because the AI extractor (v0.2) doesn't yet capture usage
// parameters — the user manually sets them after contract approval.
// Until the AI prompt is expanded to extract these for OVER_TIME_USAGE
// patterns (a v0.4+ enhancement), this is the path.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  canApproveExtraction,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";

export interface SetUsagePricingInput {
  obligationId: string;
  pricePerUnit: string;
  unitName: string;
}

export async function setUsagePricingAction(
  input: SetUsagePricingInput
): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    // Same role floor as approveExtraction — setting usage pricing
    // changes how the PO recognizes revenue, which is policy-level.
    requirePermission("approve_extraction", tenant.role, canApproveExtraction);

    if (!input.obligationId) return { ok: false, message: "obligationId required." };
    if (!input.unitName?.trim()) {
      return { ok: false, message: "Unit name required (e.g. 'API call', 'GB-month')." };
    }

    let price: Decimal;
    try {
      price = new Decimal(input.pricePerUnit?.trim() ?? "");
      if (!price.isFinite() || price.lessThanOrEqualTo(0)) {
        return { ok: false, message: "Price per unit must be > 0." };
      }
    } catch {
      return {
        ok: false,
        message: `Invalid price "${input.pricePerUnit}".`,
      };
    }

    const po = await prisma.performanceObligation.findFirst({
      where: {
        id: input.obligationId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: { id: true, contractId: true, recognitionPattern: true },
    });
    if (!po) {
      return { ok: false, message: "Performance obligation not found in this workspace." };
    }
    if (po.recognitionPattern !== "OVER_TIME_USAGE") {
      return {
        ok: false,
        message: `Pricing is only meaningful for OVER_TIME_USAGE POs. This one is ${po.recognitionPattern}.`,
      };
    }

    await prisma.performanceObligation.update({
      where: { id: po.id },
      data: {
        pricePerUnit: price.toFixed(6),
        unitName: input.unitName.trim(),
      },
    });

    revalidatePath(`/contracts/${po.contractId}`);
    return { ok: true, message: `Pricing updated: $${price.toString()} per ${input.unitName.trim()}.` };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof PermissionDeniedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
