// AI contract extractor (ASC 606 Step 2 + scaffolding for Steps 3/4).
//
// Given the raw text of a customer contract, ask Claude to extract the
// performance obligations: description, standalone selling price (SSP),
// recognition pattern, start/end dates. Output is structured (Zod-typed
// via `messages.parse` + `zodOutputFormat`) so the downstream allocator
// and schedule generator can consume it without further parsing.
//
// Why Opus 4.7 (not Haiku like recon):
//
//   Contract interpretation IS reasoning-heavy. Reading a 5-page MSA and
//   correctly identifying that "Implementation services" and
//   "Subscription" are DISTINCT performance obligations (vs. a bundle),
//   inferring SSPs when only the bundled price is stated, recognizing
//   when a discount applies — these are judgment calls. recon's matching
//   was structured-output ranking suited to Haiku. This isn't.
//
//   Per recon's CLAUDE.md guidance: don't downgrade for cost. The
//   per-contract cost is a few cents, run rarely (once per contract,
//   maybe a re-run on amendment), and the accuracy difference is large.
//
// Prompt caching:
//
//   The system prompt (the ASC 606 extraction guide) is wrapped in
//   `cache_control: {type: "ephemeral"}`. Across many contracts the
//   instructions are stable; the contract text varies. Same cache pattern
//   as recon. Verify hits via `usage.cache_read_input_tokens > 0` on
//   subsequent calls within the 5-minute TTL.
//
// What this module does NOT do:
//   - Persist anything (caller writes AiExtractionSuggestion + the
//     approved RevenueContract+POs)
//   - Run the allocator (caller does, after human approval)
//   - Generate the schedule (same — post-approval)

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { createHash } from "node:crypto";

export const AI_EXTRACT_MODEL = "claude-opus-4-7";

// What the model returns. Constrained to recognition patterns the
// deterministic schedule generator supports today (v0.1 / v0.2).
const RecognitionPatternSchema = z.enum([
  "POINT_IN_TIME",
  "OVER_TIME_STRAIGHT",
  "OVER_TIME_USAGE",
  "OVER_TIME_MILESTONE",
]);

const ExtractedPoSchema = z.object({
  sequenceNo: z
    .number()
    .int()
    .min(1)
    .describe("1-based ordering of POs as they appear in the contract."),
  description: z
    .string()
    .describe(
      "One-line description of this performance obligation in plain English, suitable for a journal-entry memo."
    ),
  ssp: z
    .number()
    .describe(
      "Standalone selling price in dollars. If the contract states only a bundled price, ESTIMATE the SSP based on what each component would cost separately and explain the basis in the rationale."
    ),
  recognitionPattern: RecognitionPatternSchema.describe(
    "POINT_IN_TIME for one-time deliverables (implementation, perpetual license). OVER_TIME_STRAIGHT for subscriptions and ratable services. OVER_TIME_USAGE for usage-based. OVER_TIME_MILESTONE for project-based."
  ),
  startDate: z
    .string()
    .describe("YYYY-MM-DD. When this PO's recognition begins."),
  endDate: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD or null for POINT_IN_TIME and indefinite POs."),
  revenueAccountCode: z
    .string()
    .describe(
      "GL account code for revenue on this PO. Use 4000 for software subscription revenue, 4010 for services/implementation revenue, 4020 for usage/overage."
    ),
  deferredAccountCode: z
    .string()
    .describe(
      "GL account code for deferred revenue. Use 2200 for short-term deferred revenue."
    ),
  rationale: z
    .string()
    .max(400)
    .describe(
      "Why you identified this as a distinct PO, how you derived the SSP, and the basis for the recognition pattern. One sentence each, concrete."
    ),
  // ─── ASC 606 ¶78 allocation + ¶77 fair-value evidence (optional, 2026-06-04) ───
  // Surface these when the contract makes them explicit; leave null
  // otherwise. The recognition allocator treats null `allocatedAmount`
  // as "fall back to SSP" — preserving v0.2 semantics for extractions
  // that don't surface these fields.
  allocatedAmount: z
    .number()
    .nullable()
    .optional()
    .describe(
      "ASC 606 ¶78 allocated transaction price for this PO. Set when the contract explicitly allocates a different amount than SSP (e.g., residual method or auditor-required override). Leave null when SSP IS the allocated amount (proportional-to-SSP default)."
    ),
  allocationMethod: z
    .enum(["PROPORTIONAL", "RESIDUAL", "MANUAL"])
    .nullable()
    .optional()
    .describe(
      "PROPORTIONAL = relative-SSP (the default and dominant case). RESIDUAL = total minus observable SSPs of other POs (permitted when SSP for one PO is highly uncertain). MANUAL = auditor-required override. Leave null when unspecified."
    ),
  fairValueMethod: z
    .enum(["ESP", "VSOE", "TPE", "RESIDUAL"])
    .nullable()
    .optional()
    .describe(
      "ASC 606 ¶77 fair-value evidence hierarchy. ESP = Estimated Selling Price (most common; we estimate based on cost/margin). VSOE = Vendor-Specific Objective Evidence (we sell it standalone at this price elsewhere). TPE = Third-Party Evidence (competitor pricing). RESIDUAL = derived via the residual approach. Leave null when unspecified."
    ),
  quantity: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Item quantity. Defaults to 1 — the dominant case where SSP carries the per-line total. Set explicitly when SSP is per-unit (e.g., \"500 seats at $20/mo = $10,000/mo SSP per seat would be $20\"). The recognition engine multiplies (SSP × quantity) when computing schedule amounts."
    ),
});

