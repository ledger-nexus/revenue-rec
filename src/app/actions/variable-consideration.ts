"use server";

// Server Actions for ASC 606 variable consideration.
//
// Four operations:
//
//   addVariableConsiderationAction — operator records a new variable
//     component (with optional EXPECTED_VALUE outcomes). The contract's
//     adjusted transaction price is recomputed and the allocator +
//     schedule generator re-run. An initial reassessment row is
//     persisted as the audit baseline (priorAmount=null).
//
//   reassessVariableConsiderationAction — operator updates the
//     constrained / unconstrained amounts on an existing component
//     (e.g., quarter close, new information). The math module computes
//     the cumulative catch-up across all POs based on each PO's
//     recognizedToDate progress. The action persists a
//     VariableConsiderationReassessment row and updates current
//     amounts; future periods will use the new estimate. NOTE: this
//     action does NOT post the catch-up JE itself — it computes and
//     returns the amount; the operator confirms via a separate
//     "post catch-up" step (postVariableCatchUpAction below).
//
//   resolveVariableConsiderationAction — variable amount has
//     materialized to an actual value (bonus paid, refund window
//     closed). Final reassessment runs with the actual amount in
//     both constrained and unconstrained, status flips to RESOLVED,
//     and the component drops out of the active transaction price
//     going forward.
//
//   removeVariableConsiderationAction — operator marks a component
//     REVERSED (contract amended away, AI false positive). Same
//     reassessment math runs with constrained=0 → estimate removed
//     from transaction price, catch-up posts if there was any
//     historical recognition under it.
//
// The deterministic math (transaction price, catch-up amounts) lives
// in src/lib/accounting/variable-consideration.ts — these actions are
// the DB + auth wrapper.
//
// Posting: the catch-up JE itself goes through the same HTTP bridge
// to ledger-core that recognition events use. A separate
// postVariableCatchUpAction (below) takes a reassessment id and posts
// the recorded catchUpAmount as a single 2-line JE. Splitting
// reassessment from posting matches the established "compute → review
// → post" rhythm the rest of revenue-rec uses.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { allocateTransactionPrice } from "@/lib/accounting/allocator";
import {
  computeAdjustedTransactionPrice,
  computeReassessmentCatchUp,
  validateConstraint,
  type VariableConsiderationComponent,
  type VariableConsiderationDirection,
  type VariableConsiderationMethod,
} from "@/lib/accounting/variable-consideration";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface VarConsOutcomeInput {
  scenario: string;
  amount: number;
  probabilityPercent: number;
}

export interface AddVarConsInput {
  contractId: string;
  description: string;
  method: VariableConsiderationMethod;
  direction: VariableConsiderationDirection;
  unconstrainedAmount: number;
  constrainedAmount: number;
  constraintRationale: string;
  /** Optional: PO this component is tied to. Null = whole-contract. */
  obligationId?: string | null;
  /** Optional: only meaningful for EXPECTED_VALUE method. */
  outcomes?: VarConsOutcomeInput[];
}

export interface ReassessVarConsInput {
  variableConsiderationId: string;
  newUnconstrainedAmount: number;
  newConstrainedAmount: number;
  rationale: string;
  /** Replace outcomes (EXPECTED_VALUE method). Pass an empty array to clear. */
  outcomes?: VarConsOutcomeInput[];
}

export interface ResolveVarConsInput {
  variableConsiderationId: string;
  actualAmount: number;
  rationale: string;
}

export interface RemoveVarConsInput {
  variableConsiderationId: string;
  rationale: string;
}

