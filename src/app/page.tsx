// Dashboard. v0.1 surface: the "what needs my attention" view across
// every active contract.
//   - Total contracts
//   - Active contracts
//   - Σ allocated revenue planned but not yet recognized this period
//   - Σ recognized to date

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/format";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function DashboardPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the dashboard
  // aggregates. Without these filters, the dashboard would tally Σ
  // contract value + recognized revenue across every tenant.
  const tenant = await getCurrentTenant();
  const contractWhere = tenant
    ? { entity: { tenantId: tenant.id } }
    : { id: "__none__" };
  const scheduleWhere = tenant
    ? { contract: { entity: { tenantId: tenant.id } } }
    : { id: "__none__" };
  const [contracts, schedules] = await Promise.all([
    prisma.revenueContract.findMany({
      where: contractWhere,
      select: {
        id: true,
        code: true,
        status: true,
        totalContractValue: true,
        contractStartDate: true,
        contractEndDate: true,
        customer: { select: { displayName: true } },
      },
      orderBy: { contractStartDate: "desc" },
    }),
    prisma.recognitionSchedule.findMany({
      where: scheduleWhere,
      select: { plannedAmount: true, status: true },
    }),
  ]);

  const activeCount = contracts.filter((c) => c.status === "ACTIVE").length;
  const totalContractValue = contracts.reduce(
    (acc, c) => acc.plus(new Decimal(c.totalContractValue.toString())),
    new Decimal(0)
  );
  const plannedTotal = schedules
    .filter((s) => s.status === "PLANNED")
    .reduce((acc, s) => acc.plus(new Decimal(s.plannedAmount.toString())), new Decimal(0));
  const postedTotal = schedules
    .filter((s) => s.status === "POSTED")
    .reduce((acc, s) => acc.plus(new Decimal(s.plannedAmount.toString())), new Decimal(0));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Dashboard</h1>
        <p className="text-sm text-ink-500">
          Where you are with ASC 606 recognition across every active contract.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Contracts" value={contracts.length} />
        <Metric label="Active" value={activeCount} />
        <Metric
          label="Σ contract value"
          value={formatMoney(totalContractValue)}
          mono
        />
        <Metric
          label="Recognized to date"
          value={formatMoney(postedTotal)}
          mono
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contracts</CardTitle>
          <span className="text-xs text-ink-500">
            v0.1: read-only. AI contract extractor + month-end posting via ledger-core ship in v0.2.
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {contracts.length === 0 ? (
            <div className="p-6 text-sm text-ink-500">
              No contracts seeded.{" "}
              <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">pnpm db:seed</code>{" "}
              wires the sample Initech contract.
            </div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {contracts.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/contracts/${c.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-ink-50"
                  >
                    <div>
                      <div className="font-mono text-sm text-ink-900">{c.code}</div>
                      <div className="text-xs text-ink-500">
                        {c.customer.displayName} ·{" "}
                        {c.contractStartDate.toISOString().slice(0, 10)} →{" "}
                        {c.contractEndDate?.toISOString().slice(0, 10) ?? "open-ended"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="amount-cell text-sm text-ink-700">
                        {formatMoney(c.totalContractValue.toString())}
                      </span>
                      <Badge tone={c.status === "ACTIVE" ? "positive" : "neutral"}>
                        {c.status}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Planned (next to be posted)</CardTitle>
          </CardHeader>
          <CardContent className="amount-cell text-xl text-ink-900">
            {formatMoney(plannedTotal)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Posted (already recognized)</CardTitle>
          </CardHeader>
          <CardContent className="amount-cell text-xl text-positive">
            {formatMoney(postedTotal)}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div
          className={`mt-1 text-lg font-semibold text-ink-900 ${mono ? "amount-cell" : ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
