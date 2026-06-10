// NetSuite revenue-arrangement export shape types.
//
// Hand-rolled from the NetSuite REST API documentation + the
// SuiteScript revenue-arrangement record JSON shape + the field
// inventory documented in ledger-core's
// `docs/reference/netsuite-revenue-rec-validation.md`.
//
// Naming conventions match NS:
//   - `internalid` / `externalid` are the NS-side identifiers
//   - snake_case fields throughout (NS API style)
//   - `custcol_*` are custom column fields on arrangement elements
//   - `custbody_*` are custom body fields on the arrangement parent
//
// The shape is intentionally narrower than the universal NS mapper in
// ledger-core — that one covers GL + AR + AP + dimensions. This one
// is scoped to revenue arrangements + elements + recognition templates.

/** A reference to another NS record by internalid + optional display name. */
export interface NsRef {
  internalid: string;
  name?: string;
}

// =========================================================================
// Recognition template (parent of the recognition pattern)
// =========================================================================

/**
 * Revenue recognition template — what NS calls a "Revenue Recognition
 * Rule" or "Plan." Maps to revenue-rec's `RecognitionPattern` enum.
 *
 * Common NS template types:
 *   - "On revenue arrangement creation date" → POINT_IN_TIME
 *   - "Even posting amounts using start and end dates" → OVER_TIME_STRAIGHT
 *   - "Variable posting amounts based on usage" → OVER_TIME_USAGE
 *   - "Percent complete based on project milestones" → OVER_TIME_MILESTONE
 */
export interface NsRecognitionTemplate {
  internalid: string;
  name: string;
  /**
   * NS internal type identifier. Common values:
   *   - "REC_RECOGNITION_DATE"  — recognized in full on a date
   *   - "REC_EVEN_USING_DATES"  — straight-line between dates
   *   - "REC_USAGE"             — usage-driven
   *   - "REC_PERCENT_COMPLETE"  — milestone-driven
   */
  rec_method: string;
  /**
   * Initial-amount-recognized policy. Some NS templates require an
   * initial chunk recognized on creation (e.g., implementation fee
   * bundled with a year of SaaS). Optional — null for most ratable
   * services.
   */
  initial_amount_recognized?: number | null;
}

// =========================================================================
// Revenue arrangement parent + element rows
// =========================================================================

/**
 * The top-level revenue arrangement record in NetSuite. One arrangement
 * per contract (typically; NS allows multi-arrangement contracts but
 * the common case is 1:1).
 */
export interface NsRevenueArrangement {
  internalid: string;
  /** NS document number — e.g., "RA-2026-000123". */
  tranid: string;
  /** Subsidiary owning this arrangement (multi-sub deployments). */
  subsidiary: NsRef;
  /** Customer the arrangement is for. */
  customer: NsRef;
  /** Currency the amounts are denominated in (ISO 4217). */
  currency: string;
  /**
   * Accounting standard governing the arrangement. NS uses string
   * identifiers; we care about ASC 606 vs IFRS 15 in revenue-rec's
   * per-book recognition basis.
   */
  accounting_standard: "ASC_606" | "IFRS_15" | string;
  /** ISO date when the arrangement was created. */
  arrangement_date: string;
  /** Total transaction price — sum of all element allocated_amounts. */
  transaction_price: number;
  /** Discount applied to the total (informational). */
  discount?: number;
  /** Element rows — one per PO. */
  elements: NsArrangementElement[];
  /** Optional custom body fields (custbody_*). */
  custom_body?: Record<string, string | number | boolean | null>;
}

/**
 * One element on a revenue arrangement — corresponds to a
 * `PerformanceObligation` in revenue-rec.
 */
export interface NsArrangementElement {
  /** NS line-level internal identifier. */
  line_internal_id: string;
  /** 1-based ordering as the element appears on the arrangement. */
  sequence_no: number;
  /** Reference to the NS Item (sold thing). */
  item: NsRef;
  /** Human-readable description (free-form text from the item or override). */
  description: string;
  /** Standalone Selling Price — the ASC 606 ¶77 SSP. */
  ssp: number;
  /**
   * Fair-value evidence method per ASC 606 ¶77. NS uses one-letter
   * codes; we normalize to revenue-rec's `FairValueMethod` enum in
   * the mapper.
   */
  fair_value_method?: "ESP" | "VSOE" | "TPE" | "RESIDUAL" | string;
  /**
   * The ASC 606 ¶78 allocated transaction price for this element.
   * When divergent from SSP, this is the authoritative recognition
   * amount.
   */
  allocated_amount: number;
  /**
   * Allocation method used to produce `allocated_amount`. NS uses
   * descriptive strings; we normalize in the mapper.
   */
  allocation_method?: "RELATIVE_SSP" | "RESIDUAL" | "MANUAL" | string;
  /** Item quantity. Defaults to 1 if absent. */
  quantity?: number;
  /** Per-unit amount when quantity > 1; total = amount × quantity. */
  amount?: number;
  /** Reference to the recognition template applied. */
  rec_template: NsRef;
  /** ISO date when recognition begins. */
  rev_rec_start_date: string;
  /** ISO date when recognition ends (null for POINT_IN_TIME). */
  rev_rec_end_date?: string | null;
  /** GL account for revenue posting. */
  revenue_account: NsRef;
  /** GL account for deferred revenue. */
  deferred_revenue_account: NsRef;
  /** Optional custom column fields (custcol_*). */
  custom_columns?: Record<string, string | number | boolean | null>;
}

// =========================================================================
// Top-level export bundle (what an NS export script produces)
// =========================================================================

/**
 * A complete NS revenue-arrangement export. The orchestrator
 * (import.ts in the follow-up PR) consumes this; the pure mappers
 * in mappers.ts translate each record type independently.
 */
export interface NsRevenueArrangementExport {
  /** When the NS export ran (ISO). */
  exported_at: string;
  /** NS account id the export came from (informational). */
  account_id: string;
  /** Recognition templates referenced by arrangement elements. */
  recognition_templates: NsRecognitionTemplate[];
  /** Revenue arrangements. */
  arrangements: NsRevenueArrangement[];
}
