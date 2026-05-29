"use server";

// Server Action: post the catch-up JE for a VariableConsiderationReassessment
// via the ledger-core HTTP bridge.
//
// Flow:
//   1. Tenant-scoped lookup of the reassessment row.
//   2. Idempotency gates:
//        - postedEventId already set → already posted; refuse
//        - catchUpAmount null or zero → nothing to post; refuse
//        - perObligationCatchUpJson null → no breakdown; refuse
//   3. Load each affected PO (revenue + deferred account codes).
//   4. Call buildCatchUpJe to compose the balanced JE lines.
//   5. Post via the bridge with source = AI_APPROVED (this is a
//      machine-computed adjustment, not human-typed).
//   6. Persist one RecognitionEvent per participating PO, increment
//      each PO's recognizedToDate, set the reassessment's
//      postedEventId + postedAt.
//
// Why one JE not N JEs: the per-PO catch-ups all derive from the same
// reassessment event — they're ONE accounting event, not N. Splitting
// would clutter the GL. RecognitionEvents are still per-PO (one event
// per PO with non-zero catch-up) so the per-PO recognition story is
// recoverable from the events table.
//
// Account convention same as postRecognitionAction:
//   Positive catch-up (more revenue): DR Deferred Rev, CR Revenue
//   Negative catch-up (reversal):     DR Revenue, CR Deferred Rev
//
// SECURITY: full tenant-scope via reassessment → variable consideration
// → contract → entity → tenantId chain. Without it, anyone signed in
// could post a JE against any tenant's books — the same gap that
// originally landed pen-test pass 4 fixes in this repo.

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
import {
  buildCatchUpJe,
  CatchUpBuildError,
} from "@/lib/accounting/catch-up-je";

export interface PostVariableCatchUpInput {
  reassessmentId: string;
  /** Optional book — defaults to the contract's primary book (US_GAAP). */
  bookCode?: string;
}

export interface PostVariableCatchUpState {
  ok: boolean;
  message: string;
  entryNumber?: string;
}

interface PerObligationCatchUp {
  obligationId: string;
  amount: string;
}

function isPerObligationArray(v: unknown): v is PerObligationCatchUp[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        e != null &&
        typeof e === "object" &&
        typeof (e as Record<string, unknown>).obligationId === "string" &&
        typeof (e as Record<string, unknown>).amount === "string"
    )
  );
}

