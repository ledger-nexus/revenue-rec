<!-- BEGIN multi-session-orchestrator amendment (v1) -->

## ⚠️ Multi-session coordination (READ FIRST)

This repo may have parallel Claude sessions — they clobber each other's writes without coordination.

1. **Read `STATUS.md`** at the repo root before editing any file. If your task overlaps an active claim, pick a different task or surface the conflict to the user.
2. **Claim your scope** before your first edit: append a `### Session <id>` block to STATUS.md under "Active claims" with scope / files-globs / branch / heartbeat (format documented in STATUS.md). Commit STATUS.md atomically.
3. **Heartbeat** every ~20 turns. Small commit.
4. **Release** at session end: move your block to "Recent completions" with an outcome line. Commit.

Never edit another session's claim, skip the read, or claim `**`.

<!-- END multi-session-orchestrator amendment -->

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

## What's wired (v0.2)

- Prisma schema: 8 ledger-core mirrored models + 4 revenue-rec-owned models (`ContractDocument`, `AiExtractionSuggestion`, `RecognitionSchedule`, `RecognitionEvent`)
- SSP allocator (`src/lib/accounting/allocator.ts`) — ASC 606 Step 4 math with `classifyContractEconomics` helper (AT_SSP / DISCOUNTED / PREMIUM)
- Recognition schedule generator (`src/lib/accounting/schedule.ts`) — supports POINT_IN_TIME + OVER_TIME_STRAIGHT; USAGE / MILESTONE intentionally error with a v0.3 pointer
- **AI contract extractor** (`src/lib/extraction/ai-extract.ts`) — Claude Opus 4.7 via the official SDK 0.98, `messages.parse` + `zodOutputFormat` for structured output, prompt caching on the system prefix. Per portfolio convention: Opus (not Haiku like recon) because contract interpretation is reasoning-heavy.
- **HTTP bridge to ledger-core** (`src/lib/ledger-bridge.ts`) — mirror of recon's bridge. Same wire contract on `/api/internal/journal-entries`.
- **Server Actions**:
  - `extractContractAction` — runs AI extractor on a contract's stored document, persists AiExtractionSuggestion, returns proposal
  - `approveExtractionAction` — wipes contract POs + cascades schedule, re-runs deterministic allocator on approved SSPs, regenerates schedule, flips contract to ACTIVE
  - `postRecognitionAction` — posts ONE PLANNED schedule row via the bridge as a 2-line JE (DR Deferred Revenue, CR Revenue) with `source: "AI_APPROVED"`, then flips schedule to POSTED + bumps `recognizedToDate` + `cumulativeRecognized`
- **Interactive UI** on contract detail: "Re-run AI extraction" button → AI proposal panel with rationales → "Approve & replace" button. "Post" button per PLANNED schedule row.
- **Unit tests**: 38 across allocator (11), schedule (11), bridge (9 with mocked fetch), extractor (7 with mocked SDK)
- **End-to-end smoke script** (`scripts/smoke-test-e2e.ts`) — runs the full extract → post-recognition loop against real infrastructure; gated on env vars.

## What's next (v0.3 ideas)

- Multi-line approval flow: edit individual POs before approval, not just accept verbatim
- OVER_TIME_USAGE pattern (usage-based recognition driven by event ingestion)
- OVER_TIME_MILESTONE pattern (project-based recognition at named completion points)
- Variable consideration (expected value / most-likely-amount methods, constraint logic)
- Contract modifications (cumulative catch-up vs prospective vs separate-contract treatment)
- Multi-book recognition basis differences (the schema supports it; v0.2 only emits US_GAAP)
- Initial deferred-revenue posting on approval (currently the per-period JE handles both the deferral debit and the revenue credit implicitly; v0.3 may split this for clarity)
- `AiExtractionSuggestion` audit panel UI

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
