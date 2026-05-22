# Claude Code Instructions for revenue-rec

Auto-loaded by Claude Code on every session in this repo.

## What this project is

`revenue-rec` is the ASC 606 / IFRS 15 revenue recognition engine in the `ledger-nexus` portfolio. It reads contracts (text in v0.1, PDFs and AI-extracted in v0.2), structures them into performance obligations, allocates transaction price by standalone selling price (SSP), and generates a monthly recognition schedule. Posting the resulting JEs happens through the same HTTP bridge pattern recon uses — never by writing to ledger-core tables directly.

ledger-core has already cut a slot for this work: its `RevenueContract`, `PerformanceObligation`, and `RevenueContractBookAttributes` models exist on the substrate, and its source comment says verbatim *"the actual recognition engine lives in the consumer repo revenue-rec."*

The architecture canon is `docs/ARCHITECTURE.md`.

## The non-negotiables

1. **AI suggests; humans approve; ledger-core posts.** Same as recon. v0.2 will add the AI contract extractor and the HTTP bridge to ledger-core's `/api/internal/journal-entries`. No code path in this repo may write to ledger-core tables directly.

2. **The schema mirror is a contract.** The ledger-core models in `prisma/schema.prisma` (LegalEntity, Book, Party, JournalEntry, JournalLine, RevenueContract, PerformanceObligation, RevenueContractBookAttributes) must match ledger-core's column-for-column. If you change them here, you've broken the contract.

3. **The deterministic core stays deterministic.** SSP allocator (`src/lib/accounting/allocator.ts`) and schedule generator (`src/lib/accounting/schedule.ts`) are pure functions with no DB access, no model calls. The AI lives ONLY in the extractor (v0.2+), and even then it produces structured proposals that humans approve before the deterministic engine takes over.

4. **Penny-perfect totals.** The allocator and schedule generator both round per-element to 2dp and absorb the cumulative rounding residual on the last element so Σ allocations ≡ totalContractValue and Σ schedule periods ≡ allocated amount, exactly. Tests assert this.

## What's wired (v0.1)

- Prisma schema: 8 ledger-core mirrored models + 4 revenue-rec-owned models (`ContractDocument`, `AiExtractionSuggestion`, `RecognitionSchedule`, `RecognitionEvent`)
- SSP allocator (`src/lib/accounting/allocator.ts`) — ASC 606 Step 4 math with `classifyContractEconomics` helper (AT_SSP / DISCOUNTED / PREMIUM)
- Recognition schedule generator (`src/lib/accounting/schedule.ts`) — supports POINT_IN_TIME + OVER_TIME_STRAIGHT; OVER_TIME_USAGE / MILESTONE land in v0.2
- Sample fixture: Initech SaaS contract — $60K subscription + $10K implementation sold for $60K (discounted), illustrates proportional discount allocation
- Read-only UI: dashboard, contracts list, contract detail showing PO breakdown + schedule + economics badge + raw contract text
- Unit tests: 22 tests across allocator + schedule generator (no DB needed)

## What's next (v0.2)

- AI contract extractor — uses the `claude-api` skill. Reads `ContractDocument.rawText` (and PDFs in v0.2-beta), returns structured `{description, ssp, recognitionPattern, startDate, endDate, rationale}` per PO. **Per portfolio convention, recommend Opus 4.7 for this** — contract interpretation IS reasoning-heavy (unlike recon's matching, which was structured ranking suited to Haiku).
- Approval UI: human reviews extracted POs, edits, and approves. On approve: contract + POs + schedule rows get persisted; deferred-revenue JEs get posted via the bridge.
- HTTP bridge to ledger-core (mirror of recon's `src/lib/ledger-bridge.ts`)
- Month-end recognition run: a Server Action that walks PLANNED schedule rows due in the current period and posts a recognition JE per (PO, period) via the bridge, then flips the schedule row to POSTED
- `AiExtractionSuggestion` audit panel — same pattern as recon's `AiSuggestion`

## Stack

- Next.js 14 (App Router), port 3002 (ledger-core uses 3000, recon uses 3001)
- Postgres + Prisma (shared with ledger-core, same arrangement as recon)
- decimal.js for all money math
- Vitest for tests (no DB needed for v0.1 unit tests)
- Tailwind + inlined UI primitives (same convention as ledger-core / recon)
- Anthropic SDK lands in v0.2

## Rules for working in this codebase

### Money math
Always use `Decimal` from `decimal.js`. Per-PO and per-period rounding lands on the LAST element so totals tie exactly. If you write new allocation/schedule logic, write the rounding-residual test first.

### Database
- Import `prisma` from `@/lib/db` (the singleton). Never `new PrismaClient()` in a page or component.
- revenue-rec's `prisma db push` only touches revenue-rec-owned tables. If you add a new model, it must NOT shadow an existing ledger-core table.
- Querying ledger-core's tables is fine; writing to them via Prisma is forbidden. Adjustment / recognition JEs go through the HTTP bridge.

### AI integration (v0.2+)
- Use the `claude-api` skill.
- **Recommended model: `claude-opus-4-7` for contract extraction.** This is the inverse of recon's Haiku choice — contract language is genuinely unstructured and requires interpretation. Don't downgrade for cost.
- Prompt caching ON for the system prefix (extraction instructions). The contract text varies per call and goes in the user message.
- Store every extraction in `AiExtractionSuggestion` for audit, even if the human edits it heavily.
- The AI never decides anything load-bearing. It proposes; a human signs off; the deterministic engine takes over.

### UI work
- Same conventions as ledger-core / recon: App Router, Server Components by default, Server Actions for forms, inline UI primitives in `src/components/ui/`.
- Dashboard surfaces "what needs my attention" — schedule rows due for posting, contracts pending AI extraction review — not vanity metrics.

## How to start a session

1. Read this file.
2. Read `docs/ARCHITECTURE.md` (the relationship to ledger-core).
3. Confirm: does this work belong in revenue-rec (recognition timing, allocation, contract extraction) or ledger-core (the JE-posting substrate)?
