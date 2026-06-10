// Pure mapper functions for NetSuite revenue arrangements.
//
// No I/O, no DB access. Each function takes a verbatim NS shape and
// returns a `MappedRevenueContract` / `MappedPerformanceObligation`
// shape suitable for the import orchestrator (follow-up PR).
//
// The mapping is intentionally THIN: we preserve NS source data
// verbatim in the lineage payload so the reverse exporter can
// reconstruct the original. Translation only happens for fields
// revenue-rec's substrate needs in typed form (recognition pattern
// enum, allocation method enum, etc.).

import type {
  NsArrangementElement,
  NsRecognitionTemplate,
  NsRevenueArrangement,
} from "./types";

// =========================================================================
// Output shapes — what the importer writes to revenue-rec's substrate
// =========================================================================

export type RecognitionPattern =
  | "POINT_IN_TIME"
  | "OVER_TIME_STRAIGHT"
  | "OVER_TIME_USAGE"
  | "OVER_TIME_MILESTONE";

export type AllocationMethod = "PROPORTIONAL" | "RESIDUAL" | "MANUAL";
export type FairValueMethod = "ESP" | "VSOE" | "TPE" | "RESIDUAL";

export interface MappedRevenueContract {
  /** revenue-rec contract code; namespaced "NS-RA-{tranid}" by default. */
  code: string;
  description: string;
  /** Customer party code resolution is the orchestrator's job; we pass NS data through. */
  nsCustomerInternalId: string;
  nsCustomerName?: string;
  contractStartDate: string;
  totalContractValue: number;
  currencyId: string;
  /** NS source lineage; preserved verbatim for roundtrip. */
  sourceSystem: "netsuite";
  sourceRecordType: "RevenueArrangement";
  sourceRecordId: string;
  sourcePayload: NsRevenueArrangement;
  mappingVersion: string;
}

export interface MappedPerformanceObligation {
  sequenceNo: number;
  description: string;
  ssp: number;
  /** Null = "use SSP" (back-compat). Non-null when NS allocated_amount diverges. */
  allocatedAmount: number | null;
  /** Null when NS allocation method is unset / unrecognized. */
  allocationMethod: AllocationMethod | null;
  /** Null when NS fair-value method is unset / unrecognized. */
  fairValueMethod: FairValueMethod | null;
  /** Defaults to 1 when NS doesn't specify (the dominant case). */
  quantity: number;
  recognitionPattern: RecognitionPattern;
  startDate: string;
  endDate: string | null;
  revenueAccountCode: string;
  deferredAccountCode: string;
}

export interface MappedArrangement {
  contract: MappedRevenueContract;
  obligations: MappedPerformanceObligation[];
  /** Warnings the orchestrator may surface to the operator. */
  warnings: string[];
}

// =========================================================================
// The mapping version — bump when the translation logic changes
// =========================================================================

export const NS_REVENUE_MAPPING_VERSION = "1.0.0";

// =========================================================================
// Recognition template translation
// =========================================================================

/**
 * Map an NS recognition template's `rec_method` to revenue-rec's
 * `RecognitionPattern` enum. Returns null for unmapped methods; the
 * orchestrator surfaces that as a per-element warning.
 *
 * Coverage matches the ASC 606 dominant cases:
 *   REC_RECOGNITION_DATE → POINT_IN_TIME
 *   REC_EVEN_USING_DATES → OVER_TIME_STRAIGHT
 *   REC_USAGE            → OVER_TIME_USAGE
 *   REC_PERCENT_COMPLETE → OVER_TIME_MILESTONE
 */
export function mapRecognitionTemplate(
  template: NsRecognitionTemplate
): { pattern: RecognitionPattern | null; reason?: string } {
  switch (template.rec_method) {
    case "REC_RECOGNITION_DATE":
      return { pattern: "POINT_IN_TIME" };
    case "REC_EVEN_USING_DATES":
      return { pattern: "OVER_TIME_STRAIGHT" };
    case "REC_USAGE":
      return { pattern: "OVER_TIME_USAGE" };
    case "REC_PERCENT_COMPLETE":
      return { pattern: "OVER_TIME_MILESTONE" };
    default:
      return {
        pattern: null,
        reason: `Unmapped NS rec_method "${template.rec_method}" on template "${template.name}". Treat as POINT_IN_TIME until manually classified.`,
      };
  }
}

// =========================================================================
// Allocation + fair-value method translation
// =========================================================================

/**
 * NS allocation method → revenue-rec `AllocationMethod` enum.
 * Returns null for unrecognized values (the orchestrator may default
 * to PROPORTIONAL or surface a warning).
 */
export function mapAllocationMethod(
  ns: string | undefined
): AllocationMethod | null {
  if (!ns) return null;
  switch (ns) {
    case "RELATIVE_SSP":
      return "PROPORTIONAL";
    case "RESIDUAL":
      return "RESIDUAL";
    case "MANUAL":
      return "MANUAL";
    default:
      return null;
  }
}

/**
 * NS fair-value method → revenue-rec `FairValueMethod` enum.
 * Returns null for unrecognized values.
 */
export function mapFairValueMethod(
  ns: string | undefined
): FairValueMethod | null {
  if (!ns) return null;
  switch (ns) {
    case "ESP":
    case "VSOE":
    case "TPE":
    case "RESIDUAL":
      return ns;
    default:
      return null;
  }
}

