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
});

// ASC 606 Step 3 variable consideration component proposed by the
// extractor. The reviewer can edit/reject before approval; on approve
// the deterministic engine creates a corresponding VariableConsideration
// row + initial reassessment baseline.
// One probability-weighted scenario for the EXPECTED_VALUE method.
// The AI surfaces these so the operator + auditor can see the math
// behind the unconstrained estimate rather than a single opaque number.
const ExtractedOutcomeSchema = z.object({
  scenario: z
    .string()
    .max(200)
    .describe(
      "Short label for this outcome. E.g. 'Customer hits 80% of volume target', 'Q4 milestone delivered on time'."
    ),
  amount: z
    .number()
    .describe(
      "Dollar amount the variable consideration would land at under this scenario. Signed per the parent component's direction (the math layer applies the sign)."
    ),
  probabilityPercent: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "Probability of this scenario, 0..100. Across all outcomes for one component the values MUST sum to 100 (we allow 99.5–100.5 to absorb rounding)."
    ),
});

const ExtractedVariableConsiderationSchema = z.object({
  description: z
    .string()
    .describe(
      "Short label for this component, suitable as the VariableConsideration row label. E.g. 'Q4 volume rebate', 'On-time delivery bonus', '30-day refund right'."
    ),
  method: z
    .enum(["EXPECTED_VALUE", "MOST_LIKELY_AMOUNT"])
    .describe(
      "EXPECTED_VALUE for many-outcome scenarios (probability-weighted); MOST_LIKELY_AMOUNT for binary outcomes."
    ),
  direction: z
    .enum(["INCREASE", "DECREASE"])
    .describe(
      "INCREASE adds to transaction price (bonus, overage). DECREASE reduces it (refund right, rebate)."
    ),
  unconstrainedAmount: z
    .number()
    .min(0)
    .describe(
      "Best-estimate variable amount before applying the ASC 606-10-32-11 constraint. Always >= 0. For EXPECTED_VALUE method this should equal the probability-weighted sum of `outcomes`."
    ),
  constrainedAmount: z
    .number()
    .min(0)
    .describe(
      "The amount included in transaction price after the constraint. Must be <= unconstrainedAmount. Operator can revise."
    ),
  constraintRationale: z
    .string()
    .max(400)
    .describe(
      "Auditor-facing reasoning: what would cause a significant reversal, why constrained at this level. One to three sentences, concrete."
    ),
  outcomes: z
    .array(ExtractedOutcomeSchema)
    .default([])
    .describe(
      "Probability-weighted scenarios — REQUIRED when method=EXPECTED_VALUE so the auditor sees the math behind unconstrainedAmount. Omit (empty array) for MOST_LIKELY_AMOUNT. Probabilities across outcomes must sum to ~100% (we accept 99.5–100.5)."
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
      "The total dollar amount the customer will pay, as stated in the contract — BEFORE applying variable consideration. The deterministic allocator runs on baseline + Σ(variable consideration), not this number alone."
    ),
  currencyCode: z.string().describe("ISO 4217, usually 'USD'."),
  performanceObligations: z
    .array(ExtractedPoSchema)
    .min(1)
    .describe(
      "All distinct POs identified in the contract, in order of appearance."
    ),
  variableConsideration: z
    .array(ExtractedVariableConsiderationSchema)
    .default([])
    .describe(
      "Every detected ASC 606 Step 3 variable consideration component. Empty array if the contract is fully fixed consideration. Default [] for backward-compat with AiExtractionSuggestion rows persisted before this field was added."
    ),
  notes: z
    .string()
    .max(500)
    .describe(
      "Anything the human reviewer should know: contract modifications, ambiguity in the source, deviations from common patterns. Variable consideration goes in its own field, not here."
    ),
});

export type ExtractedPo = z.infer<typeof ExtractedPoSchema>;
export type ExtractedOutcome = z.infer<typeof ExtractedOutcomeSchema>;
export type ExtractedVariableConsideration = z.infer<
  typeof ExtractedVariableConsiderationSchema
>;
export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

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

Step 3 — Determine transaction price. The contract's stated totalContractValue is the BASELINE — what the customer will pay if every variable outcome lands at the midpoint. The engine adds/subtracts variable consideration on top.

If the contract carries variable consideration — volume rebates, performance bonuses, refund rights, tiered discounts, milestone bonuses, royalties — fill the variableConsideration array. ONE entry per distinguishable component. For each:

- **description**: short label ("Q4 volume rebate", "On-time delivery bonus", "30-day refund right"). This shows up on the contract's VariableConsideration table.
- **direction**: INCREASE if it adds to transaction price (bonus, overage payment, incentive). DECREASE if it reduces it (refund right, rebate, allowance for returns).
- **method**: MOST_LIKELY_AMOUNT for binary outcomes ("bonus paid or not"). EXPECTED_VALUE for many-outcome scenarios ("volume tier hit somewhere on the curve"). Pick the one that better fits the contract's structure — ASC 606-10-32-8 leaves this to judgment.
- **unconstrainedAmount**: your best estimate of what this component is worth, IGNORING the constraint. For most-likely: the single most likely outcome. For expected value: the probability-weighted mean.
- **constrainedAmount**: what the engine should include in the transaction price after applying ASC 606-10-32-11. The constraint says "include the amount only to the extent it's PROBABLE a significant reversal won't occur." Translate that to a number: typically a fraction of the unconstrained estimate. If you're highly confident the unconstrained will materialize, constrained = unconstrained. If you're meaningfully uncertain, constrained < unconstrained. The reviewer often adjusts this.
- **constraintRationale**: explain in 1-3 sentences WHY constrained < unconstrained (what could cause a reversal) or why they're equal (why a reversal is improbable). The auditor reads this verbatim.
- **outcomes**: REQUIRED when method=EXPECTED_VALUE — emit 2-5 distinct probability-weighted scenarios that show your math. Each outcome: short scenario label, dollar amount under that scenario, probability percent. Probabilities MUST sum to 100. The unconstrainedAmount you give above should equal the probability-weighted sum (Σ amount × probability/100). For MOST_LIKELY_AMOUNT method, leave outcomes empty — the single most-likely outcome is captured by unconstrainedAmount alone.

  Example outcomes for a "Q4 volume rebate" with EXPECTED_VALUE method:
    {scenario: "Customer misses target (no rebate)", amount: 0, probabilityPercent: 25}
    {scenario: "Customer hits 80% of target (partial rebate)", amount: 3000, probabilityPercent: 50}
    {scenario: "Customer exceeds target (full rebate)", amount: 6000, probabilityPercent: 25}
  → unconstrainedAmount = 0×0.25 + 3000×0.50 + 6000×0.25 = 3000

If the contract is fully fixed consideration, return an empty variableConsideration array. Don't fabricate components.

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
- totalContractValue is the BASELINE the customer would pay before variable consideration, not Σ SSP. (Σ SSP differs when there's a discount or premium; the adjusted transaction price the engine allocates = totalContractValue + Σ(signed constrainedAmount across ACTIVE variable consideration).)
- Be conservative about SSPs you estimate. If the rationale would be "I'm guessing," say so in notes so the human can override.
- Variable consideration: see Step 3 — emit every detected component in the variableConsideration array, NOT in notes. Empty array if the contract is fully fixed.
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
