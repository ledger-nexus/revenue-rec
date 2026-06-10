"use client";

// Client component: textarea + import button + result panel.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  importNsRevenueAction,
  type ImportNsRevenueState,
} from "@/app/actions/import-ns-revenue";

export function ImportPanel() {
  const [pending, startTransition] = useTransition();
  const [bundle, setBundle] = useState("");
  const [state, setState] = useState<ImportNsRevenueState | null>(null);

  function onImport() {
    setState(null);
    startTransition(async () => {
      const next = await importNsRevenueAction({ bundleJson: bundle });
      setState(next);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <label htmlFor="bundle" className="block text-sm font-medium text-ink-800">
          Bundle JSON
        </label>
        <p className="mt-0.5 text-xs text-ink-500">
          Paste the full <code>NsRevenueArrangementExport</code> here.
        </p>
        <textarea
          id="bundle"
          value={bundle}
          onChange={(e) => setBundle(e.target.value)}
          placeholder='{ "exported_at": "...", "recognition_templates": [...], "arrangements": [...] }'
          rows={14}
          className="mt-3 w-full rounded-md border border-ink-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-ink-800 placeholder:text-ink-400 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
          disabled={pending}
        />
        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-ink-500">
            {bundle.length > 0
              ? `${bundle.length.toLocaleString()} characters`
              : "Empty"}
          </div>
          <Button onClick={onImport} disabled={pending || bundle.trim().length === 0}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </div>
      </Card>

      {state && <ResultPanel state={state} />}
    </div>
  );
}

function ResultPanel({ state }: { state: ImportNsRevenueState }) {
  if (!state.ok) {
    return (
      <Card className="border-red-300 bg-red-50 p-4">
        <div className="flex items-start gap-3">
          <Badge tone="negative">Failed</Badge>
          <div className="text-sm text-red-900">{state.message}</div>
        </div>
      </Card>
    );
  }

  const r = state.result;
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <Badge tone="positive">Done</Badge>
        <div className="text-sm font-medium text-ink-800">{state.message}</div>
      </div>

      {r && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Processed" value={r.totals.arrangementsProcessed} />
          <Stat
            label="Created"
            value={r.totals.arrangementsCreated}
            tone="positive"
          />
          <Stat
            label="Skipped (dup)"
            value={r.totals.arrangementsSkipped}
            tone="muted"
          />
          <Stat
            label="Errored"
            value={r.totals.arrangementsErrored}
            tone={r.totals.arrangementsErrored > 0 ? "negative" : "muted"}
          />
          <Stat label="POs created" value={r.totals.obligationsCreated} />
          <Stat
            label="Warnings"
            value={r.totals.warningCount}
            tone={r.totals.warningCount > 0 ? "warning" : "muted"}
          />
        </div>
      )}

      {r && r.arrangements.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-800">
            Arrangements ({r.arrangements.length})
          </summary>
          <ul className="mt-3 space-y-2 text-xs">
            {r.arrangements.map((a) => (
              <li
                key={a.nsArrangementInternalId}
                className="rounded border border-ink-200 bg-white p-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-ink-700">
                    {a.nsArrangementTranid}
                  </span>
                  {a.wasDuplicate ? (
                    <Badge tone="neutral">Skipped (duplicate)</Badge>
                  ) : (
                    <Badge tone="positive">
                      Created · {a.obligationsCreated} PO{a.obligationsCreated === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
                {a.warnings.length > 0 && (
                  <ul className="mt-2 space-y-1 text-ink-600">
                    {a.warnings.map((w, idx) => (
                      <li key={idx} className="border-l-2 border-amber-400 pl-2">
                        ⚠ {w}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {r && r.errors.length > 0 && (
        <details className="mt-4" open>
          <summary className="cursor-pointer text-sm font-medium text-red-700">
            Errors ({r.errors.length})
          </summary>
          <ul className="mt-3 space-y-2 text-xs">
            {r.errors.map((e) => (
              <li
                key={e.nsArrangementInternalId}
                className="rounded border border-red-200 bg-red-50 p-2"
              >
                <div className="font-mono text-red-700">
                  {e.nsArrangementTranid}
                </div>
                <div className="mt-1 text-red-900">{e.message}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "positive" | "negative" | "warning" | "muted";
}) {
  const toneClass = {
    default: "text-ink-800",
    positive: "text-emerald-700",
    negative: "text-red-700",
    warning: "text-amber-700",
    muted: "text-ink-500",
  }[tone];

  return (
    <div className="rounded border border-ink-200 bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
