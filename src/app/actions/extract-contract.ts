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
    const doc = await prisma.contractDocument.findUnique({
      where: { contractId },
      select: { id: true, rawText: true, contractId: true },
    });
    if (!doc) {
      return {
        ok: false,
        message:
          "No ContractDocument is attached to this contract — nothing for the AI to read.",
      };
    }

    const result = await extractContract(doc.rawText);

    const suggestion = await prisma.aiExtractionSuggestion.create({
      data: {
        contractId,
        obligationsJson: result.extracted.performanceObligations as unknown as object,
        modelName: result.modelName,
        promptHash: result.promptHash,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs,
      },
      select: { id: true },
    });

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
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error during extraction",
    };
  }
}
