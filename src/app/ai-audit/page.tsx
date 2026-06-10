// AI usage audit panel.
//
// Aggregates every AiExtractionSuggestion to answer:
//   - How often is the AI being called?
//   - Is prompt caching actually working?
//   - What's the rough $ cost so far?
//   - For each suggestion: did it lead to an ACTIVE contract?
//     (proxy for "the human eventually approved this")
//
// Acceptance signal is weaker here than in recon: revenue-rec doesn't
// link AiExtractionSuggestion → the eventual PerformanceObligation
// rows (that's a v0.3 enhancement). For now we use the contract's
// status as the proxy — DRAFT means "not yet approved," ACTIVE means
// the human ran approveExtractionAction at least once after the AI
// extraction landed.
//
// Costs use Opus 4.7 list pricing ($5/M input, $25/M output). Cache
// reads would reduce this in practice; we show the optimistic-
// uncached estimate and break out cache stats separately.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { getCurrentTenant } from "@/lib/auth/session";

const OPUS_INPUT_PER_M = 5.0;
const OPUS_OUTPUT_PER_M = 25.0;

interface ExtractedPoJson {
  sequenceNo: number;
  description: string;
  ssp: number;
  recognitionPattern: string;
  rationale?: string;
}

interface ExtractedVcOutcomeJson {
  scenario: string;
  amount: number;
  probabilityPercent: number;
}

interface ExtractedVcJson {
  description: string;
  method: "EXPECTED_VALUE" | "MOST_LIKELY_AMOUNT";
  direction: "INCREASE" | "DECREASE";
  unconstrainedAmount: number;
  constrainedAmount: number;
  constraintRationale: string;
  outcomes?: ExtractedVcOutcomeJson[];
}

