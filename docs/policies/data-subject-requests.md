# Data subject request procedure — revenue-rec

**Owner:** Privacy lead (shared with the rest of the portfolio; see
`ledger-core/docs/policies/access-control.md`)
**Last reviewed:** 2026-06-03
**Defers to:** `ledger-core/docs/policies/data-subject-requests.md` — the
canonical, portfolio-wide procedure.

This document covers what's **unique to the `revenue-rec` repo**: the
ASC 606 contract surfaces, contract-document storage, and how a
data-subject request is honored against them. The general procedure
(channels, identity verification, SLA, audit-logging) lives in
`ledger-core` and is NOT duplicated here.

---

## What personal data this repo holds

### `User` + `Tenant` + `TenantMembership` (replicated)

FK-convenience replicas of the canonical rows in `ledger-core`.
Read-mostly; canonical writes live in `ledger-core`. An erasure in
`ledger-core` propagates to the replica on the next sync cycle.

| Field | Classification | Notes |
|---|---|---|
| `User.email` | CONFIDENTIAL | Replica; encrypted at rest. |
| `User.displayName` | CONFIDENTIAL | Replica; encrypted at rest. |
| `Tenant.name` | CONFIDENTIAL | Replica; encrypted at rest. |

### Contract surfaces (tenant data with substantial incidental PII)

revenue-rec is the **highest-PII-density** companion repo. Contracts
are between the tenant and a counterparty, but a contract document
routinely names: signatories, contact emails, addresses, payment
terms, deal-specific carve-outs. All of this is the counterparty's
PII, not the user's, but it's still personal data and must be
encrypted.

| Field | Classification | Notes |
|---|---|---|
| `RevenueContract.description` | CONFIDENTIAL | Tenant-authored deal summary — counterparty names + deal terms. **Encrypted at rest**. |
| `PerformanceObligation.description` | CONFIDENTIAL | Per-obligation summary. **Encrypted at rest**. |
| `ContractDocument.filename` | CONFIDENTIAL | Often encodes counterparty name + execution date. **Encrypted at rest**. |
| `ContractDocument.rawText` | **HIGH-SENSITIVITY CONFIDENTIAL** | Full extracted text of the executed contract — signatories, addresses, payment terms. **Encrypted at rest**. |
| `Party.displayName` | CONFIDENTIAL | Counterparty (customer) names. **Encrypted at rest**. |
| `AiExtractionSuggestion.{inputText, outputJson}` | CONFIDENTIAL | The model's input (a contract excerpt) and structured output (suggested POs + SSP allocations). **Encrypted at rest**. |
| `JournalLine.description` | CONFIDENTIAL | Free-text line memo. Not encrypted (matches ledger-core's choice). |

### Recognition schedule (INTERNAL)

`RecognitionSchedule` + `RecognitionEvent` rows are tenant data. No
direct user PII; subject erasure does not remove them.

---

## DSR procedure for THIS repo's data

### Right of access (Art. 15)

Export bundle contribution from this repo is **attribution counts only**:

1. Contracts the subject (as ADMIN+) created or modified — count
   only.
2. Contract documents the subject uploaded — count + filenames-stripped
   metadata (size, format, upload date). **Contract bodies are NOT
   included** because the contract is between the tenant and the
   counterparty; the subject is acting on the tenant's behalf, not
   exposing their own personal data.
3. AI extraction suggestions the subject reviewed — count only.

If a SUBJECT also happens to be the COUNTERPARTY on a contract (e.g.,
the founder is the named signatory in a side-letter), they have a
right to that data BUT must request it through the tenant, not
through us. We are a processor for the tenant in that scenario;
the controller is the tenant.

Attribution helper stub at `src/lib/privacy/rr-attribution.ts` (TODO).

### Right to erasure (Art. 17)

1. **User row replica:** redact via the ledger-core sync; no
   revenue-rec action required.
2. **Contracts + contract documents + recognition schedules:**
   **preserved** under Art. 17(3)(b) (compliance with financial-
   reporting + tax obligation) and (e) (defense of legal claims —
   contract documents are evidence of obligations). User id stays on
   attribution edges so the audit trail remains intact.
3. **`AiExtractionSuggestion` rows** referencing the subject as the
   reviewer: `reviewerUserId` stays; row preserved (7-year AI audit
   trail retention).

No revenue-rec-specific erasure orchestrator. The Postgres sync
replicates the redacted User row from ledger-core.

### Special case: counterparty erasure request

A counterparty is NOT a User in our system — they're a `Party` row
owned by the tenant. If a counterparty contacts us directly:

1. Respond directing them to the tenant they did business with — we
   are the processor; the tenant is the controller.
2. **Do not** unilaterally redact `Party.displayName` or contract
   text on a counterparty's request. The tenant has independent
   legal obligations (financial reporting, audit, tax) that survive
   the counterparty's erasure right.
3. If the tenant subsequently instructs us to redact, we treat that
   as a tenant-initiated data correction (not a DSR) and document
   per `docs/policies/change-management.md`.

### Right to rectification (Art. 16)

Not applicable. User/Tenant updates flow from ledger-core; contract
data is tenant-curated, not subject-curated.

### Right to portability (Art. 20)

Covered by the access export attribution counts. No separate
procedure.

---

## What an auditor asks for, and where it lives

| Auditor question | Where the answer lives |
|---|---|
| "Do you have a DSR procedure?" | `ledger-core/docs/policies/data-subject-requests.md` (canonical) + this file (this-repo scope) |
| "Where is the executed contract text stored, and is it encrypted?" | `ContractDocument.rawText` — encrypted at rest via `src/lib/db/encrypted-fields-extension.ts` |
| "When a subject is erased, what happens to contracts they negotiated?" | "Right to erasure" section above — preserved under tax + recordkeeping + defense-of-claims exemptions |
| "What if a counterparty (not a user) asks to be erased?" | "Special case: counterparty erasure request" section above — we are the processor; route to the tenant |
| "How long do you retain AI extraction suggestions?" | 7 years per `ledger-core/docs/policies/data-classification.md`; encrypted at rest |

---

## Open items (tracked for the next sprint, not blocking)

1. **`src/lib/privacy/rr-attribution.ts`** — typed stub for the
   attribution-counts helper called from ledger-core's export bundle.
2. **Contract-document soft-delete UI for tenants** — when a tenant
   replaces a contract version, the old `ContractDocument.rawText`
   stays until retention. A tenant-driven "remove old version"
   action would shorten that window. NOT a DSR requirement;
   tenant-controlled hygiene.
