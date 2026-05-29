"use server";

// Server Action: run the AI extractor against a contract's stored
// document text, persist the result to AiExtractionSuggestion for audit,
// and return the proposal to the caller.
//
// The action does NOT mutate the RevenueContract or its
// PerformanceObligations. That's a separate "approve" step the human
// drives explicitly — the AI's output is always a proposal, never a
// decision.
//
// Failure modes:
//   - No ContractDocument exists for this contract → user must add raw
//     text first (v0.1 seed-only; uploading lands in v0.2-beta UI).
//   - Anthropic API call fails → error surfaces to the UI; no row written.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { extractContract, type ExtractionResponse } from "@/lib/extraction/ai-extract";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  enforceAiBudget,
  emitSpendAlertIfThresholdCrossed,
  RateLimitExceededError,
  MonthlySpendCapExceededError,
} from "@/lib/auth/ai-budget";
import { requireRepoAccess, RepoNotIncludedError } from "@/lib/auth/repo-access";

export interface ExtractContractState {
  ok: boolean;
  message: string;
  suggestionId?: string;
  proposal?: ExtractionResponse;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  latencyMs?: number;
}

export async function extractContractAction(
  contractId: string
): Promise<ExtractContractState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    // Plan gate: revenue-rec is Growth+. Throws on free / starter
    // (when enforcement is on; soft-warns in dev).
    requireRepoAccess(tenant);

    // SECURITY (pen-test pass 4): tenant-scope the document lookup
    // via document → contract → entity → tenantId. WITHOUT THIS,
    // the action ships any tenant's contract rawText (PII, pricing,
    // T&Cs) to the Anthropic API on behalf of a foreign caller —
    // direct cross-tenant data exfiltration.
    const doc = await prisma.contractDocument.findFirst({
      where: {
        contractId,
        contract: { entity: { tenantId: tenant.id } },
      },
      select: { id: true, rawText: true, contractId: true },
    });
    if (!doc) {
      return {
        ok: false,
        message:
          "No ContractDocument is attached to this contract — nothing for the AI to read.",
      };
    }

    // Rate limit + monthly spend cap. Extraction is the most expensive
    // single AI call in the portfolio (Opus 4.7 on contract text), so
    // this gate matters more here than for recon's Haiku matcher.
    await enforceAiBudget({
      tenantId: tenant.id,
      userId: user.id,
      action: "extractContract",
    });

    const result = await extractContract(doc.rawText);

    const suggestion = await prisma.aiExtractionSuggestion.create({
      data: {
        contractId,
        tenantId: tenant.id,
        obligationsJson: result.extracted.performanceObligations as unknown as object,
        // Persist the variable consideration components + their
        // EXPECTED_VALUE outcomes (when present) so the audit panel
        // can show what the AI proposed for ASC 606 Step 3, not just
        // the obligations. Null when the array is empty (saves
        // storage; the audit page treats empty + null the same).
        variableConsiderationJson:
          result.extracted.variableConsideration.length > 0
            ? (result.extracted.variableConsideration as unknown as object)
            : undefined,
        modelName: result.modelName,
        promptHash: result.promptHash,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        // Prompt-cache telemetry from the Anthropic SDK's usage
        // response. cacheReadTokens > 0 means the system prefix was
        // served from cache; cacheCreationTokens > 0 means the
        // prefix was written this call (a cache miss that primed
        // future calls).
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        latencyMs: result.latencyMs,
      },
      select: { id: true },
    });

    await emitSpendAlertIfThresholdCrossed(tenant.id);

    revalidatePath(`/contracts/${contractId}`);

    return {
      ok: true,
      message: `Extracted ${result.extracted.performanceObligations.length} performance obligation(s).`,
      suggestionId: suggestion.id,
      proposal: result.extracted,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      latencyMs: result.latencyMs,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in to extract a contract." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof RateLimitExceededError || e instanceof MonthlySpendCapExceededError)
      return { ok: false, message: e.message };
    if (e instanceof RepoNotIncludedError)
      return { ok: false, message: e.message };
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error during extraction",
    };
  }
}
