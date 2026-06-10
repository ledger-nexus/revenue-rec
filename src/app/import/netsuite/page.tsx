// /import/netsuite — paste an NS revenue-arrangement export bundle +
// import it as RevenueContract + PerformanceObligation rows.
//
// The interactive form lives in `ImportPanel` (client component);
// this Server Component is just the page chrome.

import { Card } from "@/components/ui/card";
import { ImportPanel } from "./import-panel";

export default function NsImportPage() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">
          Import NetSuite revenue arrangements
        </h1>
        <p className="mt-1 text-sm text-ink-600">
          Paste a NetSuite revenue-arrangement export bundle below.
          Each arrangement becomes one <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">RevenueContract</code> + N <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">PerformanceObligation</code> rows.
          The lineage triple (<code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">sourceSystem</code>, <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">sourceRecordType</code>, <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">sourceRecordId</code>)
          ensures idempotency — re-importing the same bundle is safe.
        </p>
      </header>

      <Card className="p-5">
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-ink-800">
            Bundle shape
          </summary>
          <div className="mt-3 space-y-3 text-ink-600">
            <p>
              The top-level shape is{" "}
              <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">NsRevenueArrangementExport</code>:
            </p>
            <pre className="overflow-x-auto rounded bg-ink-50 p-3 text-xs leading-relaxed text-ink-700">{`{
  "exported_at": "2026-06-05T00:00:00Z",
  "account_id": "your-ns-account-id",
  "recognition_templates": [
    { "internalid": "tpl-1", "name": "Even Across Dates",
      "rec_method": "REC_EVEN_USING_DATES" }
  ],
  "arrangements": [
    {
      "internalid": "ra-123",
      "tranid": "RA-2026-000123",
      "subsidiary": { "internalid": "sub-1", "name": "Acme US" },
      "customer": { "internalid": "cust-42", "name": "Initech LLC" },
      "currency": "USD",
      "accounting_standard": "ASC_606",
      "arrangement_date": "2026-01-01",
      "transaction_price": 12000,
      "elements": [
        {
          "line_internal_id": "ele-1",
          "sequence_no": 1,
          "item": { "internalid": "item-saas" },
          "description": "Annual SaaS subscription",
          "ssp": 12000,
          "fair_value_method": "ESP",
          "allocated_amount": 12000,
          "allocation_method": "RELATIVE_SSP",
          "quantity": 1,
          "rec_template": { "internalid": "tpl-1" },
          "rev_rec_start_date": "2026-01-01",
          "rev_rec_end_date": "2026-12-31",
          "revenue_account": { "internalid": "4000" },
          "deferred_revenue_account": { "internalid": "2200" }
        }
      ]
    }
  ]
}`}</pre>
            <p className="text-xs text-ink-500">
              Prereq: NS subsidiaries must already be bootstrapped as <code className="rounded bg-ink-100 px-1 py-0.5">LegalEntity</code> rows via ledger-core&apos;s universal NetSuite mapper (code convention: <code className="rounded bg-ink-100 px-1 py-0.5">NSSUB-{`{internalid}`}</code>). Otherwise the entity resolver returns empty and the arrangement is logged as an error.
            </p>
          </div>
        </details>
      </Card>

      <ImportPanel />
    </div>
  );
}
