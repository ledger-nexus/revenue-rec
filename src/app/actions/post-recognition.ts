"use server";

// Server Action: post ONE recognition period for a contract via the
// ledger-core HTTP bridge.
//
// Input is a specific RecognitionSchedule row by id. We avoid "next due"
// queries here because they create ordering races (two clicks within
// 100ms could both fire). The caller (UI) is responsible for picking
// which row to post.
//
// The JE shape for a recognition period:
//
//   On the very first recognition for a PO, we ALSO need to defer the
//   collected cash. v0.1 assumes cash has already been collected and
//   booked into deferred revenue (the standard SaaS flow: invoice up
//   front → AR cleared by payment → cash debited, deferred revenue
//   credited at full contract amount).
//
//   So the per-period JE is just the simple recognition pair:
//
//     DR  Deferred Revenue   (PO.deferredAccountCode)   plannedAmount
//     CR  Revenue            (PO.revenueAccountCode)    plannedAmount
//
//   This is the GAAP-correct entry to recognize one month of subscription
//   revenue against deferred revenue collected up front.
//
//   Multi-book future: when we add tax-basis (cash) recognition, the
//   tax book skips this entry entirely and recognizes when cash is
//   received. The bookCode field on RecognitionSchedule already
//   discriminates; we just emit US_GAAP rows in v0.2.
//
// On success:
//   - RecognitionSchedule.status → POSTED
//   - RecognitionSchedule.postedByEventId → new RecognitionEvent
//   - RecognitionEvent created with the returned entry id
//   - PerformanceObligation.recognizedToDate incremented
//   - RevenueContractBookAttributes.cumulativeRecognized incremented

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  postEntryViaLedgerCore,
  LedgerCoreError,
} from "@/lib/ledger-bridge";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

export interface PostRecognitionInput {
  scheduleId: string;
  postedBy?: string;
}

export interface PostRecognitionState {
  ok: boolean;
  message: string;
  entryNumber?: string;
}

export async function postRecognitionAction(
  input: PostRecognitionInput
): Promise<PostRecognitionState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // SECURITY (pen-test pass 4): tenant-scope the lookup via
    // schedule → contract → entity → tenantId. THIS WAS THE WORST
    // GAP in this repo — anonymous JE posting via the ledger bridge
    // against any tenant's schedule + state mutation of
    // recognizedToDate + cumulativeRecognized on the foreign tenant.
    const schedule = await prisma.recognitionSchedule.findFirst({
      where: {
        id: input.scheduleId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: {
        id: true,
        status: true,
        bookCode: true,
        periodStart: true,
        periodEnd: true,
        plannedAmount: true,
        obligationId: true,
        obligation: {
          select: {
            id: true,
            sequenceNo: true,
            description: true,
            revenueAccountCode: true,
            deferredAccountCode: true,
          },
        },
        contractId: true,
        contract: {
          select: {
            id: true,
            code: true,
            currencyId: true,
            entity: { select: { code: true } },
          },
        },
      },
    });
    if (!schedule) return { ok: false, message: "Schedule row not found in this tenant" };

    if (schedule.status !== "PLANNED") {
      return {
        ok: false,
        message: `Schedule is ${schedule.status} — only PLANNED rows may be posted`,
      };
    }

    const amount = new Decimal(schedule.plannedAmount.toString());
    if (amount.isZero()) {
      // Zero-amount periods skip silently — flip to SKIPPED without
      // creating an entry. Keeps the schedule auditable.
      await prisma.recognitionSchedule.update({
        where: { id: schedule.id },
        data: { status: "SKIPPED" },
      });
      revalidatePath(`/contracts/${schedule.contractId}`);
      return { ok: true, message: "Zero-amount period — skipped without posting." };
    }

    const memo = `${schedule.contract.code} — recognize ${schedule.obligation.description.slice(0, 60)}`;
    const posted = await postEntryViaLedgerCore({
      entityCode: schedule.contract.entity.code,
      bookCode: schedule.bookCode,
      currencyCode: schedule.contract.currencyId,
      documentDate: schedule.periodEnd,
      memo,
      source: "AI_APPROVED",
      sourceSystem: "revenue-rec",
      sourceRecordType: "recognition-schedule",
      sourceRecordId: schedule.id,
      lines: [
        {
          accountCode: schedule.obligation.deferredAccountCode,
          debit: amount,
          description: `Recognize ${schedule.contract.code} PO${schedule.obligation.sequenceNo}`,
        },
        {
          accountCode: schedule.obligation.revenueAccountCode,
          credit: amount,
          description: `Recognize ${schedule.contract.code} PO${schedule.obligation.sequenceNo}`,
        },
      ],
    });

    // Persist the local audit trail in one transaction.
    await prisma.$transaction(async (tx) => {
      const event = await tx.recognitionEvent.create({
        data: {
          contractId: schedule.contractId,
          obligationId: schedule.obligationId,
          bookCode: schedule.bookCode,
          periodStart: schedule.periodStart,
          periodEnd: schedule.periodEnd,
          amount: amount.toFixed(4),
          postedEntryId: posted.id,
          entryNumber: posted.entryNumber,
          // SECURITY: stamp the authenticated user, not caller-supplied input.
          postedBy: user.email,
        },
        select: { id: true },
      });
      await tx.recognitionSchedule.update({
        where: { id: schedule.id },
        data: { status: "POSTED", postedByEventId: event.id },
      });
      await tx.performanceObligation.update({
        where: { id: schedule.obligationId },
        data: { recognizedToDate: { increment: amount.toFixed(4) } },
      });
      // Bump cumulative recognized on the book attributes row (if it
      // exists — created at seed time for US_GAAP). Use updateMany so
      // a missing row doesn't error; the human can resolve later.
      await tx.revenueContractBookAttributes.updateMany({
        where: {
          contractId: schedule.contractId,
          book: { code: schedule.bookCode },
        },
        data: { cumulativeRecognized: { increment: amount.toFixed(4) } },
      });
    });

    revalidatePath(`/contracts/${schedule.contractId}`);

    return {
      ok: true,
      message: `Posted ${posted.entryNumber} for ${schedule.periodStart.toISOString().slice(0, 7)}.`,
      entryNumber: posted.entryNumber,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in to post recognition." };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, message: e.message };
    }
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: `ledger-core ${e.code}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
