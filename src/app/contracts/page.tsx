// Contracts list page.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

export default async function ContractsListPage() {
  const contracts = await prisma.revenueContract.findMany({
    select: {
      id: true,
      code: true,
      description: true,
      status: true,
      totalContractValue: true,
      contractStartDate: true,
      contractEndDate: true,
      customer: { select: { displayName: true } },
      _count: { select: { performanceObligations: true } },
    },
    orderBy: { contractStartDate: "desc" },
  });

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Contracts</h1>
        <p className="text-sm text-ink-500">
          Every revenue contract recognized through this engine.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{contracts.length} contract{contracts.length === 1 ? "" : "s"}</CardTitle>
        </CardHeader>
        <CardContent className={contracts.length === 0 ? "" : "p-0"}>
          {contracts.length === 0 ? (
            <EmptyState title="No contracts yet">
              Run <code className="font-mono">pnpm db:seed</code> to wire the sample Initech contract.
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Customer</TH>
                  <TH>Term</TH>
                  <TH className="text-right">Total value</TH>
                  <TH className="text-right">POs</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {contracts.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-mono text-ink-900">
                      <Link href={`/contracts/${c.id}`} className="hover:underline">
                        {c.code}
                      </Link>
                    </TD>
                    <TD className="text-ink-700">{c.customer.displayName}</TD>
                    <TD className="text-xs text-ink-500">
                      {formatDate(c.contractStartDate)} →{" "}
                      {c.contractEndDate ? formatDate(c.contractEndDate) : "open"}
                    </TD>
                    <TD className="amount-cell text-right">
                      {formatMoney(c.totalContractValue.toString())}
                    </TD>
                    <TD className="text-right text-ink-700">
                      {c._count.performanceObligations}
                    </TD>
                    <TD>
                      <Badge tone={c.status === "ACTIVE" ? "positive" : "neutral"}>
                        {c.status}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