export default async function AiAuditPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope via the tenantId
  // column on AiExtractionSuggestion. Legacy rows (created before this
  // column was added) have null tenantId and are filtered out — backfill
  // via prisma/backfill-ai-extraction-suggestion-tenant.sql.
  const tenant = await getCurrentTenant();
  const suggestions = await prisma.aiExtractionSuggestion.findMany({
    where: tenant ? { tenantId: tenant.id } : { id: "__none__" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      contractId: true,
      obligationsJson: true,
      variableConsiderationJson: true,
      modelName: true,
      promptTokens: true,
      completionTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
      latencyMs: true,
      createdAt: true,
      contract: {
        select: {
          id: true,
          code: true,
          status: true,
          customer: { select: { displayName: true } },
        },
      },
    },
  });

  const totalRuns = suggestions.length;
  const totalPromptTokens = suggestions.reduce((s, x) => s + (x.promptTokens ?? 0), 0);
  const totalCompletionTokens = suggestions.reduce(
    (s, x) => s + (x.completionTokens ?? 0),
    0
  );
  const totalCacheReadTokens = suggestions.reduce(
    (s, x) => s + (x.cacheReadTokens ?? 0),
    0
  );
  const totalCacheCreationTokens = suggestions.reduce(
    (s, x) => s + (x.cacheCreationTokens ?? 0),
    0
  );
  const totalLatencyMs = suggestions.reduce((s, x) => s + (x.latencyMs ?? 0), 0);
  const avgLatencyMs = totalRuns > 0 ? Math.round(totalLatencyMs / totalRuns) : 0;
  // Cost estimate: cache reads bill at ~10% of normal input rate per
  // Anthropic. Cache writes bill at 1.25× input rate. Non-cached
  // input bills at full rate. Output always bills at output rate.
  const uncachedInputTokens = totalPromptTokens - totalCacheReadTokens;
  const estimatedCostUsd =
    (uncachedInputTokens / 1_000_000) * OPUS_INPUT_PER_M +
    (totalCacheReadTokens / 1_000_000) * (OPUS_INPUT_PER_M * 0.1) +
    (totalCacheCreationTokens / 1_000_000) * (OPUS_INPUT_PER_M * 1.25) +
    (totalCompletionTokens / 1_000_000) * OPUS_OUTPUT_PER_M;
  // Cache-hit rate: cached input tokens as a fraction of total input.
  // A high rate (>80%) means the system prompt is being reused
  // effectively — system prompt edits invalidate the cache.
  const cacheHitRate =
    totalPromptTokens > 0
      ? (totalCacheReadTokens / totalPromptTokens) * 100
      : 0;

  const acceptedCount = suggestions.filter(
    (s) => s.contract.status === "ACTIVE"
  ).length;
  const acceptanceRate = totalRuns > 0 ? (acceptedCount / totalRuns) * 100 : 0;

  // Distinct contracts the AI has touched.
  const uniqueContracts = new Set(suggestions.map((s) => s.contractId)).size;

  // Variable consideration: how often the AI surfaced ASC 606 Step 3
  // components, and how many used EXPECTED_VALUE outcomes.
  let totalVcComponents = 0;
  let totalEvComponents = 0;
  let totalEvOutcomes = 0;
  let runsWithVc = 0;
  for (const s of suggestions) {
    const vcs = (s.variableConsiderationJson as unknown as ExtractedVcJson[] | null) ?? [];
    if (vcs.length > 0) runsWithVc += 1;
    totalVcComponents += vcs.length;
    for (const vc of vcs) {
      if (vc.method === "EXPECTED_VALUE") {
        totalEvComponents += 1;
        totalEvOutcomes += vc.outcomes?.length ?? 0;
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">AI usage audit</h1>
        <p className="text-sm text-ink-500">
          Every <code className="font-mono">AiExtractionSuggestion</code> row
          the contract extractor produced. Every run is logged, including
          ones whose proposals were discarded.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Total extractions" value={String(totalRuns)} />
        <Metric
          label="Acceptance rate"
          value={`${acceptanceRate.toFixed(0)}%`}
          hint={`${acceptedCount} contracts active after AI extraction`}
        />
        <Metric
          label="Σ tokens"
          value={(totalPromptTokens + totalCompletionTokens).toLocaleString()}
          hint={`${totalPromptTokens.toLocaleString()} in / ${totalCompletionTokens.toLocaleString()} out`}
        />
        <Metric
          label="Est. cost"
          value={`$${estimatedCostUsd.toFixed(4)}`}
          hint="Opus 4.7 list pricing; cache reads bill at 10%, writes at 1.25×"
        />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Avg latency" value={`${avgLatencyMs}ms`} />
        <Metric
          label="Unique contracts"
          value={String(uniqueContracts)}
          hint="Contracts the AI has read at least once"
        />
        <Metric
          label="Cache-hit rate"
          value={`${cacheHitRate.toFixed(0)}%`}
          hint={`${totalCacheReadTokens.toLocaleString()} cached / ${totalPromptTokens.toLocaleString()} input`}
        />
        <Metric
          label="Model"
          value={suggestions[0]?.modelName ?? "—"}
          hint="Most recent run"
        />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric
          label="Variable consideration runs"
          value={String(runsWithVc)}
          hint={`${totalVcComponents} components total`}
        />
        <Metric
          label="EXPECTED_VALUE components"
          value={String(totalEvComponents)}
          hint={`${totalEvOutcomes} outcomes documented`}
        />
        <Metric
          label="Cache creation"
          value={totalCacheCreationTokens.toLocaleString()}
          hint="Tokens written to cache (priming runs)"
        />
        <Metric
          label="Avg tokens per run"
          value={
            totalRuns > 0
              ? Math.round((totalPromptTokens + totalCompletionTokens) / totalRuns).toLocaleString()
              : "—"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent extractions</CardTitle>
          <span className="text-xs text-ink-500">
            Newest first · capped at 200 · click the contract to review the
            current POs alongside what the AI proposed
          </span>
        </CardHeader>
        <CardContent className={suggestions.length === 0 ? "" : "p-0"}>
          {suggestions.length === 0 ? (
            <EmptyState title="No AI runs yet">
              Open a contract and click <span className="font-medium">Re-run AI extraction</span> to fire the Opus 4.7 extractor against the stored ContractDocument.
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Contract</TH>
                  <TH>Customer</TH>
                  <TH>Status</TH>
                  <TH className="text-right">POs</TH>
                  <TH className="text-right">VC</TH>
                  <TH>Cache</TH>
                  <TH className="text-right">Tokens</TH>
                  <TH className="text-right">Latency</TH>
                </tr>
              </THead>
              <TBody>
                {suggestions.map((s) => {
                  const obligations =
                    (s.obligationsJson as unknown as ExtractedPoJson[]) ?? [];
                  const vcs =
                    (s.variableConsiderationJson as unknown as ExtractedVcJson[] | null) ?? [];
                  const evCount = vcs.filter((v) => v.method === "EXPECTED_VALUE").length;
                  // Per-run cache shape:
                  //   HIT  — cacheReadTokens > 0 (system prefix served from cache)
                  //   MISS — cacheCreationTokens > 0 (prefix written this call)
                  //   —    — both null (legacy row OR no caching configured)
                  const cacheRead = s.cacheReadTokens ?? 0;
                  const cacheWrite = s.cacheCreationTokens ?? 0;
                  const cacheBadge =
                    cacheRead > 0
                      ? { tone: "positive" as const, label: "HIT" }
                      : cacheWrite > 0
                        ? { tone: "warning" as const, label: "MISS" }
                        : null;
                  return (
                    <TR key={s.id}>
                      <TD className="text-xs text-ink-500">
                        {s.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                      </TD>
                      <TD>
                        <Link
                          href={`/contracts/${s.contract.id}`}
                          className="font-mono text-ink-900 hover:underline"
                        >
                          {s.contract.code}
                        </Link>
                      </TD>
                      <TD className="text-ink-700">
                        {s.contract.customer.displayName}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            s.contract.status === "ACTIVE"
                              ? "positive"
                              : s.contract.status === "DRAFT"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {s.contract.status}
                        </Badge>
                      </TD>
                      <TD className="text-right text-ink-700">{obligations.length}</TD>
                      <TD className="text-right text-ink-700">
                        {vcs.length > 0 ? (
                          <span>
                            {vcs.length}
                            {evCount > 0 ? (
                              <span
                                className="ml-1 text-[10px] text-ink-500"
                                title={`${evCount} EXPECTED_VALUE`}
                              >
                                ({evCount} EV)
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </TD>
                      <TD>
                        {cacheBadge ? (
                          <Badge tone={cacheBadge.tone}>{cacheBadge.label}</Badge>
                        ) : (
                          <span className="text-[10px] text-ink-400">—</span>
                        )}
                      </TD>
                      <TD className="text-right text-xs text-ink-600">
                        {((s.promptTokens ?? 0) + (s.completionTokens ?? 0)).toLocaleString()}
                      </TD>
                      <TD className="text-right text-xs text-ink-600">
                        {s.latencyMs ? `${s.latencyMs}ms` : "—"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div className="mt-1 text-lg font-semibold text-ink-900">{value}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
