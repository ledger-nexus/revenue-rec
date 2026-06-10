"use client";

// Client-side interactive controls on the contract detail page.
//
// Three flows:
//
//   1. Re-extract — run the AI extractor against the stored
//      ContractDocument. Shows the proposed POs side-by-side with the
//      current contract structure. Human can review and approve.
//
//   2. Approve extraction — wipe the contract's POs and replace with
//      the AI's proposal (after any edits the human made — v0.2-beta
//      will add inline editing; v0.2 uses the proposal verbatim).
//
//   3. Post recognition for a schedule row — calls the bridge, posts
//      the JE through ledger-core, flips the schedule row to POSTED.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { extractContractAction } from "@/app/actions/extract-contract";
import { approveExtractionAction } from "@/app/actions/approve-extraction";
import { postRecognitionAction } from "@/app/actions/post-recognition";
import type { ExtractionResponse } from "@/lib/extraction/ai-extract";

interface Props {
  contractId: string;
  hasDocument: boolean;
}

export function ExtractionPanel({ contractId, hasDocument }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ExtractionResponse | null>(null);
  const [cacheStats, setCacheStats] = useState<{
    read: number | null;
    creation: number | null;
    latency: number;
  } | null>(null);

  function clearStatus() {
    setError(null);
    setSuccess(null);
  }

  function onExtract() {
    clearStatus();
    setProposal(null);
    setCacheStats(null);
    startTransition(async () => {
      const res = await extractContractAction(contractId);
      if (!res.ok) {
        setError(res.message);
      } else {
        setProposal(res.proposal ?? null);
        if (res.latencyMs !== undefined) {
          setCacheStats({
            read: res.cacheReadTokens ?? null,
            creation: res.cacheCreationTokens ?? null,
            latency: res.latencyMs,
          });
        }
        setSuccess(res.message);
      }
    });
  }

  function onApprove() {
    if (!proposal) return;
    clearStatus();
    startTransition(async () => {
      const res = await approveExtractionAction({
        contractId,
        performanceObligations: proposal.performanceObligations.map((po) => ({
          sequenceNo: po.sequenceNo,
          description: po.description,
          ssp: po.ssp,
          recognitionPattern: po.recognitionPattern as
            | "POINT_IN_TIME"
            | "OVER_TIME_STRAIGHT"
            | "OVER_TIME_USAGE"
            | "OVER_TIME_MILESTONE",
          startDate: po.startDate,
          endDate: po.endDate,
          revenueAccountCode: po.revenueAccountCode,
          deferredAccountCode: po.deferredAccountCode,
        })),
        // Pass the AI-proposed variable consideration through. The
        // server reverses any existing ACTIVE VC on the contract,
        // creates new rows for these, and re-runs the allocator
        // against the new transaction price. Empty array means "AI
        // saw no variable consideration" — also a valid signal.
        variableConsideration: (proposal.variableConsideration ?? []).map((vc) => ({
          description: vc.description,
          method: vc.method,
          direction: vc.direction,
          unconstrainedAmount: vc.unconstrainedAmount,
          constrainedAmount: vc.constrainedAmount,
          constraintRationale: vc.constraintRationale,
          outcomes: vc.outcomes && vc.outcomes.length > 0
            ? vc.outcomes.map((o) => ({
                scenario: o.scenario,
                amount: o.amount,
                probabilityPercent: o.probabilityPercent,
              }))
            : undefined,
        })),
        totalContractValue: proposal.totalContractValue,
        contractStartDate: proposal.contractStartDate,
        contractEndDate: proposal.contractEndDate,
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setSuccess(res.message);
        setProposal(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onExtract}
          disabled={pending || !hasDocument}
        >
          {pending && !proposal ? "Thinking…" : "Re-run AI extraction"}
        </Button>
        {!hasDocument ? (
          <span className="text-xs text-ink-400">
            No ContractDocument attached — nothing for AI to read.
          </span>
        ) : null}
      </div>

      {cacheStats ? (
        <div className="text-[11px] text-ink-500">
          Latency {cacheStats.latency}ms ·{" "}
          {cacheStats.read !== null && cacheStats.read > 0
            ? `cache HIT (${cacheStats.read} read tokens)`
            : cacheStats.creation !== null && cacheStats.creation > 0
              ? `cache MISS — wrote ${cacheStats.creation} tokens`
              : "no cache data"}
        </div>
      ) : null}

      {proposal ? (
        <div className="flex flex-col gap-2 rounded-md border border-ai/30 bg-violet-50 p-3">
          <div className="flex items-center gap-2">
            <Badge tone="ai">AI proposal</Badge>
            <span className="text-xs text-ink-600">
              {proposal.contractCode} · {proposal.customerName} · $
              {proposal.totalContractValue.toLocaleString()}
            </span>
          </div>
          {proposal.notes ? (
            <div className="text-xs text-ink-700">
              <span className="font-medium">Reviewer notes: </span>
              {proposal.notes}
            </div>
          ) : null}
          <table className="w-full text-xs">
            <thead className="text-ink-500">
              <tr>
                <th className="px-1 py-1 text-left">#</th>
                <th className="px-1 py-1 text-left">Description</th>
                <th className="px-1 py-1 text-left">Pattern</th>
                <th className="px-1 py-1 text-left">Dates</th>
                <th className="px-1 py-1 text-right">SSP</th>
                <th className="px-1 py-1 text-left">Acct</th>
              </tr>
            </thead>
            <tbody>
              {proposal.performanceObligations.map((po) => (
                <tr key={po.sequenceNo} className="border-t border-ink-100">
                  <td className="px-1 py-1 text-ink-500">{po.sequenceNo}</td>
                  <td className="px-1 py-1">{po.description}</td>
                  <td className="px-1 py-1 font-mono text-[10px]">{po.recognitionPattern}</td>
                  <td className="px-1 py-1 text-ink-600">
                    {po.startDate}
                    {po.endDate ? `→${po.endDate}` : ""}
                  </td>
                  <td className="amount-cell px-1 py-1 text-right">
                    {po.ssp.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="px-1 py-1 font-mono text-[10px]">
                    {po.revenueAccountCode}/{po.deferredAccountCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposal.variableConsideration && proposal.variableConsideration.length > 0 ? (
            <div className="rounded-md border border-ai/30 bg-violet-50 p-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-ink-600">
                Variable consideration (ASC 606 Step 3) — {proposal.variableConsideration.length}{" "}
                component{proposal.variableConsideration.length === 1 ? "" : "s"}
              </div>
              <table className="w-full text-xs">
                <thead className="text-ink-500">
                  <tr>
                    <th className="px-1 py-1 text-left">Description</th>
                    <th className="px-1 py-1 text-left">Direction</th>
                    <th className="px-1 py-1 text-left">Method</th>
                    <th className="px-1 py-1 text-right">Unconstrained</th>
                    <th className="px-1 py-1 text-right">Constrained</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.variableConsideration.map((vc, i) => (
                    <tr key={i} className="border-t border-ink-100">
                      <td className="px-1 py-1">{vc.description}</td>
                      <td className="px-1 py-1">
                        <Badge tone={vc.direction === "INCREASE" ? "positive" : "warning"}>
                          {vc.direction === "INCREASE" ? "↑ Increase" : "↓ Decrease"}
                        </Badge>
                      </td>
                      <td className="px-1 py-1 font-mono text-[10px]">
                        {vc.method === "EXPECTED_VALUE" ? "EXP_VAL" : "MOST_LIKELY"}
                      </td>
                      <td className="amount-cell px-1 py-1 text-right">
                        {vc.unconstrainedAmount.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="amount-cell px-1 py-1 text-right">
                        {vc.constrainedAmount.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <details className="mt-1 text-[11px] text-ink-600">
                <summary className="cursor-pointer">Constraint rationales</summary>
                <ul className="mt-1 list-disc pl-5">
                  {proposal.variableConsideration.map((vc, i) => (
                    <li key={i}>
                      <span className="font-medium">{vc.description}:</span>{" "}
                      {vc.constraintRationale}
                    </li>
                  ))}
                </ul>
              </details>
              {/* EXPECTED_VALUE outcomes — show the math behind
                  unconstrainedAmount when the AI provided it. */}
              {proposal.variableConsideration.some(
                (vc) => vc.outcomes && vc.outcomes.length > 0
              ) ? (
                <details className="mt-1 text-[11px] text-ink-600">
                  <summary className="cursor-pointer">
                    Expected-value scenarios
                  </summary>
                  <div className="mt-1 flex flex-col gap-1.5">
                    {proposal.variableConsideration
                      .filter((vc) => vc.outcomes && vc.outcomes.length > 0)
                      .map((vc, i) => {
                        const weighted = vc.outcomes!.reduce(
                          (acc, o) => acc + o.amount * (o.probabilityPercent / 100),
                          0
                        );
                        return (
                          <div key={i} className="rounded border border-ink-200 bg-white p-1.5">
                            <div className="font-medium text-ink-700">
                              {vc.description}
                            </div>
                            <table className="mt-0.5 w-full text-[10px]">
                              <thead className="text-ink-500">
                                <tr>
                                  <th className="px-1 text-left">Scenario</th>
                                  <th className="px-1 text-right">Prob</th>
                                  <th className="px-1 text-right">Amount</th>
                                  <th className="px-1 text-right">Contribution</th>
                                </tr>
                              </thead>
                              <tbody>
                                {vc.outcomes!.map((o, j) => (
                                  <tr key={j} className="border-t border-ink-100">
                                    <td className="px-1 py-0.5">{o.scenario}</td>
                                    <td className="px-1 py-0.5 text-right amount-cell">
                                      {o.probabilityPercent.toFixed(1)}%
                                    </td>
                                    <td className="px-1 py-0.5 text-right amount-cell">
                                      {o.amount.toLocaleString("en-US", {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                      })}
                                    </td>
                                    <td className="px-1 py-0.5 text-right amount-cell">
                                      {(
                                        o.amount * (o.probabilityPercent / 100)
                                      ).toLocaleString("en-US", {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                      })}
                                    </td>
                                  </tr>
                                ))}
                                <tr className="border-t border-ink-200 bg-ink-50">
                                  <td className="px-1 py-0.5 font-medium" colSpan={3}>
                                    Σ contributions = expected value
                                  </td>
                                  <td className="px-1 py-0.5 text-right amount-cell font-medium">
                                    {weighted.toLocaleString("en-US", {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            {Math.abs(weighted - vc.unconstrainedAmount) > 0.5 ? (
                              <div className="mt-0.5 text-[10px] text-amber-700">
                                ⚠ AI's unconstrainedAmount (
                                {vc.unconstrainedAmount.toFixed(2)}) doesn't
                                match Σ contributions ({weighted.toFixed(2)}).
                                Reviewer should reconcile before approving.
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
          <details className="text-xs text-ink-600">
            <summary className="cursor-pointer">Rationales per PO</summary>
            <ul className="mt-1 list-disc pl-5">
              {proposal.performanceObligations.map((po) => (
                <li key={po.sequenceNo}>
                  <span className="font-medium">PO{po.sequenceNo}:</span> {po.rationale}
                </li>
              ))}
            </ul>
          </details>
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove} disabled={pending}>
              Approve & replace contract POs
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setProposal(null)}
              disabled={pending}
            >
              Discard proposal
            </Button>
          </div>
          <div className="text-[11px] text-ink-500">
            Approval wipes the current POs + schedule and regenerates them from
            the allocator using the SSPs above. Existing ACTIVE variable
            consideration is REVERSED (audit history preserved) and the AI's
            components are created as fresh ACTIVE rows. Already-posted
            RecognitionEvents survive.
          </div>
        </div>
      ) : null}

      {error ? <div className="text-xs text-negative">{error}</div> : null}
      {success && !proposal ? (
        <div className="text-xs text-positive">{success}</div>
      ) : null}
    </div>
  );
}

interface PostRecognitionButtonProps {
  scheduleId: string;
  disabled?: boolean;
}

export function PostRecognitionButton({
  scheduleId,
  disabled,
}: PostRecognitionButtonProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function onPost() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const res = await postRecognitionAction({ scheduleId });
      if (!res.ok) setError(res.message);
      else setSuccess(res.entryNumber ?? res.message);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={onPost}
        disabled={pending || disabled}
      >
        {pending ? "Posting…" : "Post"}
      </Button>
      {error ? <span className="text-[10px] text-negative">{error}</span> : null}
      {success ? <span className="text-[10px] text-positive">{success}</span> : null}
    </div>
  );
}