export async function postVariableCatchUpAction(
  input: PostVariableCatchUpInput
): Promise<PostVariableCatchUpState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const reassess = await prisma.variableConsiderationReassessment.findFirst({
      where: {
        id: input.reassessmentId,
        variableConsideration: {
          contract: { entity: { tenantId: tenant.id } },
        },
      },
      select: {
        id: true,
        catchUpAmount: true,
        perObligationCatchUpJson: true,
        postedEventId: true,
        rationale: true,
        variableConsideration: {
          select: {
            id: true,
            description: true,
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
        },
      },
    });
    if (!reassess) {
      return { ok: false, message: "Reassessment not found in this tenant" };
    }
    if (reassess.postedEventId) {
      return { ok: false, message: "Catch-up already posted for this reassessment" };
    }
    if (reassess.catchUpAmount == null) {
      return {
        ok: false,
        message: "Reassessment has no catch-up amount (no allocator state — contract had no POs at reassessment time)",
      };
    }
    const totalCatchUp = new Decimal(reassess.catchUpAmount.toString());
    if (totalCatchUp.isZero()) {
      return { ok: false, message: "Catch-up amount is zero — nothing to post" };
    }
    if (!isPerObligationArray(reassess.perObligationCatchUpJson)) {
      return {
        ok: false,
        message: "Per-PO catch-up breakdown is missing (legacy reassessment row predating v0.4 catch-up posting)",
      };
    }

    const breakdown = reassess.perObligationCatchUpJson;
    const obligationIds = breakdown.map((b) => b.obligationId);

    // Load each PO's account codes. Tenant-scope through the contract
    // FK so a malicious obligationId from a foreign tenant can't sneak
    // in (defense in depth — perObligationCatchUpJson is written by
    // our own reassess action, but JSON columns are not Prisma-typed
    // so we don't get static guarantees).
    const obligations = await prisma.performanceObligation.findMany({
      where: {
        id: { in: obligationIds },
        contractId: reassess.variableConsideration.contractId,
      },
      select: {
        id: true,
        sequenceNo: true,
        revenueAccountCode: true,
        deferredAccountCode: true,
      },
    });
    if (obligations.length !== breakdown.length) {
      return {
        ok: false,
        message: `Stale breakdown: ${breakdown.length} POs referenced, ${obligations.length} resolvable. The contract's POs may have changed since reassessment.`,
      };
    }
    const obligationsById = new Map(obligations.map((o) => [o.id, o]));

    // Build the JE lines via the pure helper.
    const perObligationInput = breakdown
      .map((b) => {
        const po = obligationsById.get(b.obligationId);
        if (!po) return null;
        return {
          obligationId: b.obligationId,
          sequenceNo: po.sequenceNo,
          revenueAccountCode: po.revenueAccountCode,
          deferredAccountCode: po.deferredAccountCode,
          catchUpAmount: b.amount,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    let jeBuild;
    try {
      jeBuild = buildCatchUpJe({
        contractCode: reassess.variableConsideration.contract.code,
        reassessmentDescription:
          reassess.variableConsideration.description +
          " — " +
          reassess.rationale.slice(0, 80),
        perObligation: perObligationInput,
      });
    } catch (e) {
      if (e instanceof CatchUpBuildError) {
        return { ok: false, message: e.message };
      }
      throw e;
    }

    const bookCode = input.bookCode ?? "US_GAAP";
    const memo = `${reassess.variableConsideration.contract.code} — variable consideration catch-up: ${reassess.variableConsideration.description}`;

    const posted = await postEntryViaLedgerCore({
      entityCode: reassess.variableConsideration.contract.entity.code,
      bookCode,
      currencyCode: reassess.variableConsideration.contract.currencyId,
      documentDate: new Date(),
      memo,
      source: "AI_APPROVED",
      sourceSystem: "revenue-rec",
      sourceRecordType: "variable-consideration-catch-up",
      sourceRecordId: reassess.id,
      lines: jeBuild.lines,
    });

    // Persist the local audit trail in one transaction.
    await prisma.$transaction(async (tx) => {
      // One RecognitionEvent per participating PO (per-PO catch-up
      // amounts are what we recorded in perObligationCatchUpJson).
      for (const b of breakdown) {
        const amt = new Decimal(b.amount);
        if (amt.isZero()) continue;
        const po = obligationsById.get(b.obligationId)!;
        // Period dates: collapse to "today" — variable consideration
        // catch-ups don't have a natural period like recognition
        // schedule rows do. The reassessedAt date on the parent row
        // is the canonical timing; we mirror it here for consistency
        // with other RecognitionEvents.
        const today = new Date();
        await tx.recognitionEvent.create({
          data: {
            contractId: reassess.variableConsideration.contractId,
            obligationId: po.id,
            bookCode,
            periodStart: today,
            periodEnd: today,
            amount: amt.toFixed(4),
            postedEntryId: posted.id,
            entryNumber: posted.entryNumber,
            postedBy: user.email,
          },
        });
        // recognizedToDate increments by the catch-up amount (which
        // may be negative — Prisma's `increment` accepts signed
        // values).
        await tx.performanceObligation.update({
          where: { id: po.id },
          data: { recognizedToDate: { increment: amt.toFixed(4) } },
        });
      }
      // Bump cumulative recognized on book attributes (signed too).
      await tx.revenueContractBookAttributes.updateMany({
        where: {
          contractId: reassess.variableConsideration.contractId,
          book: { code: bookCode },
        },
        data: { cumulativeRecognized: { increment: totalCatchUp.toFixed(4) } },
      });
      // Stamp postedEventId + postedAt on the reassessment so it can't
      // be double-posted. We point at the FIRST RecognitionEvent we
      // created — sufficient for the audit trail (the JE itself links
      // to all of them).
      const firstEvent = await tx.recognitionEvent.findFirst({
        where: { postedEntryId: posted.id },
        orderBy: { postedAt: "asc" },
        select: { id: true },
      });
      await tx.variableConsiderationReassessment.update({
        where: { id: reassess.id },
        data: {
          postedEventId: firstEvent?.id ?? null,
          postedAt: new Date(),
        },
      });
    });

    revalidatePath(
      `/contracts/${reassess.variableConsideration.contractId}`
    );

    return {
      ok: true,
      message: `Posted ${posted.entryNumber} (${jeBuild.lines.length} lines, ${totalCatchUp.toFixed(2)} total catch-up across ${perObligationInput.filter((p) => !new Decimal(p.catchUpAmount).isZero()).length} PO(s))`,
      entryNumber: posted.entryNumber,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in." };
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
