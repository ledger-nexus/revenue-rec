# AI contract extraction (v0.2)

How revenue-rec turns an unstructured contract document into approved performance obligations + a recognition schedule, then posts the recognition JEs through ledger-core. AI proposes; humans approve; ledger-core posts.

## The pipeline, end to end

```
┌────────────────────────────────────────────────────────────────────────┐
│ ContractDocument.rawText is in the DB (from seed, or v0.2-beta upload) │
└────────────────────────────────────────────────────────────────────────┘
                                  │
                  user clicks "Re-run AI extraction"
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│ extractContractAction(contractId)   [server action]                    │
│   1. Read ContractDocument.rawText                                     │
│   2. extractContract() — Claude Opus 4.7, messages.parse, prompt-cached│
│   3. Persist AiExtractionSuggestion for audit (every run logged)       │
│   4. Return the proposal to the UI                                     │
└────────────────────────────────────────────────────────────────────────┘
                                  │
                          UI renders proposed POs
                          (description, SSP, pattern,
                           dates, rationale, notes)
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│ user reviews → clicks "Approve & replace contract POs"                 │
└────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│ approveExtractionAction({contractId, performanceObligations, ...})     │
│   1. Run deterministic allocator on approved SSPs + total              │
│   2. Wipe existing POs + cascade RecognitionSchedule                   │
│   3. Create fresh POs with allocated amounts                           │
│   4. Generate + persist RecognitionSchedule per PO under US_GAAP       │
│   5. Flip contract status to ACTIVE                                    │
│                                                                        │
│ RecognitionEvents from prior approvals SURVIVE — they're keyed on      │
│ contractId, not obligationId, so they remain attached.                 │
└────────────────────────────────────────────────────────────────────────┘
                                  │
                  on the schedule table, user clicks
                  "Post" on a PLANNED row
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│ postRecognitionAction({scheduleId})                                    │
│   1. Build the 2-line JE:                                              │
│        DR  Deferred Revenue (PO.deferredAccountCode)  plannedAmount    │
│        CR  Revenue          (PO.revenueAccountCode)   plannedAmount    │
│      source="AI_APPROVED"                                              │
│   2. POST to ledger-core /api/internal/journal-entries (bridge)        │
│   3. On success:                                                       │
│        - RecognitionEvent created with the returned entry id           │
│        - RecognitionSchedule.status → POSTED                           │
│        - PerformanceObligation.recognizedToDate incremented            │
│        - RevenueContractBookAttributes.cumulativeRecognized incremented│
└────────────────────────────────────────────────────────────────────────┘
```

## Why Opus 4.7 for extraction

Contract interpretation IS reasoning-heavy:

- Identifying *distinct* performance obligations requires judgment about whether two promises are separable (a subscription + integral installation = one PO; subscription + standalone training = two POs)
- Inferring SSPs when only bundled prices are stated requires estimating market value from contract language
- Detecting variable consideration, contract modifications, or non-obvious recognition triggers requires reading carefully

This is the inverse of recon's matching task, which is structured-output *ranking* over a small candidate set — well-suited to Haiku. The right model depends on the task shape, not on cost preference.

**Don't downgrade to Haiku for cost.** Contracts run rarely (once per contract, occasionally on amendment). Per-call cost is a few cents at most. The accuracy gap is large.

## Prompt caching

The system prompt (the ASC 606 extraction guide) is wrapped in `cache_control: { type: "ephemeral" }`. Across many contracts, the instructions are stable; the contract text varies and goes in the user message.

**Verifying hits**: every extraction logs `cache_read_input_tokens` and `cache_creation_input_tokens` from `response.usage`. The first extraction in a 5-minute window pays the create cost; subsequent extractions within the TTL pay only the read cost.

**Pitfall to avoid**: any byte change to `SYSTEM_PROMPT` in `src/lib/extraction/ai-extract.ts` invalidates the cache for every downstream call. Treat edits like a schema migration — bunch up wording tweaks, ship them together, don't churn.

## Structured output via `messages.parse`

Unlike recon (which is pinned to SDK 0.65 and uses forced tool-use as a structured-output workaround), revenue-rec uses SDK 0.98's native `messages.parse` + `zodOutputFormat`:

```typescript
const response = await client.messages.parse({
  model: "claude-opus-4-7",
  output_config: { format: zodOutputFormat(ExtractionResponseSchema) },
  // ...
});
const parsed = response.parsed_output;  // fully typed, validated against Zod
```

If the model output fails the Zod schema, `parse()` throws — no need for the manual `schema.parse(toolUse.input)` step recon does. Cleaner.

The Zod schema (`ExtractionResponseSchema`) is the wire contract between AI and the rest of the engine. Adding a field requires three coordinated changes: the schema, the system prompt's "you ALWAYS return" list, and any downstream consumers. Treat that triple like a migration too.

## Audit: AiExtractionSuggestion is sacred

Every extraction lands in `AiExtractionSuggestion`, **including runs that get discarded.** The table answers "did the AI actually help here?" without it, you can't tell whether the model is contributing signal or running up token bills.

Fields worth knowing:

- `obligationsJson` — the full extracted POs, including ones the human rejected during review
- `promptHash` — SHA-256 over system + user. Group by hash for cache-hit analytics.
- `promptTokens` / `completionTokens` / `latencyMs` — cost telemetry
- `modelName` — locked to whatever was current at run time. When we evaluate a new model, the history is intact for A/B comparison.

What's NOT stored: which POs the human edited, kept, or discarded during approval. That's an enhancement for v0.3 (a `humanApproval` join table linking AiExtractionSuggestion rows to the eventual PO rows). For now, "did the AI run?" + "what did it propose?" is the audit floor.

## Failure modes

| Failure | Symptom | Handling |
|---|---|---|
| No ContractDocument attached | `extractContractAction` returns ok: false with a clear message | UI hides the extraction button until a document is attached |
| ANTHROPIC_API_KEY not set | SDK constructor throws | UI shows the error; deterministic engine + posting still work without AI |
| Model returns malformed JSON | `messages.parse` throws via Zod | Error surfaces to UI; no AiExtractionSuggestion row written |
| Model exceeds max_tokens | `parsed_output` is null, `stop_reason: "max_tokens"` | Throws "no parsed output"; raise `max_tokens` or shorten contract |
| ledger-core unreachable on post | `LedgerCoreError("TRANSPORT_ERROR")` | Schedule row stays PLANNED; user retries after starting ledger-core |
| Period closed in ledger-core | `LedgerCoreError("PERIOD_CLOSED")` (status 409) | Same as recon: surface verbatim. The accountant has to reopen or adjust period scope. |

## What revenue-rec never does with AI

- AI never calls `postJournalEntry` directly or via the bridge. Posting requires a human-driven action (the schedule row's "Post" button), which routes through `postRecognitionAction`.
- AI never decides recognition pattern is "right" without human review. The schedule generator runs ONLY after `approveExtractionAction`.
- AI never sees data outside this one contract's text. No cross-contract, cross-customer, cross-entity leakage by construction.
- AI's SSPs are NEVER used to allocate without the human re-running the allocator on approval. The deterministic math always re-runs server-side.

## Smoke test

Live end-to-end: `npm run smoke:e2e`. Requires Postgres + ledger-core dev server + both env tokens set. Runs the extractor on the seeded contract, prints token usage + cache stats, then posts the first PLANNED schedule row via the bridge and prints the resulting ledger-core entry number.

This is the test mocked-SDK + mocked-fetch tests can't do for you. Run it before any change to `ai-extract.ts` or `ledger-bridge.ts` goes to prod.
