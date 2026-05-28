"use server";

// Server Action: human reviewed an AiExtractionSuggestion and approved
// it. This is where the AI's proposal becomes structured ledger data:
//
//   1. Replace the contract's existing POs with the approved ones
//      (sequenceNo, description, recognitionPattern, dates, accounts).
//   2. Re-run the deterministic allocator on the approved SSPs +
//      total contract value to compute final allocated amounts.
//   3. Regenerate the RecognitionSchedule for each PO under US_GAAP.
//   4. Set contract status to ACTIVE.
//
// This action does NOT post any JE yet. Deferred-revenue posting on
// approval is a v0.2-beta enhancement; for v0.2 the recognition
// posting (via postRecognitionAction) does both the deferral and the
// recognition implicitly when each period fires.
//
// Idempotency: re-approving with the same data wipes the existing POs
// and replaces them. The schedule is also replaced. Cascade deletes
// handle child rows. This is the "trust the latest approval" policy.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { allocateTransactionPrice } from "@/lib/accounting/allocator";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  generateSchedule,
  type RecognitionPattern,
} from "@/lib/accounting/schedule";
import {
  computeAdjustedTransactionPrice,
  type VariableConsiderationComponent,
} from "@/lib/accounting/variable-consideration";

export interface ApproveInput {
  contractId: string;
  // The POs the human approved (possibly edited from the AI's proposal).
  // sequenceNo, description, ssp, recognitionPattern, dates, accounts.
  performanceObligations: Array<{
    sequenceNo: number;
    description: string;
    ssp: number;
    recognitionPattern: RecognitionPattern;
    startDate: string; // YYYY-MM-DD
    endDate: string | null;
    revenueAccountCode: string;
    deferredAccountCode: string;
  }>;
  // Caller may also adjust the contract's total + dates if the AI got
  // them wrong. All optional — falls back to existing contract values.
  totalContractValue?: number;
  contractStartDate?: string;
  contractEndDate?: string | null;
}

export interface ApproveState {
  ok: boolean;
  message: string;
  poCount?: number;
  scheduleRowCount?: number;
}

export async function approveExtractionAction(
  input: ApproveInput
): Promise<ApproveState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // SECURITY (pen-test pass 4): tenant-scope the contract lookup.
    // Without this, a foreign-tenant contract could be wiped/replaced
    // by any signed-in user — deleteMany on POs, replace with new
    // ones, flip status to ACTIVE.
    const contract = await prisma.revenueContract.findFirst({
      where: { id: input.contractId, entity: { tenantId: tenant.id } },
      select: {
        id: true,
        totalContractValue: true,
        contractStartDate: true,
        contractEndDate: true,
        // Pull variable consideration so the allocator runs against
        // the adjusted transaction price, not the bare contract total.
        // Approval is the moment the deterministic engine "owns" the
        // contract — it has to consume variable consideration the
        // same way subsequent reassessments will.
        variableConsiderations: {
          where: { status: "ACTIVE" },
          select: {
            id: true,
            description: true,
            method: true,
            direction: true,
            status: true,
            currentConstrainedAmount: true,
            currentUnconstrainedAmount: true,
          },
        },
      },
    });
    if (!contract) return { ok: false, message: "Contract not found in this tenant" };

    if (input.performanceObligations.length === 0) {
      return { ok: false, message: "At least one performance obligation required" };
    }

    // Apply variable consideration adjustment to the base contract
    // value BEFORE allocating. The allocator and schedule generator
    // are unchanged — they always work on the adjusted price.
    const baseTotal = new Decimal(
      input.totalContractValue ?? contract.totalContractValue.toString()
    );
    const variableComponents: VariableConsiderationComponent[] =
      contract.variableConsiderations.map((c) => ({
        id: c.id,
        description: c.description,
        method: c.method,
        direction: c.direction,
        status: c.status,
        constrainedAmount: c.currentConstrainedAmount.toString(),
        unconstrainedAmount: c.currentUnconstrainedAmount.toString(),
      }));
    const adjusted = computeAdjustedTransactionPrice({
      baseAmount: baseTotal,
      components: variableComponents,
    });
    const total = adjusted.adjustedAmount;

    const allocations = allocateTransactionPrice({
      totalContractValue: total,
      performanceObligations: input.performanceObligations.map((po) => ({
        sequenceNo: po.sequenceNo,
        description: po.description,
        ssp: po.ssp,
      })),
    });

    // Allocated amount per PO, keyed by sequenceNo.
    const allocatedBySeq = new Map<number, Decimal>(
      allocations.map((a) => [a.sequenceNo, a.allocatedAmount])
    );

    const startDate = input.contractStartDate
      ? new Date(input.contractStartDate)
      : contract.contractStartDate;
    const endDateInput =
      input.contractEndDate === undefined ? contract.contractEndDate : input.contractEndDate;
    const endDate = endDateInput ? new Date(endDateInput) : null;

    let scheduleRowCount = 0;

    await prisma.$transaction(async (tx) => {
      // Wipe existing POs + cascaded schedule rows. Recognition events
      // (already-posted JEs) survive because they're keyed on
      // contractId, not obligationId — and we want history preserved
      // even when a contract is re-approved.
      //
      // CASCADE on PerformanceObligation → RecognitionSchedule handles
      // the schedule cleanup. RecognitionEvent's obligation FK doesn't
      // cascade so events stay attached to the contract.
      await tx.performanceObligation.deleteMany({ where: { contractId: contract.id } });

      // Update contract metadata in case dates / total changed.
      await tx.revenueContract.update({
        where: { id: contract.id },
        data: {
          totalContractValue: total.toFixed(4),
          contractStartDate: startDate,
          contractEndDate: endDate,
          status: "ACTIVE",
        },
      });

      // Create fresh POs.
      for (const po of input.performanceObligations) {
        const allocated = allocatedBySeq.get(po.sequenceNo);
        if (!allocated) {
          throw new Error(
            `Allocator missed PO #${po.sequenceNo} — internal invariant`
          );
        }
        const createdPo = await tx.performanceObligation.create({
          data: {
            contractId: contract.id,
            sequenceNo: po.sequenceNo,
            description: po.description,
            ssp: allocated.toFixed(4),
            recognitionPattern: po.recognitionPattern,
            startDate: new Date(po.startDate),
            endDate: po.endDate ? new Date(po.endDate) : null,
            revenueAccountCode: po.revenueAccountCode,
            deferredAccountCode: po.deferredAccountCode,
          },
          select: { id: true },
        });

        // Generate the schedule for this PO and persist it.
        const periods = generateSchedule({
          pattern: po.recognitionPattern,
          allocatedAmount: allocated,
          startDate: new Date(po.startDate),
          endDate: po.endDate ? new Date(po.endDate) : undefined,
        });
        if (periods.length > 0) {
          await tx.recognitionSchedule.createMany({
            data: periods.map((p) => ({
              contractId: contract.id,
              obligationId: createdPo.id,
              bookCode: "US_GAAP",
              periodStart: p.periodStart,
              periodEnd: p.periodEnd,
              plannedAmount: p.plannedAmount.toFixed(4),
              status: "PLANNED",
            })),
          });
          scheduleRowCount += periods.length;
        }
      }
    });

    revalidatePath(`/contracts/${input.contractId}`);

    return {
      ok: true,
      message: `Approved ${input.performanceObligations.length} PO(s); generated ${scheduleRowCount} schedule row(s).`,
      poCount: input.performanceObligations.length,
      scheduleRowCount,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
