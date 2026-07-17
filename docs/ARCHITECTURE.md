# revenue-rec architecture

How revenue-rec relates to ledger-core, and the rationale behind the choices.

## The portfolio shape

```
┌─────────────────────────────────────────────────────────────────┐
│                          Postgres                               │
│  ledger_core schema (shared by all three repos)                 │
└─────────────────────────────────────────────────────────────────┘
              ▲                       ▲                       ▲
              │                       │                       │
              │ reads + writes        │ reads only            │ reads only
              │ (substrate owner)     │ (mirror)              │ (mirror)
              │                       │                       │
   ┌──────────┴──────────┐  ┌─────────┴────────┐  ┌──────────┴──────────┐
   │    ledger-core      │  │      recon       │  │    revenue-rec      │
   │     (port 3000)     │  │   (port 3001)    │  │    (port 3002)      │
   │                     │  │                  │  │                     │
   │  postJournalEntry   │  │  bank recon      │  │  ASC 606 engine     │
   │  is THE write       │  │  AI matches      │  │  AI extracts        │
   │  boundary           │  │  → bridge POST   │  │  → bridge POST      │
   └─────────────────────┘  └──────────────────┘  └─────────────────────┘
                                      │                       │
                                      └───────┬───────────────┘
                                              │
                                              ▼
                              POST /api/internal/journal-entries
                              (on ledger-core, token-gated)
```

Three repos, one Postgres database, one substrate-write boundary. revenue-rec is the third — its job is to take unstructured contract data and turn it into structured journal entries, posted through the same HTTP boundary recon uses.

## ASC 606 in one paragraph

Five steps: (1) identify the contract, (2) identify performance obligations, (3) determine the transaction price, (4) allocate the price to POs by standalone selling price, (5) recognize revenue when (or as) each PO is satisfied. The math is deterministic given the inputs; the inputs require reading and interpreting contract documents. revenue-rec automates the math and uses AI to assist the interpretation — but never lets the AI post.

## Where each piece lives

### In ledger-core (the substrate, already built)

- `RevenueContract` + `PerformanceObligation` + `RevenueContractBookAttributes` tables — the structured data shape
- `createRevenueContract` helper — wraps `RevenueContract.create` with party + book lookups
- A minimal straight-line recognition runner adequate for the Northwind seed (Globex prepay)
- The `postJournalEntry` function — ALL ledger writes go through it

### In revenue-rec (this repo)

- **Schema mirror**: copies of ledger-core's relevant models so we can query them via Prisma without expanding ledger-core's schema
- **Owned tables**:
  - `ContractDocument` — the raw text of the contract (and PDF reference in v0.2-beta)
  - `AiExtractionSuggestion` — audit trail of AI runs (one row per extraction call, including rejected ones)
  - `RecognitionSchedule` — the full planned schedule (PO × period × amount); persisted at contract approval so the UI can render it before any posting happens
  - `RecognitionEvent` — one row per actual JE posted, linked to the ledger-core entry id returned by the bridge
- **Deterministic engine**: `src/lib/accounting/allocator.ts` (Step 4) + `src/lib/accounting/schedule.ts` (Step 5). Both pure functions.
- **AI extractor** (v0.2): reads `ContractDocument.rawText`, returns structured POs
- **HTTP bridge** (v0.2): mirror of recon's `src/lib/ledger-bridge.ts`. POSTs to ledger-core's `/api/internal/journal-entries`.
- **UI**: read-only in v0.1; interactive approve / post-recognition flows in v0.2

## Why a schema mirror (not an npm dep)

Same rationale as recon. The mirror is column-for-column with ledger-core. The two repos share Postgres but generate their own Prisma clients — TypeScript treats them as distinct types, which is why writes go through HTTP rather than an in-process import.

The mirror is a contract: when ledger-core's schema changes upstream, this copy must be re-synced. The CLAUDE.md non-negotiable #2 names this explicitly.

## Schema-safety protocol (re-synced 2026-07-16)

The mirror went stale once (it lagged ledger-core by several sprints of columns — `tenantId` denormalization, ownership/audit columns, `totalDebit`/`totalCredit`, and more), and the old schema header claimed `prisma db push` from this repo "creates our tables on top of ledger-core's". That claim was wrong: because this schema declares only a **subset** of the shared database, `db push` executes the FULL diff — with a stale mirror, that diff contains destructive ALTERs against ledger-core-owned tables (xbrl-filer measured 284 statements, 263 destructive, from the same pattern). Therefore:

- **`db push` and `migrate dev` are banned in this repo** — the npm scripts were removed. Never reintroduce them.
- The mirror is **generated from ledger-core's schema** (currently main commit `9442667`, 2026-07-16), column-for-column, relations trimmed to the mirrored set — never hand-edited.
- The mirror is **FK-closed**: every foreign key on a mirrored table points at another mirrored table (which is why Currency, Period, FiscalCalendar, Item, DimensionSet, Tenant, etc. are mirrored). ledger-core's raw-SQL indexes on mirrored tables (4× `extensions` GIN + `gl_entry_header_total_debit_idx`) are declared too. Result: `npm run db:diff` produces **zero statements** naming any ledger-core-owned or revenue-rec-owned table. A non-zero result = mirror drift; re-generate before doing anything else.
- Schema changes to revenue-rec-owned tables apply via the **reviewed-diff protocol**: `npm run db:diff` → review the script, keep ONLY statements touching revenue-rec-owned tables/enums (`contract_document`, `ai_extraction_suggestion`, `recognition_schedule`, `recognition_event`, `AllocationMethod`, `FairValueMethod`) → `npx prisma db execute --file <reviewed.sql>`. Everything else in the diff is subset-of-shared-DB noise (drops of other repos' objects) and MUST NOT run.
- **Documented deviation**: `performance_obligation` carries four revenue-rec-added columns (`allocatedAmount`, `allocationMethod`, `fairValueMethod`, `quantity`; PR #17) that exist in the shared DB but are not yet in ledger-core's schema. They stay declared in the mirror until upstreamed — see the schema header.

## Why deterministic-first

The ASC 606 math is the part you cannot get wrong. Allocation, schedule, journal mechanics — these have correct answers and the auditor will check them. The interpretation work (is the implementation distinct from the subscription? what's the customer's SSP?) is judgment, and that's where AI helps a human accountant move faster.

So we ship the math first (v0.1) and the AI second (v0.2). When the AI lands, it produces *proposals* the math layer consumes — never the other way around.

## v0.1 boundaries explicitly

What v0.1 does:
- Mirrors the substrate schema + adds owned tables
- Allocates a contract's transaction price across POs by SSP
- Generates a recognition schedule for POINT_IN_TIME + OVER_TIME_STRAIGHT POs
- Persists everything via the seed (the sample Initech contract)
- Renders a read-only UI

What v0.1 explicitly does NOT do:
- Read contracts with AI (no Anthropic SDK yet)
- Post any journal entry (no bridge to ledger-core yet)
- Handle OVER_TIME_USAGE or OVER_TIME_MILESTONE patterns
- Handle contract modifications (cumulative catch-up / prospective / separate-contract treatments)
- Handle variable consideration (expected value / most-likely-amount methods)
- Handle multi-book recognition basis differences (the schema supports it; the engine only emits US_GAAP schedules)

Each of these is a real ASC 606 requirement and a deliberate v0.2+ scope decision. Don't backfill them into v0.1; the value of shipping smaller chunks is the audit trail.
