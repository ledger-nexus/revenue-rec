"use server";

// Server Action: record consumption for an OVER_TIME_USAGE PO and
// create a RecognitionSchedule row at PLANNED status.
//
// Flow:
//   1. Tenant-scope the PO lookup; refuse if it's not OVER_TIME_USAGE.
//   2. Validate the quantity (positive decimal) + the period (canonical
//      calendar month, periodStart = 1st, periodEnd = last day).
//   3. Refuse if a schedule row already exists for (PO, bookCode, periodStart)
//      — usage in a given period is recorded ONCE per PO. To correct,
//      delete the existing row and re-record (out of scope for v0.3).
//   4. Compute plannedAmount = quantity × PO.pricePerUnit, rounded to 2dp.
//   5. Insert RecognitionSchedule row.
//
// The existing postRecognitionAction posts this row to ledger-core
// when the user clicks Post — same flow as every other recognition row.

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
  canPostRecognition,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";

export interface RecordUsageInput {
  obligationId: string;
  /** ISO YYYY-MM-DD — any day in the period. Server snaps to the calendar month. */
  periodAnyDay: string;
  /** Decimal string. e.g. "1500" for 1,500 API calls. */
  quantity: string;
  /** Defaults to "US_GAAP" if unset. */
  bookCode?: string;
}

export interface RecordUsageState {
  ok: boolean;
  message?: string;
  scheduleId?: string;
  plannedAmount?: string;
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function endOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

export async function recordUsageAction(
  input: RecordUsageInput
): Promise<RecordUsageState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("post_recognition", tenant.role, canPostRecognition);

    if (!input.obligationId) {
      return { ok: false, message: "obligationId required." };
    }
    if (!input.periodAnyDay) {
      return { ok: false, message: "Period date required (any day in the month)." };
    }
    const someDay = new Date(input.periodAnyDay);
    if (Number.isNaN(someDay.getTime())) {
      return { ok: false, message: `Invalid date "${input.periodAnyDay}".` };
    }
    if (!input.quantity?.trim()) {
      return { ok: false, message: "Usage quantity required." };
    }
    let qty: Decimal;
    try {
      qty = new Decimal(input.quantity.trim());
      if (!qty.isFinite()) {
        return { ok: false, message: "Quantity must be a finite number." };
      }
      if (qty.lessThanOrEqualTo(0)) {
        return {
          ok: false,
          message: "Quantity must be > 0. To skip a period, just don't record anything.",
        };
      }
    } catch {
      return { ok: false, message: `Invalid quantity "${input.quantity}".` };
    }

    // Tenant-scope the PO lookup.
    const po = await prisma.performanceObligation.findFirst({
      where: {
        id: input.obligationId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: {
        id: true,
        recognitionPattern: true,
        pricePerUnit: true,
        unitName: true,
        startDate: true,
        endDate: true,
        contractId: true,
      },
    });
    if (!po) {
      return { ok: false, message: "Performance obligation not found in this workspace." };
    }
    if (po.recognitionPattern !== "OVER_TIME_USAGE") {
      return {
        ok: false,
        message: `This PO uses ${po.recognitionPattern} recognition, not OVER_TIME_USAGE. Use the standard recognition flow.`,
      };
    }
    if (po.pricePerUnit == null) {
      return {
        ok: false,
        message: "This PO has no pricePerUnit configured. Set it during contract approval.",
      };
    }

    const periodStart = startOfMonthUtc(someDay);
    const periodEnd = endOfMonthUtc(someDay);

    // Validate period within PO window. usage outside the contract term
    // is almost always a data-entry error; refuse loudly.
    if (periodEnd < po.startDate) {
      return {
        ok: false,
        message: `Period ends before the PO start date (${po.startDate.toISOString().slice(0, 10)}).`,
      };
    }
    if (po.endDate && periodStart > po.endDate) {
      return {
        ok: false,
        message: `Period starts after the PO end date (${po.endDate.toISOString().slice(0, 10)}).`,
      };
    }

    const bookCode = input.bookCode ?? "US_GAAP";

    // Refuse duplicates. The unique constraint (obligationId, bookCode,
    // periodStart) would catch this anyway, but a friendly error is
    // better than a P2002.
    const existing = await prisma.recognitionSchedule.findFirst({
      where: {
        obligationId: po.id,
        bookCode,
        periodStart,
      },
      select: { id: true, status: true, plannedAmount: true },
    });
    if (existing) {
      return {
        ok: false,
        message: `Usage already recorded for ${periodStart.toISOString().slice(0, 7)} on this PO (status ${existing.status}, amount $${existing.plannedAmount.toString()}). To change it, delete the existing row first (not yet supported via UI).`,
      };
    }

    const pricePerUnit = new Decimal(po.pricePerUnit.toString());
    const plannedAmount = qty.times(pricePerUnit).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

    const row = await prisma.recognitionSchedule.create({
      data: {
        contractId: po.contractId,
        obligationId: po.id,
        bookCode,
        periodStart,
        periodEnd,
        plannedAmount: plannedAmount.toFixed(4),
        usageQuantity: qty.toFixed(4),
        status: "PLANNED",
      },
      select: { id: true },
    });

    revalidatePath(`/contracts/${po.contractId}`);

    return {
      ok: true,
      scheduleId: row.id,
      plannedAmount: plannedAmount.toFixed(2),
      message: `Recorded ${qty.toString()} ${po.unitName ?? "units"} × $${pricePerUnit.toString()} = $${plannedAmount.toFixed(2)} for ${periodStart.toISOString().slice(0, 7)}. Click Post on the schedule row to push to ledger-core.`,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof PermissionDeniedError)
      return { ok: false, message: e.message };
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error",
    };
  }
}
