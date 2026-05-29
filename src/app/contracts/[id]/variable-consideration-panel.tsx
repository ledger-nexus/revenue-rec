"use client";

// Variable consideration panel — ASC 606 Step 3 client UI.
//
// Two surfaces:
//
//   1. Existing components table: every VariableConsideration row for
//      this contract, with current constrained/unconstrained amounts,
//      method, direction, status. Each ACTIVE row gets reassess /
//      resolve / reverse buttons that open inline forms.
//
//   2. Add form: collapsed by default; one click expands it and lets
//      the operator record a new component.
//
// The reassess/resolve/reverse flow uses the same compact inline form
// pattern as recon's adjustment editor — no modal, no separate page.
// Submit calls the server action; on success the page revalidates
// and the new row appears in the table.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import {
  addVariableConsiderationAction,
  reassessVariableConsiderationAction,
  resolveVariableConsiderationAction,
  removeVariableConsiderationAction,
} from "@/app/actions/variable-consideration";
import { postVariableCatchUpAction } from "@/app/actions/post-variable-catch-up";

interface VarConsRow {
  id: string;
  description: string;
  method: "EXPECTED_VALUE" | "MOST_LIKELY_AMOUNT";
  direction: "INCREASE" | "DECREASE";
  status: "ACTIVE" | "RESOLVED" | "REVERSED";
  currentConstrainedAmount: string;
  currentUnconstrainedAmount: string;
  constraintRationale: string;
  resolvedAmount: string | null;
  obligationLabel: string | null; // e.g., "PO #2 — Implementation services"
  reassessmentCount: number;
  /** Most recent reassessment summary — drives the post / posted-state UI. */
  latestReassessment: {
    id: string;
    catchUpAmount: string | null;
    posted: boolean;
    postedAt: string | null;
  } | null;
}

interface Props {
  contractId: string;
  obligations: Array<{ id: string; sequenceNo: number; description: string }>;
  components: VarConsRow[];
}

