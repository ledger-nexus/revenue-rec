# revenue-rec

> ASC 606 / IFRS 15 revenue recognition engine. AI reads contracts; humans approve; ledger-core posts.

Third repo in the [`ledger-nexus`](https://github.com/ledger-nexus) portfolio. Shares the substrate Postgres database with [`ledger-core`](https://github.com/ledger-nexus/ledger-core) and follows the same architectural pattern as [`recon`](https://github.com/ledger-nexus/recon): mirror the substrate's read-only models, add domain-specific owned tables, and write back via ledger-core's HTTP boundary.

**The portfolio narrative is consistent.** v0.1 shipped the deterministic ASC 606 mechanics — allocation, schedule generation, structured persistence — without any AI or substrate writes. v0.2 closes the loop: Claude Opus 4.7 reads the contract → proposes structured POs → human reviews + approves → revenue-rec regenerates the schedule deterministically → "Post" button on each PLANNED period fires through the HTTP bridge to ledger-core's `postJournalEntry`. AI never touches the ledger directly.

---

## Architecture in one sentence

`revenue-rec` queries ledger-core's tables (read-only), maintains its own (`ContractDocument`, `AiExtractionSuggestion`, `RecognitionSchedule`, `RecognitionEvent`), and writes deferred-revenue + recognition journal entries to the ledger via ledger-core's `/api/internal/journal-entries` endpoint with `source: "AI_APPROVED"` after explicit human review.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the relationship to ledger-core in detail.

## What's wired (v0.2)

- ✅ Prisma schema: 8 ledger-core mirrored models + 4 revenue-rec-owned models (`ContractDocument`, `AiExtractionSuggestion`, `RecognitionSchedule`, `RecognitionEvent`)
- ✅ **SSP allocator** ([src/lib/accounting/allocator.ts](src/lib/accounting/allocator.ts)) — ASC 606 Step 4. Penny-perfect totals (last PO absorbs the rounding residual). Helper `classifyContractEconomics` (AT_SSP / DISCOUNTED / PREMIUM).
- ✅ **Recognition schedule generator** ([src/lib/accounting/schedule.ts](src/lib/accounting/schedule.ts)) — ASC 606 Step 5. POINT_IN_TIME + OVER_TIME_STRAIGHT (the 95% case). USAGE / MILESTONE intentionally error with v0.3 pointer.
- ✅ **AI contract extractor** ([src/lib/extraction/ai-extract.ts](src/lib/extraction/ai-extract.ts)) — Claude Opus 4.7 via Anthropic SDK 0.98, `messages.parse` + `zodOutputFormat` for typed structured output, prompt caching on the system prefix, hallucination-resistant rationale field. **Opus, not Haiku** — contract interpretation is reasoning-heavy.
- ✅ **HTTP bridge to ledger-core** ([src/lib/ledger-bridge.ts](src/lib/ledger-bridge.ts)) — same wire contract as recon's bridge. POSTs to `/api/internal/journal-entries`.
- ✅ **Server Actions**:
  - `extractContractAction` — AI proposal + AiExtractionSuggestion audit row
  - `approveExtractionAction` — wipes POs + schedule, re-runs deterministic allocator on approved SSPs, regenerates schedule
  - `postRecognitionAction` — posts ONE PLANNED schedule row via the bridge (DR Deferred / CR Revenue, source="AI_APPROVED")
- ✅ **Interactive UI** on contract detail: "Re-run AI extraction" button → proposal panel with per-PO rationales + cache-stats — → "Approve & replace" → per-row "Post" button on PLANNED schedule entries
- ✅ **Sample fixture**: Initech SaaS contract. $60K annual subscription bundled with $10K implementation services, sold for $60K total (so there's a $10K discount). Illustrates proportional discount allocation: subscription gets $51,428.57; implementation gets $8,571.43.
- ✅ **Unit tests**: 38 tests (allocator 11 + schedule 11 + bridge 9 + extractor 7), all green, no live infrastructure needed
- ✅ **End-to-end smoke script** ([scripts/smoke-test-e2e.ts](scripts/smoke-test-e2e.ts)) — `npm run smoke:e2e`. Requires real DB + API key + ledger-core dev server.

This closes the v0.2 loop: AI proposes → human approves → ledger-core posts. AI never touches the ledger directly.

## What lands next (v0.3 ideas)

- 🚧 Multi-line approval flow (edit POs before approving, not just accept verbatim)
- 🚧 OVER_TIME_USAGE + OVER_TIME_MILESTONE patterns
- 🚧 Variable consideration handling
- 🚧 Contract modifications (cumulative catch-up / prospective / separate-contract)
- 🚧 Multi-book recognition (cash basis for tax)
- 🚧 AiExtractionSuggestion audit panel UI

## Quick start

```bash
# Prereq: ledger-core seeded against the same DATABASE_URL
git clone https://github.com/ledger-nexus/revenue-rec.git
cd revenue-rec
pnpm install
cp .env.example .env
# Point DATABASE_URL at the same Postgres ledger-core uses

pnpm db:push      # adds contract_document, recognition_schedule, etc. on top of ledger-core's tables
pnpm db:seed      # creates the sample Initech contract + recognition schedule
pnpm dev          # http://localhost:3002 — note: different ports than ledger-core (3000) and recon (3001)
pnpm test         # SSP allocator + recognition schedule tests
```

## Tech stack

Same as ledger-core / recon: Next.js 14 (App Router), Postgres + Prisma, decimal.js for money math, Vitest for tests, Tailwind for styling. Anthropic SDK + the HTTP bridge land in v0.2.

## Project structure

```
revenue-rec/
├── prisma/
│   ├── schema.prisma                  # ledger-core mirror + revenue-rec-owned models
│   ├── fixtures/
│   │   └── initech-saas-contract.md   # sample contract (the AI will read this in v0.2)
│   └── seed.ts                        # wires up sample contract + allocation + schedule
├── src/
│   ├── app/                           # Next.js App Router
│   │   ├── layout.tsx, page.tsx (dashboard)
│   │   ├── contracts/                 # list + detail (with v0.2 interactive controls)
│   │   └── actions/                   # Server Actions
│   │       ├── extract-contract.ts    # AI extractor + AiExtractionSuggestion
│   │       ├── approve-extraction.ts  # wipe POs + regenerate schedule
│   │       └── post-recognition.ts    # post one period via bridge
│   ├── lib/
│   │   ├── db.ts                      # PrismaClient singleton
│   │   ├── ledger-bridge.ts           # HTTP boundary to ledger-core
│   │   ├── extraction/
│   │   │   └── ai-extract.ts          # Claude Opus 4.7 extractor
│   │   ├── accounting/
│   │   │   ├── allocator.ts           # ASC 606 Step 4
│   │   │   └── schedule.ts            # ASC 606 Step 5
│   │   └── utils/
│   └── components/                    # UI primitives + nav
├── scripts/
│   └── smoke-test-e2e.ts              # live extract + post-recognition smoke test
├── tests/
│   ├── allocator.test.ts              # 11 tests
│   ├── schedule.test.ts               # 11 tests
│   ├── ledger-bridge.test.ts          # 9 tests (mocked fetch)
│   └── ai-extract.test.ts             # 7 tests (mocked Anthropic SDK)
└── docs/
    ├── ARCHITECTURE.md                # relationship to ledger-core + scope boundaries
    └── ai-extraction.md               # full v0.2 pipeline + design rationale
```

## About this project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI:

| Repo | Role | Status |
|---|---|---|
| [`ledger-core`](https://github.com/ledger-nexus/ledger-core) | Universal accounting substrate (substrate, sub-ledgers, 9 reports, ERP mappers, internal HTTP endpoint) | v1.2 ✅ |
| [`recon`](https://github.com/ledger-nexus/recon) | AI-assisted bank reconciliation | v0.2-beta ✅ |
| `revenue-rec` (this) | ASC 606 revenue recognition engine | v0.2 in flight |

MIT licensed.