// =========================================================================
// Single-element mapper
// =========================================================================

/**
 * Map a single NS arrangement element to a `MappedPerformanceObligation`.
 *
 * @param element - the NS element row
 * @param template - the recognition template the element references
 * @returns mapped PO + any warnings (e.g., unmapped recognition method)
 */
export function mapElement(
  element: NsArrangementElement,
  template: NsRecognitionTemplate | undefined
): { obligation: MappedPerformanceObligation; warnings: string[] } {
  const warnings: string[] = [];

  // Resolve recognition pattern. If template missing or unmapped,
  // default to POINT_IN_TIME with a warning (safe default — recognizes
  // on revRecStartDate; auditor can re-classify).
  let pattern: RecognitionPattern = "POINT_IN_TIME";
  if (!template) {
    warnings.push(
      `Element ${element.line_internal_id}: recognition template "${element.rec_template.internalid}" not found in export bundle. Defaulting to POINT_IN_TIME.`
    );
  } else {
    const t = mapRecognitionTemplate(template);
    if (t.pattern) {
      pattern = t.pattern;
    } else {
      warnings.push(
        `Element ${element.line_internal_id}: ${t.reason}`
      );
    }
  }

  // allocatedAmount: null when equal to ssp (back-compat — "use SSP"
  // semantics in revenue-rec); explicit when divergent.
  const allocatedAmount =
    element.allocated_amount === element.ssp
      ? null
      : element.allocated_amount;

  // quantity: defaults to 1 in revenue-rec's schema; NS often omits.
  const quantity = element.quantity ?? 1;

  const allocationMethod = mapAllocationMethod(element.allocation_method);
  if (element.allocation_method && !allocationMethod) {
    warnings.push(
      `Element ${element.line_internal_id}: unmapped NS allocation_method "${element.allocation_method}". Field left null.`
    );
  }

  const fairValueMethod = mapFairValueMethod(element.fair_value_method);
  if (element.fair_value_method && !fairValueMethod) {
    warnings.push(
      `Element ${element.line_internal_id}: unmapped NS fair_value_method "${element.fair_value_method}". Field left null.`
    );
  }

  const obligation: MappedPerformanceObligation = {
    sequenceNo: element.sequence_no,
    description: element.description,
    ssp: element.ssp,
    allocatedAmount,
    allocationMethod,
    fairValueMethod,
    quantity,
    recognitionPattern: pattern,
    startDate: element.rev_rec_start_date,
    endDate: element.rev_rec_end_date ?? null,
    revenueAccountCode: element.revenue_account.internalid,
    deferredAccountCode: element.deferred_revenue_account.internalid,
  };

  return { obligation, warnings };
}

// =========================================================================
// Full-arrangement mapper
// =========================================================================

/**
 * Map a full NS revenue arrangement (parent + all elements) to a
 * revenue-rec input shape. The orchestrator (import.ts in a follow-up
 * PR) takes this output, resolves the customer party + currency
 * against the substrate, and writes the contract + POs.
 *
 * @param arrangement - the NS arrangement record
 * @param templatesByInternalId - lookup map for recognition templates
 *                                referenced by elements
 * @returns mapped contract + obligations + warnings
 */
export function mapArrangement(
  arrangement: NsRevenueArrangement,
  templatesByInternalId: Map<string, NsRecognitionTemplate>
): MappedArrangement {
  const allWarnings: string[] = [];

  // Map every element; collect per-element warnings.
  const obligations: MappedPerformanceObligation[] = [];
  for (const element of arrangement.elements) {
    const template = templatesByInternalId.get(element.rec_template.internalid);
    const { obligation, warnings } = mapElement(element, template);
    obligations.push(obligation);
    allWarnings.push(...warnings);
  }

  // Sanity check: NS arrangement.transaction_price should match
  // Σ element.allocated_amount. Surface a warning on mismatch (within
  // a penny tolerance to absorb rounding).
  const sumAllocated = arrangement.elements.reduce(
    (acc, e) => acc + e.allocated_amount,
    0
  );
  if (Math.abs(arrangement.transaction_price - sumAllocated) > 0.01) {
    allWarnings.push(
      `Arrangement ${arrangement.tranid}: transaction_price (${arrangement.transaction_price.toFixed(2)}) does not match Σ allocated_amount (${sumAllocated.toFixed(2)}). NS data may be inconsistent.`
    );
  }

  const contract: MappedRevenueContract = {
    code: `NS-RA-${arrangement.tranid}`,
    description: `NetSuite revenue arrangement ${arrangement.tranid} for ${arrangement.customer.name ?? arrangement.customer.internalid}`,
    nsCustomerInternalId: arrangement.customer.internalid,
    nsCustomerName: arrangement.customer.name,
    contractStartDate: arrangement.arrangement_date,
    totalContractValue: arrangement.transaction_price,
    currencyId: arrangement.currency,
    sourceSystem: "netsuite",
    sourceRecordType: "RevenueArrangement",
    sourceRecordId: arrangement.internalid,
    sourcePayload: arrangement,
    mappingVersion: NS_REVENUE_MAPPING_VERSION,
  };

  return { contract, obligations, warnings: allWarnings };
}