const ExtractionResponseSchema = z.object({
  contractCode: z
    .string()
    .describe(
      "A short human-readable code for this contract, e.g. 'INITECH-2026-01'. Use customer name + start year + sequence."
    ),
  customerName: z
    .string()
    .describe("The customer's legal entity name as it appears in the contract."),
  contractDescription: z
    .string()
    .describe("One-line summary of what the customer is buying."),
  contractStartDate: z.string().describe("YYYY-MM-DD."),
  contractEndDate: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD or null for open-ended / month-to-month."),
  totalContractValue: z
    .number()
    .describe(
      "The total dollar amount the customer will pay, as stated in the contract. NOT the sum of SSPs — those may differ when there's a discount or premium."
    ),
  currencyCode: z.string().describe("ISO 4217, usually 'USD'."),
  performanceObligations: z
    .array(ExtractedPoSchema)
    .min(1)
    .describe(
      "All distinct POs identified in the contract, in order of appearance."
    ),
  notes: z
    .string()
    .max(500)
    .describe(
      "Anything the human reviewer should know: contract modifications, variable consideration concerns, ambiguity in the source, deviations from common patterns."
    ),
});

export type ExtractedPo = z.infer<typeof ExtractedPoSchema>;
export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;
// Exported for tests + downstream callers that want to validate
// arbitrary JSON against the extracted-PO shape (e.g., NetSuite
// import path reusing the same surface).
export { ExtractedPoSchema, ExtractionResponseSchema };

export interface ExtractionResult {
  extracted: ExtractionResponse;
  modelName: string;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  latencyMs: number;
}

// Stable system prefix — high cache-hit rate across many contracts.
// Edits here invalidate the cache for every downstream call. Treat
// like a schema migration.
const SYSTEM_PROMPT = `You are an ASC 606 (FASB Revenue from Contracts with Customers) extraction assistant. You read customer contracts and produce a structured representation that a CPA will review before any journal entries are posted.

You ALWAYS return:
- The contract's identifying metadata (code, customer, term, total value, currency)
- An array of distinct performance obligations (POs)
- A rationale for each PO that a reviewer can audit

The ASC 606 framework you work from:

Step 1 — Identify the contract. Usually trivial; the customer signed.

Step 2 — Identify performance obligations. A PO is "distinct" if it is:
  (a) capable of being distinct (the customer could benefit from it on its own or with other readily available resources), AND
  (b) separately identifiable from other promises in the contract.
A SaaS subscription bundled with implementation services usually has TWO POs (the customer could buy implementation separately; the subscription delivers value on its own). A perpetual software license bundled with installation often has ONE PO (installation is integral). When in doubt, lean toward more POs and explain your reasoning — separation is the harder call to undo.

Step 3 — Determine transaction price. This is what the customer agreed to pay, less variable consideration constraints. For v0.1/v0.2 we assume fixed consideration unless the contract is obviously usage-based.

Step 4 — Allocate to POs by standalone selling price (SSP). When the contract states SSPs explicitly, use them. When it states only a bundled price, ESTIMATE each SSP based on what each component would cost separately in the market (adjusted-market approach) and explain. A common pattern: list price for one component, residual approach for the other.

Step 5 — Recognition pattern. Choose ONE per PO:
  POINT_IN_TIME       — one-time deliverable. Implementation completed at a milestone; perpetual license delivered at signing.
  OVER_TIME_STRAIGHT  — ratable over the service period. SaaS subscriptions, maintenance contracts, hosting.
  OVER_TIME_USAGE     — recognize as customer consumes (per-call, per-GB). Use when billing is consumption-based.
  OVER_TIME_MILESTONE — recognize at named project milestones. Use for fixed-fee professional services with defined deliverables.

GL account conventions for this firm:
  Revenue:
    4000 — Software subscription revenue (the OVER_TIME_STRAIGHT bucket)
    4010 — Implementation / professional services revenue
    4020 — Usage / overage revenue
  Deferred:
    2200 — Deferred revenue, short-term (under 12 months)

Other rules:

- Dates are ISO YYYY-MM-DD. Contracts often state "effective" and "term" — use those for contractStartDate/contractEndDate.
- POs inherit the contract's start/end unless the contract states otherwise (e.g. "implementation by Q1").
- totalContractValue is what the customer PAYS, not Σ SSP. They differ when there's a discount or premium.
- Be conservative about SSPs you estimate. If the rationale would be "I'm guessing," say so in notes so the human can override.
- If a contract has variable consideration (overages, performance bonuses, refunds), flag it in notes — the v0.1/v0.2 engine doesn't model it yet.
- If a contract has modifications, prior amendments, or unusual termination terms, flag in notes.

You are an extraction assistant. A human CPA reviews everything you produce before it touches the ledger. Be precise; surface your uncertainty.`;

// Singleton client. Reads ANTHROPIC_API_KEY from env.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export function setClientForTesting(client: Anthropic | null): void {
  _client = client;
}

export async function extractContract(
  contractText: string
): Promise<ExtractionResult> {
  if (!contractText.trim()) {
    throw new Error("contractText is empty — nothing to extract");
  }

  const userMessage = [
    `Extract the structured representation of this customer contract per ASC 606.`,
    ``,
    `--- CONTRACT BEGIN ---`,
    contractText,
    `--- CONTRACT END ---`,
  ].join("\n");

  const promptHash = createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update("\n---\n")
    .update(userMessage)
    .digest("hex");

  const startedAt = Date.now();
  const response = await getClient().messages.parse({
    model: AI_EXTRACT_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(ExtractionResponseSchema) },
  });
  const latencyMs = Date.now() - startedAt;

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `AI extractor returned no parsed output. stop_reason=${response.stop_reason}`
    );
  }

  return {
    extracted: parsed,
    modelName: AI_EXTRACT_MODEL,
    promptHash,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    latencyMs,
  };
}