export interface VarConsActionResult {
  ok: boolean;
  message: string;
  /** Cumulative catch-up that posted (or would post) as a result. */
  catchUpAmount?: string; // Decimal.toFixed(2)
  /** Audit row id for the operation. */
  reassessmentId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all data the reassessment math needs: the contract's base
 * value, every existing ACTIVE component, and every PO's current
 * allocation + recognition state. Used by all four entry points so
 * the data shape is consistent.
 */
async function loadContractState(
  tx: Pick<typeof prisma, "revenueContract">,
  contractId: string,
  tenantId: string
) {
  const contract = await tx.revenueContract.findFirst({
    where: { id: contractId, entity: { tenantId } },
    select: {
      id: true,
      totalContractValue: true,
      performanceObligations: {
        select: {
          id: true,
          sequenceNo: true,
          description: true,
          ssp: true,
          recognizedToDate: true,
        },
      },
      variableConsiderations: {
        where: { status: { not: "REVERSED" } },
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
  return contract;
}

/**
 * Convert a DB row to the math module's component shape. Stable seam
 * for tests + reuse across the four actions.
 */
function toComponent(
  c: {
    id: string;
    description: string;
    method: VariableConsiderationMethod;
    direction: VariableConsiderationDirection;
    status: "ACTIVE" | "RESOLVED" | "REVERSED";
    currentConstrainedAmount: { toString(): string } | Decimal;
    currentUnconstrainedAmount: { toString(): string } | Decimal;
  }
): VariableConsiderationComponent {
  return {
    id: c.id,
    description: c.description,
    method: c.method,
    direction: c.direction,
    status: c.status,
    constrainedAmount: c.currentConstrainedAmount.toString(),
    unconstrainedAmount: c.currentUnconstrainedAmount.toString(),
  };
}

/**
 * Given old + new component lists, compute the catch-up amounts per PO.
 * Wraps the math module: re-runs the SSP allocator with the new
 * adjusted price, then asks the math module for the catch-up given
 * each PO's recognizedToDate.
 */
function computeCatchUpForReallocation(input: {
  base: Decimal;
  oldComponents: VariableConsiderationComponent[];
  newComponents: VariableConsiderationComponent[];
  pos: Array<{
    id: string;
    sequenceNo: number;
    description: string;
    ssp: Decimal;
    recognizedToDate: Decimal;
  }>;
}) {
  const oldAdjusted = computeAdjustedTransactionPrice({
    baseAmount: input.base,
    components: input.oldComponents,
  });
  const newAdjusted = computeAdjustedTransactionPrice({
    baseAmount: input.base,
    components: input.newComponents,
  });

  // Re-allocate at both prices to find each PO's old + new allocation.
  const oldAlloc = allocateTransactionPrice({
    totalContractValue: oldAdjusted.adjustedAmount,
    performanceObligations: input.pos.map((p) => ({
      sequenceNo: p.sequenceNo,
      description: p.description,
      ssp: p.ssp,
    })),
  });
  const newAlloc = allocateTransactionPrice({
    totalContractValue: newAdjusted.adjustedAmount,
    performanceObligations: input.pos.map((p) => ({
      sequenceNo: p.sequenceNo,
      description: p.description,
      ssp: p.ssp,
    })),
  });

  const oldBySeq = new Map(oldAlloc.map((a) => [a.sequenceNo, a.allocatedAmount]));
  const newBySeq = new Map(newAlloc.map((a) => [a.sequenceNo, a.allocatedAmount]));

  const catchUp = computeReassessmentCatchUp({
    obligations: input.pos.map((p) => ({
      id: p.id,
      oldAllocated: oldBySeq.get(p.sequenceNo) ?? new Decimal(0),
      newAllocated: newBySeq.get(p.sequenceNo) ?? new Decimal(0),
      recognizedToDate: p.recognizedToDate,
    })),
  });

  return { oldAdjusted, newAdjusted, oldAlloc, newAlloc, catchUp };
}

// ─────────────────────────────────────────────────────────────────────────────
// Add
// ─────────────────────────────────────────────────────────────────────────────

export async function addVariableConsiderationAction(
  input: AddVarConsInput
): Promise<VarConsActionResult> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // Validate the constraint invariant before touching the DB.
    validateConstraint({
      unconstrainedAmount: input.unconstrainedAmount,
      constrainedAmount: input.constrainedAmount,
      rationale: input.constraintRationale,
    });

    const contract = await loadContractState(prisma, input.contractId, tenant.id);
    if (!contract) return { ok: false, message: "Contract not found in this tenant" };

    // Validate the optional obligation linkage.
    if (input.obligationId) {
      const owned = contract.performanceObligations.some((p) => p.id === input.obligationId);
      if (!owned) {
        return { ok: false, message: "obligationId does not belong to this contract" };
      }
    }

    const base = new Decimal(contract.totalContractValue.toString());
    const oldComponents = contract.variableConsiderations
      .filter((c) => c.status === "ACTIVE")
      .map((c) => toComponent(c as Parameters<typeof toComponent>[0]));
    const newComponent: VariableConsiderationComponent = {
      description: input.description,
      method: input.method,
      direction: input.direction,
      status: "ACTIVE",
      constrainedAmount: input.constrainedAmount,
      unconstrainedAmount: input.unconstrainedAmount,
    };
    const newComponents = [...oldComponents, newComponent];

    const pos = contract.performanceObligations.map((p) => ({
      id: p.id,
      sequenceNo: p.sequenceNo,
      description: p.description,
      ssp: new Decimal(p.ssp.toString()),
      recognizedToDate: new Decimal(p.recognizedToDate.toString()),
    }));

    // The catch-up calculation gracefully handles "no POs yet" — but
    // only when the contract has zero POs there's no math to do. Guard.
    const hasPOs = pos.length > 0;
    const summary = hasPOs
      ? computeCatchUpForReallocation({
          base,
          oldComponents,
          newComponents,
          pos,
        })
      : null;

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.variableConsideration.create({
        data: {
          contractId: contract.id,
          obligationId: input.obligationId ?? null,
          description: input.description,
          method: input.method,
          direction: input.direction,
          status: "ACTIVE",
          currentUnconstrainedAmount: new Decimal(input.unconstrainedAmount).toFixed(4),
          currentConstrainedAmount: new Decimal(input.constrainedAmount).toFixed(4),
          constraintRationale: input.constraintRationale,
        },
        select: { id: true },
      });

      if (input.outcomes && input.outcomes.length > 0) {
        await tx.variableConsiderationOutcome.createMany({
          data: input.outcomes.map((o) => ({
            variableConsiderationId: created.id,
            scenario: o.scenario,
            amount: new Decimal(o.amount).toFixed(4),
            probabilityPercent: new Decimal(o.probabilityPercent).toFixed(4),
          })),
        });
      }

      // Initial reassessment row — establishes the audit baseline.
      const reassess = await tx.variableConsiderationReassessment.create({
        data: {
          variableConsiderationId: created.id,
          priorConstrainedAmount: null,
          priorUnconstrainedAmount: null,
          newConstrainedAmount: new Decimal(input.constrainedAmount).toFixed(4),
          newUnconstrainedAmount: new Decimal(input.unconstrainedAmount).toFixed(4),
          catchUpAmount: summary ? summary.catchUp.totalCatchUp.toFixed(4) : null,
          // Per-PO breakdown frozen at reassessment time. On the
          // initial baseline the catch-up is zero (no prior
          // recognition to true up against) — store the breakdown
          // anyway so the audit trail is consistent.
          perObligationCatchUpJson: summary
            ? summary.catchUp.perObligation.map((p) => ({
                obligationId: p.id,
                amount: p.catchUp.toFixed(4),
              }))
            : Prisma.JsonNull,
          rationale: input.constraintRationale,
          reassessedBy: user.email,
        },
        select: { id: true },
      });

      return { created, reassess, catchUp: summary?.catchUp.totalCatchUp };
    });

    revalidatePath(`/contracts/${input.contractId}`);
    return {
      ok: true,
      message: `Added variable consideration component "${input.description}"`,
      catchUpAmount: result.catchUp ? result.catchUp.toFixed(2) : "0.00",
      reassessmentId: result.reassess.id,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reassess
// ─────────────────────────────────────────────────────────────────────────────

export async function reassessVariableConsiderationAction(
  input: ReassessVarConsInput
): Promise<VarConsActionResult> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    validateConstraint({
      unconstrainedAmount: input.newUnconstrainedAmount,
      constrainedAmount: input.newConstrainedAmount,
      rationale: input.rationale,
    });

    const target = await prisma.variableConsideration.findFirst({
      where: {
        id: input.variableConsiderationId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: {
        id: true,
        contractId: true,
        status: true,
        currentConstrainedAmount: true,
        currentUnconstrainedAmount: true,
      },
    });
    if (!target) return { ok: false, message: "Variable consideration not found in this tenant" };
    if (target.status !== "ACTIVE") {
      return {
        ok: false,
        message: `Cannot reassess a ${target.status} component — only ACTIVE components are reassessable`,
      };
    }

    const contract = await loadContractState(prisma, target.contractId, tenant.id);
    if (!contract) return { ok: false, message: "Parent contract not found" };

    const base = new Decimal(contract.totalContractValue.toString());

    // Build old and new component lists. The reassessed row swaps in
    // the new amounts; all other ACTIVE components stay as they are.
    const oldComponents = contract.variableConsiderations
      .filter((c) => c.status === "ACTIVE")
      .map((c) => toComponent(c as Parameters<typeof toComponent>[0]));
    const newComponents = oldComponents.map((c) =>
      c.id === target.id
        ? {
            ...c,
            constrainedAmount: input.newConstrainedAmount,
            unconstrainedAmount: input.newUnconstrainedAmount,
          }
        : c
    );

    const pos = contract.performanceObligations.map((p) => ({
      id: p.id,
      sequenceNo: p.sequenceNo,
      description: p.description,
      ssp: new Decimal(p.ssp.toString()),
      recognizedToDate: new Decimal(p.recognizedToDate.toString()),
    }));

    if (pos.length === 0) {
      // No POs allocated yet — just update the estimate, no catch-up.
      const r = await prisma.$transaction(async (tx) => {
        await tx.variableConsideration.update({
          where: { id: target.id },
          data: {
            currentConstrainedAmount: new Decimal(input.newConstrainedAmount).toFixed(4),
            currentUnconstrainedAmount: new Decimal(input.newUnconstrainedAmount).toFixed(4),
            constraintRationale: input.rationale,
          },
        });
        if (input.outcomes) {
          await tx.variableConsiderationOutcome.deleteMany({
            where: { variableConsiderationId: target.id },
          });
          if (input.outcomes.length > 0) {
            await tx.variableConsiderationOutcome.createMany({
              data: input.outcomes.map((o) => ({
                variableConsiderationId: target.id,
                scenario: o.scenario,
                amount: new Decimal(o.amount).toFixed(4),
                probabilityPercent: new Decimal(o.probabilityPercent).toFixed(4),
              })),
            });
          }
        }
        const reassess = await tx.variableConsiderationReassessment.create({
          data: {
            variableConsiderationId: target.id,
            priorConstrainedAmount: target.currentConstrainedAmount.toString(),
            priorUnconstrainedAmount: target.currentUnconstrainedAmount.toString(),
            newConstrainedAmount: new Decimal(input.newConstrainedAmount).toFixed(4),
            newUnconstrainedAmount: new Decimal(input.newUnconstrainedAmount).toFixed(4),
            catchUpAmount: null,
            rationale: input.rationale,
            reassessedBy: user.email,
          },
          select: { id: true },
        });
        return { reassess };
      });
      revalidatePath(`/contracts/${target.contractId}`);
      return {
        ok: true,
        message: "Reassessment recorded; no allocations to update (contract has no POs yet)",
        catchUpAmount: "0.00",
        reassessmentId: r.reassess.id,
      };
    }

    const summary = computeCatchUpForReallocation({
      base,
      oldComponents,
      newComponents,
      pos,
    });

    const result = await prisma.$transaction(async (tx) => {
      await tx.variableConsideration.update({
        where: { id: target.id },
        data: {
          currentConstrainedAmount: new Decimal(input.newConstrainedAmount).toFixed(4),
          currentUnconstrainedAmount: new Decimal(input.newUnconstrainedAmount).toFixed(4),
          constraintRationale: input.rationale,
        },
      });

      // Update PO ssp to reflect the new allocated amount. This keeps
      // the contract's allocation in sync with the new transaction
      // price; otherwise the next post-recognition would still use the
      // old allocation. The math module ensures Σ(newAllocated) =
      // adjusted transaction price exactly.
      for (const perPo of summary.catchUp.perObligation) {
        const newAllocated = summary.newAlloc.find(
          (a) => a.sequenceNo === pos.find((p) => p.id === perPo.id)!.sequenceNo
        )!;
        await tx.performanceObligation.update({
          where: { id: perPo.id },
          data: {
            ssp: newAllocated.allocatedAmount.toFixed(4),
            // recognizedToDate is updated when the catch-up JE posts,
            // NOT here. The reassessment records the intent; the
            // posting realizes it.
          },
        });
      }

      if (input.outcomes) {
        await tx.variableConsiderationOutcome.deleteMany({
          where: { variableConsiderationId: target.id },
        });
        if (input.outcomes.length > 0) {
          await tx.variableConsiderationOutcome.createMany({
            data: input.outcomes.map((o) => ({
              variableConsiderationId: target.id,
              scenario: o.scenario,
              amount: new Decimal(o.amount).toFixed(4),
              probabilityPercent: new Decimal(o.probabilityPercent).toFixed(4),
            })),
          });
        }
      }

      const reassess = await tx.variableConsiderationReassessment.create({
        data: {
          variableConsiderationId: target.id,
          priorConstrainedAmount: target.currentConstrainedAmount.toString(),
          priorUnconstrainedAmount: target.currentUnconstrainedAmount.toString(),
          newConstrainedAmount: new Decimal(input.newConstrainedAmount).toFixed(4),
          newUnconstrainedAmount: new Decimal(input.newUnconstrainedAmount).toFixed(4),
          catchUpAmount: summary.catchUp.totalCatchUp.toFixed(4),
          // Freeze the per-PO breakdown now — by the time the
          // operator clicks "Post catch-up", each PO.ssp will have
          // been updated to the NEW allocation (we do it below), so
          // we can no longer derive the per-PO delta from current
          // state.
          perObligationCatchUpJson: summary.catchUp.perObligation.map((p) => ({
            obligationId: p.id,
            amount: p.catchUp.toFixed(4),
          })),
          rationale: input.rationale,
          reassessedBy: user.email,
        },
        select: { id: true },
      });

      // Update the parent contract's totalContractValue so downstream
      // recognition (post-recognition action, allocator re-runs) uses
      // the adjusted price. This is the "live" transaction price.
      await tx.revenueContract.update({
        where: { id: contract.id },
        data: {
          totalContractValue: summary.newAdjusted.adjustedAmount.toFixed(4),
        },
      });

      return { reassess };
    });

    revalidatePath(`/contracts/${target.contractId}`);
    return {
      ok: true,
      message: `Reassessment recorded; cumulative catch-up of ${summary.catchUp.totalCatchUp.toFixed(2)} pending posting`,
      catchUpAmount: summary.catchUp.totalCatchUp.toFixed(2),
      reassessmentId: result.reassess.id,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve (variable amount realized to an actual)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveVariableConsiderationAction(
  input: ResolveVarConsInput
): Promise<VarConsActionResult> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const target = await prisma.variableConsideration.findFirst({
      where: {
        id: input.variableConsiderationId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: {
        id: true,
        contractId: true,
        status: true,
        currentConstrainedAmount: true,
        currentUnconstrainedAmount: true,
      },
    });
    if (!target) return { ok: false, message: "Variable consideration not found in this tenant" };
    if (target.status !== "ACTIVE") {
      return {
        ok: false,
        message: `Cannot resolve a ${target.status} component`,
      };
    }
    if (input.actualAmount < 0) {
      return { ok: false, message: "actualAmount must be non-negative" };
    }

    // Re-do the reassessment math with constrained = unconstrained =
    // actual amount, then mark status RESOLVED so it drops out of the
    // active price next time. The catch-up brings prior-recognized
    // revenue in line with the actual.
    const reassessment = await reassessVariableConsiderationAction({
      variableConsiderationId: target.id,
      newUnconstrainedAmount: input.actualAmount,
      newConstrainedAmount: input.actualAmount,
      rationale: `RESOLVED: ${input.rationale}`,
    });
    if (!reassessment.ok) return reassessment;

    // ATOMICITY: status flip + contract total recompute must commit
    // together. Audit-pass fix — the previous version did two
    // standalone updates, so a partial failure could leave the
    // component reassessed-but-not-RESOLVED (audit trail says
    // "actual: $X" but status is still ACTIVE).
    //
    // Note: we re-fetch the contract INSIDE the transaction so the
    // recompute sees the reassessment's update to totalContractValue
    // (which committed before this call returned).
    await prisma.$transaction(async (tx) => {
      await tx.variableConsideration.update({
        where: { id: target.id },
        data: {
          status: "RESOLVED",
          resolvedAmount: new Decimal(input.actualAmount).toFixed(4),
          resolvedAt: new Date(),
          resolvedBy: user.email,
        },
      });

      // Recompute the contract's total now that the resolved
      // component is no longer ACTIVE. This is necessary because
      // reassess updated totalContractValue assuming the component
      // was still ACTIVE with the actual as its constrained amount.
      // After RESOLVED it drops out — but the recognized-to-date has
      // already absorbed the actual, so the "remaining to recognize"
      // should be the same.
      const contract = await tx.revenueContract.findFirst({
        where: { id: target.contractId, entity: { tenantId: tenant.id } },
        select: {
          id: true,
          totalContractValue: true,
          performanceObligations: { select: { id: true } },
          variableConsiderations: {
            where: { status: { not: "REVERSED" } },
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
      if (contract && contract.performanceObligations.length > 0) {
        const base = new Decimal(contract.totalContractValue.toString())
          .minus(new Decimal(input.actualAmount));
        const activeComponents = contract.variableConsiderations
          .filter((c) => c.status === "ACTIVE")
          .map((c) => toComponent(c as Parameters<typeof toComponent>[0]));
        const adjusted = computeAdjustedTransactionPrice({
          baseAmount: base.lessThan(0) ? 0 : base,
          components: activeComponents,
        });
        // Note: we recompute against the original-base-minus-actual,
        // which is an approximation — accurate when the resolved
        // component was the only adjustment. Multiple-component
        // contracts may need a stored "originalBase" field; tracked
        // as a v0.4 enhancement in the schema comments.
        await tx.revenueContract.update({
          where: { id: contract.id },
          data: { totalContractValue: adjusted.adjustedAmount.toFixed(4) },
        });
      }
    });

    revalidatePath(`/contracts/${target.contractId}`);
    return {
      ok: true,
      message: `Resolved with actual ${input.actualAmount.toFixed(2)}; catch-up ${reassessment.catchUpAmount} pending posting`,
      catchUpAmount: reassessment.catchUpAmount,
      reassessmentId: reassessment.reassessmentId,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove (reverse — never destructive)
// ─────────────────────────────────────────────────────────────────────────────

export async function removeVariableConsiderationAction(
  input: RemoveVarConsInput
): Promise<VarConsActionResult> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const target = await prisma.variableConsideration.findFirst({
      where: {
        id: input.variableConsiderationId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: {
        id: true,
        contractId: true,
        status: true,
        currentConstrainedAmount: true,
        currentUnconstrainedAmount: true,
      },
    });
    if (!target) return { ok: false, message: "Variable consideration not found in this tenant" };
    if (target.status !== "ACTIVE") {
      return { ok: false, message: `Cannot reverse a ${target.status} component` };
    }
    if (!input.rationale || input.rationale.trim().length === 0) {
      return { ok: false, message: "Rationale is required to reverse a component (audit)" };
    }

    // Reverse via a reassessment to zero — runs the catch-up math.
    const reassessment = await reassessVariableConsiderationAction({
      variableConsiderationId: target.id,
      newUnconstrainedAmount: 0,
      newConstrainedAmount: 0,
      rationale: `REVERSED: ${input.rationale}`,
    });
    if (!reassessment.ok) return reassessment;

    // The reassess action above committed in its own transaction. If
    // the status flip below fails, the component stays ACTIVE with
    // currentConstrained = 0 — functionally inert (zero contribution
    // to the adjusted transaction price) but mislabeled in the audit
    // trail. Surface the half-success rather than swallow it.
    try {
      await prisma.variableConsideration.update({
        where: { id: target.id },
        data: { status: "REVERSED" },
      });
    } catch (e) {
      return {
        ok: false,
        message: `Reassessment recorded (catch-up ${reassessment.catchUpAmount}) but status flip to REVERSED failed: ${e instanceof Error ? e.message : "unknown error"}. Re-run the reverse action to retry.`,
        catchUpAmount: reassessment.catchUpAmount,
        reassessmentId: reassessment.reassessmentId,
      };
    }

    revalidatePath(`/contracts/${target.contractId}`);
    return {
      ok: true,
      message: `Component reversed; catch-up ${reassessment.catchUpAmount} pending posting`,
      catchUpAmount: reassessment.catchUpAmount,
      reassessmentId: reassessment.reassessmentId,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