export function VariableConsiderationPanel({
  contractId,
  obligations,
  components,
}: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [openReassess, setOpenReassess] = useState<string | null>(null);
  const [openResolve, setOpenResolve] = useState<string | null>(null);

  const activeAdjustment = components
    .filter((c) => c.status === "ACTIVE")
    .reduce((acc, c) => {
      const amt = parseFloat(c.currentConstrainedAmount);
      const sign = c.direction === "INCREASE" ? 1 : -1;
      return acc + amt * sign;
    }, 0);

  return (
    <div className="flex flex-col gap-3">
      {components.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-200 p-4 text-xs text-ink-500">
          No variable consideration recorded. Contract is currently treated as
          fully fixed consideration. Add a component if the contract carries
          bonuses, refund rights, volume rebates, or other ASC 606 Step 3
          variable amounts.
        </div>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Component</TH>
                <TH>Method</TH>
                <TH>Direction</TH>
                <TH className="text-right">Constrained</TH>
                <TH className="text-right">Unconstrained</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {components.map((c) => (
                <RowDetail
                  key={c.id}
                  row={c}
                  isReassessOpen={openReassess === c.id}
                  isResolveOpen={openResolve === c.id}
                  onOpenReassess={() => {
                    setOpenReassess(c.id);
                    setOpenResolve(null);
                  }}
                  onOpenResolve={() => {
                    setOpenResolve(c.id);
                    setOpenReassess(null);
                  }}
                  onClose={() => {
                    setOpenReassess(null);
                    setOpenResolve(null);
                  }}
                />
              ))}
            </TBody>
          </Table>
          <div className="text-xs text-ink-500">
            Net active variable adjustment:{" "}
            <span className="font-mono text-ink-800">
              {activeAdjustment >= 0 ? "+" : ""}
              {activeAdjustment.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        </>
      )}

      {showAdd ? (
        <AddForm
          contractId={contractId}
          obligations={obligations}
          onCancel={() => setShowAdd(false)}
        />
      ) : (
        <div>
          <Button variant="outline" onClick={() => setShowAdd(true)}>
            + Add variable consideration
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface RowDetailProps {
  row: VarConsRow;
  isReassessOpen: boolean;
  isResolveOpen: boolean;
  onOpenReassess: () => void;
  onOpenResolve: () => void;
  onClose: () => void;
}

function RowDetail({
  row,
  isReassessOpen,
  isResolveOpen,
  onOpenReassess,
  onOpenResolve,
  onClose,
}: RowDetailProps) {
  return (
    <>
      <TR>
        <TD>
          <div className="font-medium text-ink-900">{row.description}</div>
          {row.obligationLabel ? (
            <div className="text-[11px] text-ink-500">{row.obligationLabel}</div>
          ) : (
            <div className="text-[11px] text-ink-400">whole contract</div>
          )}
          {row.reassessmentCount > 1 ? (
            <div className="text-[11px] text-ink-500">
              {row.reassessmentCount} reassessments
            </div>
          ) : null}
        </TD>
        <TD>
          <Badge tone="info">
            {row.method === "EXPECTED_VALUE" ? "Expected value" : "Most likely"}
          </Badge>
        </TD>
        <TD>
          <Badge tone={row.direction === "INCREASE" ? "positive" : "warning"}>
            {row.direction === "INCREASE" ? "↑ Increase" : "↓ Decrease"}
          </Badge>
        </TD>
        <TD className="amount-cell text-right">{formatMoney(row.currentConstrainedAmount)}</TD>
        <TD className="amount-cell text-right text-ink-500">
          {formatMoney(row.currentUnconstrainedAmount)}
        </TD>
        <TD>
          <Badge
            tone={
              row.status === "ACTIVE"
                ? "info"
                : row.status === "RESOLVED"
                  ? "positive"
                  : "neutral"
            }
          >
            {row.status}
          </Badge>
          {row.status === "RESOLVED" && row.resolvedAmount ? (
            <div className="mt-0.5 text-[11px] text-ink-500">
              actual: {formatMoney(row.resolvedAmount)}
            </div>
          ) : null}
        </TD>
        <TD className="text-right">
          {row.status === "ACTIVE" ? (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={onOpenReassess}>
                Reassess
              </Button>
              <Button size="sm" variant="ghost" onClick={onOpenResolve}>
                Resolve
              </Button>
              <ReverseButton id={row.id} />
            </div>
          ) : (
            <span className="text-[11px] text-ink-400">—</span>
          )}
        </TD>
      </TR>
      {isReassessOpen ? (
        <TR>
          <TD colSpan={7} className="bg-ink-50">
            <ReassessForm row={row} onClose={onClose} />
          </TD>
        </TR>
      ) : null}
      {isResolveOpen ? (
        <TR>
          <TD colSpan={7} className="bg-ink-50">
            <ResolveForm row={row} onClose={onClose} />
          </TD>
        </TR>
      ) : null}
      {row.latestReassessment && row.latestReassessment.catchUpAmount ? (
        <TR>
          <TD colSpan={7} className="bg-ink-50 text-[11px]">
            <LatestReassessmentRow reassessment={row.latestReassessment} />
          </TD>
        </TR>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add form
// ─────────────────────────────────────────────────────────────────────────────

interface AddFormProps {
  contractId: string;
  obligations: Array<{ id: string; sequenceNo: number; description: string }>;
  onCancel: () => void;
}

function AddForm({ contractId, obligations, onCancel }: AddFormProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    setError(null);
    const description = String(form.get("description") ?? "").trim();
    const method = String(form.get("method") ?? "MOST_LIKELY_AMOUNT") as
      | "EXPECTED_VALUE"
      | "MOST_LIKELY_AMOUNT";
    const direction = String(form.get("direction") ?? "INCREASE") as
      | "INCREASE"
      | "DECREASE";
    const unconstrainedAmount = parseFloat(String(form.get("unconstrained") ?? "0"));
    const constrainedAmount = parseFloat(String(form.get("constrained") ?? "0"));
    const constraintRationale = String(form.get("rationale") ?? "").trim();
    const obligationRaw = String(form.get("obligationId") ?? "");
    const obligationId = obligationRaw === "" ? null : obligationRaw;

    startTransition(async () => {
      const result = await addVariableConsiderationAction({
        contractId,
        description,
        method,
        direction,
        unconstrainedAmount,
        constrainedAmount,
        constraintRationale,
        obligationId,
      });
      if (!result.ok) {
        setError(result.message);
      } else {
        onCancel();
      }
    });
  }

  return (
    <form
      action={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-ink-200 bg-ink-50 p-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Description (e.g., 'Q4 volume rebate')">
          <input
            name="description"
            required
            type="text"
            className="input"
            placeholder="What is this variable amount?"
          />
        </Field>
        <Field label="Performance obligation (optional — leave blank for contract-wide)">
          <select name="obligationId" className="input">
            <option value="">— whole contract —</option>
            {obligations.map((po) => (
              <option key={po.id} value={po.id}>
                PO #{po.sequenceNo} — {po.description}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estimation method (ASC 606-10-32-8)">
          <select name="method" className="input" defaultValue="MOST_LIKELY_AMOUNT">
            <option value="MOST_LIKELY_AMOUNT">Most likely amount</option>
            <option value="EXPECTED_VALUE">Expected value (prob-weighted)</option>
          </select>
        </Field>
        <Field label="Direction">
          <select name="direction" className="input" defaultValue="INCREASE">
            <option value="INCREASE">Increase (bonus, overage)</option>
            <option value="DECREASE">Decrease (refund, rebate)</option>
          </select>
        </Field>
        <Field label="Unconstrained estimate ($)">
          <input
            name="unconstrained"
            required
            type="number"
            step="0.01"
            min="0"
            className="input amount-cell"
          />
        </Field>
        <Field label="Constrained amount ($) — what's included in price">
          <input
            name="constrained"
            required
            type="number"
            step="0.01"
            min="0"
            className="input amount-cell"
          />
        </Field>
      </div>
      <Field label="Constraint rationale (auditor sees this)">
        <textarea
          name="rationale"
          required
          className="input min-h-20"
          placeholder="Why is constrained < unconstrained? What could cause a reversal?"
        />
      </Field>

      {error ? (
        <div className="rounded-md bg-rose-50 p-2 text-xs text-rose-800">{error}</div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add component"}
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reassess form
// ─────────────────────────────────────────────────────────────────────────────

function ReassessForm({ row, onClose }: { row: VarConsRow; onClose: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [catchUp, setCatchUp] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    setError(null);
    setCatchUp(null);
    startTransition(async () => {
      const result = await reassessVariableConsiderationAction({
        variableConsiderationId: row.id,
        newUnconstrainedAmount: parseFloat(String(form.get("unconstrained") ?? "0")),
        newConstrainedAmount: parseFloat(String(form.get("constrained") ?? "0")),
        rationale: String(form.get("rationale") ?? "").trim(),
      });
      if (!result.ok) {
        setError(result.message);
      } else {
        setCatchUp(result.catchUpAmount ?? null);
        // Leave the form open so the operator sees the catch-up; they
        // can close it manually.
      }
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-3 p-2">
      <div className="text-xs font-medium text-ink-700">Reassess "{row.description}"</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`New unconstrained ($) — currently ${row.currentUnconstrainedAmount}`}>
          <input
            name="unconstrained"
            required
            type="number"
            step="0.01"
            min="0"
            defaultValue={row.currentUnconstrainedAmount}
            className="input amount-cell"
          />
        </Field>
        <Field label={`New constrained ($) — currently ${row.currentConstrainedAmount}`}>
          <input
            name="constrained"
            required
            type="number"
            step="0.01"
            min="0"
            defaultValue={row.currentConstrainedAmount}
            className="input amount-cell"
          />
        </Field>
      </div>
      <Field label="Why is the estimate changing?">
        <textarea
          name="rationale"
          required
          className="input min-h-16"
          placeholder="New volume data; Q3 actuals vs forecast; etc."
        />
      </Field>
      {error ? (
        <div className="rounded-md bg-rose-50 p-2 text-xs text-rose-800">{error}</div>
      ) : null}
      {catchUp ? (
        <div className="rounded-md bg-emerald-50 p-2 text-xs text-emerald-800">
          Reassessment saved. Cumulative catch-up of{" "}
          <span className="amount-cell">{catchUp}</span> recorded. Close this
          form and use the "Post catch-up JE" button on the component's row to
          post via ledger-core.
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          Close
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save reassessment"}
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve form
// ─────────────────────────────────────────────────────────────────────────────

function ResolveForm({ row, onClose }: { row: VarConsRow; onClose: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [catchUp, setCatchUp] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    setError(null);
    setCatchUp(null);
    startTransition(async () => {
      const result = await resolveVariableConsiderationAction({
        variableConsiderationId: row.id,
        actualAmount: parseFloat(String(form.get("actual") ?? "0")),
        rationale: String(form.get("rationale") ?? "").trim(),
      });
      if (!result.ok) {
        setError(result.message);
      } else {
        setCatchUp(result.catchUpAmount ?? null);
      }
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-3 p-2">
      <div className="text-xs font-medium text-ink-700">Resolve "{row.description}"</div>
      <div className="text-[11px] text-ink-500">
        The variable amount has materialized. Enter the actual realized amount;
        the component flips to RESOLVED and is excluded from future periods.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Actual amount realized ($)">
          <input
            name="actual"
            required
            type="number"
            step="0.01"
            min="0"
            className="input amount-cell"
          />
        </Field>
      </div>
      <Field label="Final rationale (audit trail)">
        <textarea
          name="rationale"
          required
          className="input min-h-16"
          placeholder="Customer paid full bonus on 2026-03-15; refund window closed; etc."
        />
      </Field>
      {error ? (
        <div className="rounded-md bg-rose-50 p-2 text-xs text-rose-800">{error}</div>
      ) : null}
      {catchUp ? (
        <div className="rounded-md bg-emerald-50 p-2 text-xs text-emerald-800">
          Resolved. Cumulative catch-up of <span className="amount-cell">{catchUp}</span>{" "}
          recorded.
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          Close
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Resolving…" : "Resolve"}
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reverse button (inline, no expanded form — single click w/ prompt)
// ─────────────────────────────────────────────────────────────────────────────

function ReverseButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();

  function onClick() {
    const rationale = window.prompt(
      "Why is this component being reversed? (audit trail)"
    );
    if (!rationale || rationale.trim().length === 0) return;
    startTransition(async () => {
      const result = await removeVariableConsiderationAction({
        variableConsiderationId: id,
        rationale,
      });
      if (!result.ok) {
        window.alert(`Failed to reverse: ${result.message}`);
      }
    });
  }

  return (
    <Button size="sm" variant="ghost" onClick={onClick} disabled={pending}>
      {pending ? "…" : "Reverse"}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LatestReassessmentRow — surfaces the catch-up amount + post button or
// posted-state badge per reassessment.
// ─────────────────────────────────────────────────────────────────────────────

function LatestReassessmentRow({
  reassessment,
}: {
  reassessment: {
    id: string;
    catchUpAmount: string | null;
    posted: boolean;
    postedAt: string | null;
  };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const amount = reassessment.catchUpAmount;
  if (!amount) return null;
  const amt = parseFloat(amount);
  const isZero = amt === 0;

  function onPost() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await postVariableCatchUpAction({
        reassessmentId: reassessment.id,
      });
      if (!result.ok) setError(result.message);
      else setSuccess(result.message);
    });
  }

  if (reassessment.posted) {
    return (
      <div className="flex items-center gap-2 text-ink-600">
        <Badge tone="positive">POSTED</Badge>
        <span>
          Latest reassessment catch-up of{" "}
          <span className="amount-cell">{formatMoney(amount)}</span> posted via
          ledger-core
          {reassessment.postedAt
            ? ` at ${new Date(reassessment.postedAt).toLocaleString()}`
            : ""}
          .
        </span>
      </div>
    );
  }

  if (isZero) {
    return (
      <div className="flex items-center gap-2 text-ink-500">
        <Badge tone="neutral">NO POSTING NEEDED</Badge>
        <span>Latest reassessment catch-up is $0.00 — nothing to post.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-ink-700">
        <Badge tone="warning">UNPOSTED</Badge>
        <span>
          Latest reassessment catch-up of{" "}
          <span className="amount-cell font-medium">{formatMoney(amount)}</span>
          {amt > 0
            ? " — recognizes additional revenue this period."
            : " — reverses revenue this period."}
        </span>
        <Button size="sm" onClick={onPost} disabled={pending} className="ml-auto">
          {pending ? "Posting…" : "Post catch-up JE"}
        </Button>
      </div>
      {error ? (
        <div className="rounded-md bg-rose-50 p-1.5 text-[11px] text-rose-800">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-md bg-emerald-50 p-1.5 text-[11px] text-emerald-800">
          {success}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function formatMoney(s: string): string {
  const n = parseFloat(s);
  if (Number.isNaN(n)) return s;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
