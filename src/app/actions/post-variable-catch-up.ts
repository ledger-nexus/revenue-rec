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
        reassessedAt: true,
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

    // Pass the entry number out of the transaction closure so the
    // success message can include it (Prisma's $transaction return
    // value uses the callback's return; we'd rather not refactor
    // signature for a small string carry-out).
    const postedEntryNumberRef: { value: string } = { value: "" };

    // ATOMICITY: wrap the bridge call + local writes in a single
    // transaction. If the local writes fail, the txn rolls back —
    // no partial state. The bridge call's POSTed JE survives if
    // ledger-core already persisted it, but ledger-core dedupes by
    // sourceRecordId (= reassess.id) so a retry of this action sees
    // the same JE returned and writes local state ONCE.
    //
    // Without the wrap, the bridge call succeeded BEFORE the local
    // txn started; if the local txn failed, the JE was orphaned
    // upstream AND the retry's bridge dedup returned the same JE,
    // but the local txn ran fresh anyway — creating duplicate
    // RecognitionEvent rows and double-incrementing recognizedToDate.
    //
    // Default Prisma interactive-tx timeout is 5s; bridge HTTP can
    // legitimately take 2-3s, so we bump to 30s.
    await prisma.$transaction(
      async (tx) => {
        // CLAIM the reassessment row by stamping postedAt while
        // postedEventId is still null. updateMany returns count;
        // 0 means a concurrent run already claimed (Postgres
        // serializes via row-level lock during updateMany; the
        // second tx unblocks AFTER the first commits with
        // postedEventId set, so the WHERE evaluates to no-match).
        //
        // This guards against the case where two clicks pass the
        // outer postedEventId check at line ~123 simultaneously,
        // both enter the transaction, both call the bridge (which
        // dedupes), and both proceed to create RecognitionEvents +
        // double-increment recognizedToDate.
        //
        // The bridge call runs AFTER the claim so we don't waste a
        // ledger-core POST in the race-loss case.
        const claim = await tx.variableConsiderationReassessment.updateMany({
          where: { id: reassess.id, postedEventId: null, postedAt: null },
          data: { postedAt: new Date() },
        });
        if (claim.count === 0) {
          throw new Error(
            "Catch-up already posted (or being posted by a concurrent request)"
          );
        }

        const posted = await postEntryViaLedgerCore({
          entityCode: reassess.variableConsideration.contract.entity.code,
          bookCode,
          currencyCode: reassess.variableConsideration.contract.currencyId,
          // Document date is the reassessment's economic date — NOT
          // `new Date()`. Posting at 23:59 on day N vs 00:01 on day
          // N+1 would otherwise land identical economic events in
          // different fiscal periods.
          documentDate: reassess.reassessedAt,
          memo,
          source: "AI_APPROVED",
          sourceSystem: "revenue-rec",
          sourceRecordType: "variable-consideration-catch-up",
          sourceRecordId: reassess.id,
          lines: jeBuild.lines,
        });

        // One RecognitionEvent per participating PO (per-PO catch-up
        // amounts are what we recorded in perObligationCatchUpJson).
        let firstEventId: string | null = null;
        for (const b of breakdown) {
          const amt = new Decimal(b.amount);
          if (amt.isZero()) continue;
          const po = obligationsById.get(b.obligationId)!;
          // Period dates: derived from the reassessment's economic
          // date so per-PO RecognitionEvents stamp consistently with
          // the upstream JE.
          const event = await tx.recognitionEvent.create({
            data: {
              contractId: reassess.variableConsideration.contractId,
              obligationId: po.id,
              bookCode,
              periodStart: reassess.reassessedAt,
              periodEnd: reassess.reassessedAt,
              amount: amt.toFixed(4),
              postedEntryId: posted.id,
              entryNumber: posted.entryNumber,
              postedBy: user.email,
            },
            select: { id: true },
          });
          if (firstEventId == null) firstEventId = event.id;
          // recognizedToDate increments by the catch-up amount
          // (which may be negative — Prisma's `increment` accepts
          // signed values).
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
        // Finalize the claim with the real postedEventId. postedAt
        // was set by the claim above (which guarded against
        // concurrent double-post); this update just records which
        // event row is the canonical pointer.
        await tx.variableConsiderationReassessment.update({
          where: { id: reassess.id },
          data: { postedEventId: firstEventId },
        });

        // Forward the entry number out of the transaction closure
        // for the success message.
        postedEntryNumberRef.value = posted.entryNumber;
      },
      { timeout: 30_000 }
    );

    revalidatePath(
      `/contracts/${reassess.variableConsideration.contractId}`
    );

    const entryNumber = postedEntryNumberRef.value;
    return {
      ok: true,
      message: `Posted ${entryNumber} (${jeBuild.lines.length} lines, ${totalCatchUp.toFixed(2)} total catch-up across ${perObligationInput.filter((p) => !new Decimal(p.catchUpAmount).isZero()).length} PO(s))`,
      entryNumber,
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
