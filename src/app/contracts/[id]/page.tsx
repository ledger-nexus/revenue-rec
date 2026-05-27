// Contract detail page. The single most useful surface in v0.1:
// shows the ASC 606 5-step output for one contract.
//
//   - Header: customer, term, total value, economics badge (AT_SSP /
//     DISCOUNTED / PREMIUM)
//   - Performance obligations table: SSP, allocated amount, pattern,
//     dates, accounts
//   - Recognition schedule table: every (PO × period) row with status
//
// All read-only in v0.1. The "Post next period" + "Re-run AI extractor"
// actions land in v0.2.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney, formatMonth, formatPercent } from "@/lib/utils/format";
import { classifyContractEconomics } from "@/lib/accounting/allocator";
import { ExtractionPanel, PostRecognitionButton } from "./contract-actions";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function ContractDetailPage({
  params,
}: {
  params: { id: string };
}) {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the read. Without
  // this, a signed-in user could navigate to /contracts/[any-uuid] and
  // read the full rawText of any tenant's contract — PII, pricing,
  // contractual terms. The most sensitive single read leak in this repo.
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();
  const contract = await prisma.revenueContract.findFirst({
    where: { id: params.id, entity: { tenantId: tenant.id } },
    include: {
      customer: { select: { displayName: true, code: true } },
      performanceObligations: { orderBy: { sequenceNo: "asc" } },
      bookAttributes: {
        include: { book: { select: { code: true, name: true } } },
      },
      recognitionSchedules: {
        orderBy: [{ obligationId: "asc" }, { periodStart: "asc" }],
      },
      document: { select: { filename: true, format: true, rawText: true } },
    },
  });
  if (!contract) notFound();

  const totalDecimal = new Decimal(contract.totalContractValue.toString());
  const economics = classifyContractEconomics(
    totalDecimal,
    contract.performanceObligations.map((po) => ({ ssp: po.ssp.toString() }))
  );
  const totalAllocated = contract.performanceObligations.reduce(
    (acc, po) => acc.plus(new Decimal(po.ssp.toString())),
    new Decimal(0)
  );

  // Map obligationId → PO sequenceNo for schedule grouping.
  const poBySeq = new Map(
    contract.performanceObligations.map((po) => [po.id, po])
  );

  const postedSum = contract.recognitionSchedules
    .filter((s) => s.status === "POSTED")
    .reduce((acc, s) => acc.plus(new Decimal(s.plannedAmount.toString())), new Decimal(0));
  const plannedSum = contract.recognitionSchedules
    .filter((s) => s.status === "PLANNED")
    .reduce((acc, s) => acc.plus(new Decimal(s.plannedAmount.toString())), new Decimal(0));
  const recognizedPct = totalAllocated.isZero()
    ? new Decimal(0)
    : postedSum.dividedBy(totalAllocated).times(100);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/contracts"
          className="text-xs font-medium text-accent-600 hover:underline"
        >
          ← All contracts
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-ink-900 font-mono">
          {contract.code}
        </h2>
        <p className="text-sm text-ink-500">{contract.description}</p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
          <Field label="Customer" value={contract.customer.displayName} />
          <Field
            label="Term"
            value={`${formatDate(contract.contractStartDate)} → ${
              contract.contractEndDate ? formatDate(contract.contractEndDate) : "open"
            }`}
          />
          <Field
            label="Total contract value"
            value={formatMoney(contract.totalContractValue.toString())}
            mono
          />
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Economics
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge
                tone={
                  economics === "AT_SSP"
                    ? "neutral"
                    : economics === "DISCOUNTED"
                      ? "warning"
                      : "info"
                }
              >
                {economics}
              </Badge>
              <Badge tone={contract.status === "ACTIVE" ? "positive" : "neutral"}>
                {contract.status}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Performance obligations (ASC 606 Steps 2 + 4)</CardTitle>
          <span className="text-xs text-ink-500">
            SSP shown is the ALLOCATED amount (post step 4). Σ allocated = total contract value.
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <tr>
                <TH>#</TH>
                <TH>Description</TH>
                <TH>Pattern</TH>
                <TH>Dates</TH>
                <TH>Revenue acct</TH>
                <TH>Deferred acct</TH>
                <TH className="text-right">Allocated</TH>
                <TH className="text-right">% of total</TH>
              </tr>
            </THead>
            <TBody>
              {contract.performanceObligations.map((po) => {
                const allocated = new Decimal(po.ssp.toString());
                const pct = totalDecimal.isZero()
                  ? new Decimal(0)
                  : allocated.dividedBy(totalDecimal).times(100);
                return (
                  <TR key={po.id}>
                    <TD className="text-ink-400">{po.sequenceNo}</TD>
                    <TD className="text-ink-900">{po.description}</TD>
                    <TD>
                      <Badge tone="info">{po.recognitionPattern}</Badge>
                    </TD>
                    <TD className="text-xs text-ink-500">
                      {formatDate(po.startDate)}
                      {po.endDate ? ` → ${formatDate(po.endDate)}` : ""}
                    </TD>
                    <TD className="font-mono text-xs">{po.revenueAccountCode}</TD>
                    <TD className="font-mono text-xs">{po.deferredAccountCode}</TD>
                    <TD className="amount-cell text-right">{formatMoney(allocated)}</TD>
                    <TD className="text-right text-ink-700">{formatPercent(pct)}</TD>
                  </TR>
                );
              })}
              <TR className="bg-ink-50 font-medium">
                <TD />
                <TD className="text-ink-700">Σ allocated</TD>
                <TD colSpan={4} />
                <TD className="amount-cell text-right text-ink-900">
                  {formatMoney(totalAllocated)}
                </TD>
                <TD />
              </TR>
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI contract extraction</CardTitle>
          <span className="text-xs text-ink-500">
            Re-read the stored contract document with Claude Opus 4.7 and propose a
            structured set of performance obligations. AI suggests; you approve.
          </span>
        </CardHeader>
        <CardContent>
          <ExtractionPanel contractId={contract.id} hasDocument={!!contract.document} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recognition schedule (ASC 606 Step 5)</CardTitle>
          <span className="text-xs text-ink-500">
            {contract.recognitionSchedules.length} planned period
            {contract.recognitionSchedules.length === 1 ? "" : "s"} ·{" "}
            {formatPercent(recognizedPct)} recognized · {formatMoney(plannedSum)} pending
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {contract.recognitionSchedules.length === 0 ? (
            <div className="p-6 text-sm text-ink-500">
              No schedule generated yet — re-run the seed or approve an extraction.
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>PO</TH>
                  <TH>Book</TH>
                  <TH>Period</TH>
                  <TH className="text-right">Planned</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Action</TH>
                </tr>
              </THead>
              <TBody>
                {contract.recognitionSchedules.map((s) => {
                  const po = poBySeq.get(s.obligationId);
                  return (
                    <TR key={s.id}>
                      <TD className="text-ink-400">PO{po?.sequenceNo ?? "?"}</TD>
                      <TD className="font-mono text-xs text-ink-700">{s.bookCode}</TD>
                      <TD className="text-ink-700">{formatMonth(s.periodStart)}</TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(s.plannedAmount.toString())}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            s.status === "POSTED"
                              ? "positive"
                              : s.status === "SKIPPED"
                                ? "neutral"
                                : "warning"
                          }
                        >
                          {s.status}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        {s.status === "PLANNED" ? (
                          <PostRecognitionButton scheduleId={s.id} />
                        ) : (
                          <span className="text-[11px] text-ink-400">—</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {contract.bookAttributes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Book attributes</CardTitle>
            <span className="text-xs text-ink-500">
              Multi-book recognition basis. ACCRUAL for GAAP/IFRS; CASH for tax basis on certain entities.
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <tr>
                  <TH>Book</TH>
                  <TH>Basis</TH>
                  <TH className="text-right">Cumulative recognized</TH>
                </tr>
              </THead>
              <TBody>
                {contract.bookAttributes.map((ba) => (
                  <TR key={ba.bookId}>
                    <TD className="font-mono text-ink-900">{ba.book.code}</TD>
                    <TD>
                      <Badge tone={ba.recognitionBasis === "ACCRUAL" ? "info" : "neutral"}>
                        {ba.recognitionBasis}
                      </Badge>
                    </TD>
                    <TD className="amount-cell text-right">
                      {formatMoney(ba.cumulativeRecognized.toString())}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {contract.document ? (
        <Card>
          <CardHeader>
            <CardTitle>Contract document</CardTitle>
            <span className="text-xs text-ink-500">
              The source text the AI extractor will read in v0.2.{" "}
              {contract.document.filename ? `Filename: ${contract.document.filename}` : ""}
            </span>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-ink-100 bg-ink-50 p-3 font-mono text-xs text-ink-700">
              {contract.document.rawText}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div className={`mt-0.5 text-sm text-ink-800 ${mono ? "amount-cell" : ""}`}>
        {value}
      </div>
    </div>
  );
}
