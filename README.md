# revenue-rec

> ASC 606 / IFRS 15 revenue recognition engine. AI reads contracts; humans approve; ledger-core posts.

Third repo in the [`ledger-nexus`](https://github.com/ledger-nexus) portfolio. Shares the substrate Postgres database with [`ledger-core`](https://github.com/ledger-nexus/ledger-core) and follows the same architectural pattern as [`recon`](https://github.com/ledger-nexus/recon): mirror the substrate's read-only models, add domain-specific owned tables, and write back via ledger-core's HTTP boundary.

**The portfolio narrative is consistent.** v0.1 ships the deterministic ASC 606 mechanics — allocation, schedule generation, structured persistence — without any AI or substrate writes. v0.2 layers the AI contract extractor and the HTTP bridge to ledger-core so the loop closes: read contract → propose POs → human approves → post deferred revenue + monthly recognition.

---

## Architecture in one sentence

`revenue-rec` queries ledger-core's tables (read-only), maintains its own (`ContractDocument`, `AiExtractionSuggestion`, `RecognitionSchedule`, `RecognitionEvent`), and writes deferred-revenue + recognition journal entries to the ledger via ledger-core's `/api/internal/journal-entries` endpoint with `source: "AI_APPROVED"` after explicit human review.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the relationship to ledger-core in detail.

## What's wired (v0.1)

- ✅ Prisma schema: 8 ledger-core mirrored models + 4 revenue-rec-owned models (`ContractDocument`, `AiExtractionSuggestion`, `RecognitionSchedule`, `RecognitionEvent`)
- ✅ **SSP allocator** (`src/lib/accounting/allocator.ts`) — ASC 606 Step 4. Given a total transaction price + array of SSPs, allocates proportionally. Penny-perfect totals (last PO absorbs the rounding residual). Helper `classifyContractEconomics` reports AT_SSP / DISCOUNTED / PREMIUM.
- ✅ **Recognition schedule generator** (`src/lib/accounting/schedule.ts`) — ASC 606 Step 5. Supports POINT_IN_TIME + OVER_TIME_STRAIGHT (the 95% case). OVER_TIME_USAGE + OVER_TIME_MILESTONE land in v0.2 with the AI extractor.
- ✅ **Sample fixture**: Initech SaaS contract. $60K annual subscription bundled with $10K implementation services, sold for $60K total (so there's a $10K discount). Illustrates proportional discount allocation: subscription gets $51,428.57; implementation gets $8,571.43.
- ✅ **Read-only UI**: dashboard, contracts list, contract detail with PO breakdown, full recognition schedule, economics badge, book attributes, and the raw contract text the AI will read in v0.2
- ✅ **Unit tests**: 22 tests across allocator + schedule generator, all green, no DB needed

## What lands next (v0.2)

- 🚧 **AI contract extractor** — uses the `claude-api` skill with `claude-opus-4-7`. Reads contract text, returns structured `{description, ssp, recognitionPattern, startDate, endDate}` per performance obligation. Audited in `AiExtractionSuggestion`. Why Opus (not Haiku like recon): contract interpretation IS reasoning-heavy.
- 🚧 **Approval UI**: human reviews extracted POs, edits, approves. On approve: contract + POs + schedule rows persist; deferred-revenue JEs post via the bridge.
- 🚧 **HTTP bridge to ledger-core** (mirror of recon's `src/lib/ledger-bridge.ts`)
- 🚧 **Month-end recognition run**: Server Action walks PLANNED schedule rows due in the current period, posts a recognition JE per (PO, period) via the bridge, flips schedule rows to POSTED.
- 🚧 OVER_TIME_USAGE + OVER_TIME_MILESTONE patterns

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
│   │   └── contracts/                 # list + detail
│   ├── lib/
│   │   ├── db.ts                      # PrismaClient singleton
│   │   ├── accounting/
│   │   │   ├── allocator.ts           # ASC 606 Step 4: SSP allocation
│   │   │   └── schedule.ts            # ASC 606 Step 5: recognition schedule
│   │   └── utils/                     # cn(), formatMoney(), etc.
│   └── components/                    # UI primitives + nav
├── tests/
│   ├── allocator.test.ts              # SSP allocator (11 tests)
│   └── schedule.test.ts               # schedule generator (11 tests)
└── docs/
    └── ARCHITECTURE.md                # relationship to ledger-core + scope boundaries
```

## About this project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI:

| Repo | Role | Status |
|---|---|---|
| [`ledger-core`](https://github.com/ledger-nexus/ledger-core) | Universal accounting substrate (substrate, sub-ledgers, 9 reports, ERP mappers, internal HTTP endpoint) | v1.2 ✅ |
| [`recon`](https://github.com/ledger-nexus/recon) | AI-assisted bank reconciliation | v0.2-beta ✅ |
| `revenue-rec` (this) | ASC 606 revenue recognition engine | v0.1 in flight |

MIT licensed.
