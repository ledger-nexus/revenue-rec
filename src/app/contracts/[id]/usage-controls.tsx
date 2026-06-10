"use client";

// Inline controls for OVER_TIME_USAGE POs on the contract detail page.
//
// Two surfaces:
//   - "Set pricing" form when pricePerUnit is null — the user defines
//     $/unit + unit name (one-time setup per PO).
//   - "Record usage" form when pricing is configured — user enters
//     month + quantity for a given period, server creates the
//     RecognitionSchedule row.
//
// Compact by design — fits inline below a PO row without a separate page.

import { useState, useTransition } from "react";
import { setUsagePricingAction } from "@/app/actions/set-usage-pricing";
import { recordUsageAction } from "@/app/actions/record-usage";

interface PoProps {
  obligationId: string;
  pricePerUnit: string | null;
  unitName: string | null;
}

export function UsageControls({
  obligationId,
  pricePerUnit,
  unitName,
}: PoProps) {
  const hasPricing = pricePerUnit != null && pricePerUnit !== "" && unitName != null;

  return (
    <div className="mt-2 rounded-md border border-accent-200 bg-accent-50 p-3">
      <div className="text-xs font-medium text-accent-900">
        Usage-based recognition
      </div>
      {!hasPricing ? (
        <PricingForm obligationId={obligationId} />
      ) : (
        <>
          <div className="mt-1 text-xs text-accent-700">
            Pricing: ${pricePerUnit} per {unitName}
          </div>
          <RecordUsageRow obligationId={obligationId} unitName={unitName!} />
        </>
      )}
    </div>
  );
}

function PricingForm({ obligationId }: { obligationId: string }) {
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handle(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await setUsagePricingAction({
        obligationId,
        pricePerUnit: price,
        unitName: unit,
      });
      if (!r.ok) setError(r.message ?? "Failed");
    });
  }

  return (
    <form onSubmit={handle} className="mt-2 flex flex-wrap items-end gap-2">
      <div>
        <label className="text-[11px] font-medium text-accent-900">
          Price per unit
        </label>
        <input
          type="number"
          step="0.000001"
          min="0"
          required
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.001"
          className="mt-0.5 w-28 rounded-md border border-accent-300 bg-white px-2 py-1 text-xs focus:border-accent-500 focus:outline-none"
          disabled={pending}
        />
      </div>
      <div className="flex-1 min-w-[140px]">
        <label className="text-[11px] font-medium text-accent-900">
          Unit name
        </label>
        <input
          type="text"
          required
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="API call"
          className="mt-0.5 w-full rounded-md border border-accent-300 bg-white px-2 py-1 text-xs focus:border-accent-500 focus:outline-none"
          disabled={pending}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-7 inline-flex items-center rounded-md bg-accent-600 px-3 text-xs font-medium text-white hover:bg-accent-700 disabled:opacity-50"
      >
        {pending ? "Saving..." : "Set pricing"}
      </button>
      {error && (
        <div className="basis-full text-[11px] text-negative">{error}</div>
      )}
    </form>
  );
}

function RecordUsageRow({
  obligationId,
  unitName,
}: {
  obligationId: string;
  unitName: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [periodDate, setPeriodDate] = useState(today);
  const [qty, setQty] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    ok: boolean;
    message?: string;
  } | null>(null);

  function handle(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const r = await recordUsageAction({
        obligationId,
        periodAnyDay: periodDate,
        quantity: qty,
      });
      setResult(r);
      if (r.ok) setQty("");
    });
  }

  return (
    <form onSubmit={handle} className="mt-2 flex flex-wrap items-end gap-2">
      <div>
        <label className="text-[11px] font-medium text-accent-900">
          Period (any day in month)
        </label>
        <input
          type="date"
          required
          value={periodDate}
          max={today}
          onChange={(e) => setPeriodDate(e.target.value)}
          className="mt-0.5 rounded-md border border-accent-300 bg-white px-2 py-1 text-xs focus:border-accent-500 focus:outline-none"
          disabled={pending}
        />
      </div>
      <div>
        <label className="text-[11px] font-medium text-accent-900">
          {unitName} consumed
        </label>
        <input
          type="number"
          step="any"
          min="0"
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="1500"
          className="mt-0.5 w-24 rounded-md border border-accent-300 bg-white px-2 py-1 text-xs focus:border-accent-500 focus:outline-none"
          disabled={pending}
        />
      </div>
      <button
        type="submit"
        disabled={pending || !qty}
        className="h-7 inline-flex items-center rounded-md bg-accent-600 px-3 text-xs font-medium text-white hover:bg-accent-700 disabled:opacity-50"
      >
        {pending ? "Recording..." : "Record usage"}
      </button>
      {result && (
        <div
          className={`basis-full text-[11px] ${
            result.ok ? "text-emerald-700" : "text-negative"
          }`}
        >
          {result.message}
        </div>
      )}
    </form>
  );
}
