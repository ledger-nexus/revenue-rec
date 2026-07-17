# AGENTS.md — revenue-rec

Instructions for AI coding/review agents (Codex, etc.). The **reviewer's contract**: what to check, what is *intentional and must NOT be flagged*. Canonical: [`CLAUDE.md`](CLAUDE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md).

## What this is

`revenue-rec` is the ASC 606 / IFRS 15 revenue-recognition engine in the `ledger-nexus` portfolio. It reads contracts, structures them into performance obligations, allocates transaction price by standalone selling price (SSP), and generates a recognition schedule. Resulting JEs post through ledger-core's HTTP boundary — never by writing ledger-core tables directly.

## Review THESE first

- **The posting boundary + PII redaction** — same as recon. All errors through `src/lib/monitoring/index.ts` (`redactPii` first); **never `console.error` a Prisma error's `.message`.** `ContractDocument.rawText` is the highest-sensitivity column in the whole portfolio — counterparty names and contract terms live there. Any raw-error emission is a Confidentiality-TSC defect.
- **Penny-perfect totals.** The allocator and schedule generator round per element to 2dp and absorb the cumulative rounding residual on the **last** element, so `Σ allocations ≡ totalContractValue` and `Σ schedule ≡ allocated`, exactly. Tests assert this. A change that spreads rounding differently, or drops the residual, is a defect.
- **Server Actions** scope by session tenant; AI extraction output is persisted as a suggestion and requires human approval before the deterministic engine posts.

## Intentional — do NOT report these as defects

- **The `prisma/schema.prisma` ledger-core mirror is GENERATED, FK-closed, not accidental duplication.** Do NOT suggest importing from ledger-core or "de-duplicating." Subset-mirror over a shared DB is the deliberate architecture.
- **`prisma db push` is BANNED (no `db:push` script).** Schema changes to revenue-rec-owned tables use the reviewed-diff protocol (`npm run db:diff` → keep only owned statements → `prisma db execute`). Don't recommend `db push` / `migrate dev`.
- **`performance_obligation` is a LEDGER-CORE-OWNED table.** Its allocation columns (`allocatedAmount`, `allocationMethod`, `fairValueMethod`, `quantity`) and the `AllocationMethod` / `FairValueMethod` enums were upstreamed into ledger-core (ledger-core #262) and are ordinary mirrored columns here now — not a deviation, not revenue-rec's to alter. New columns on it go to ledger-core first.
- **The deterministic core (`allocator.ts`, `schedule.ts`) makes no DB calls and no model calls** — pure functions, by design. Don't suggest adding caching or DB access there.
- **`USAGE` / `MILESTONE` recognition patterns intentionally `throw` with a v0.3 pointer** — not-yet-implemented, deliberately explicit, not a swallowed case.
- **The AI extractor uses Opus (not Haiku)** — contract interpretation is reasoning-heavy; a deliberate model choice, not a cost oversight.

## Security lens (SOC 2)

Portfolio baseline. The `rawText` redaction path is the load-bearing control — real bypasses (raw `.message` to Sentry/console, missing field in `redact-pii.ts`) are high value.
