// Revenue-rec-side attribution for the portfolio-wide DSR export bundle.
//
// Privacy TSC. Implements the contract described at
// `docs/policies/data-subject-requests.md` → "Right of access".
//
// This function is INVOKED FROM ledger-core's `buildUserDataExport()`
// when a subject's Article 15 request is being assembled. Revenue-rec
// is the canonical home for ASC 606 contract + revenue-recognition
// data; this helper returns **attribution counts only**, never the
// underlying tenant data.
//
// Why counts and not contents:
//   Revenue contracts + performance obligations + contract documents
//   are TENANT data, possibly containing counterparty PII (signatories,
//   contact emails). The subject's relationship is "who uploaded the
//   contract" or "who approved the recognition schedule" — an
//   attribution edge, not personal data. GDPR Art. 15 grants the
//   subject access to personal data ABOUT THEM, not to the tenant's
//   contracts.
//
// Counterparty PII (signatories) is the TENANT's data; we are the
// processor, not the controller. A counterparty asking for erasure
// must be routed to the tenant (per the DSR doc's "Edge cases"
// section).
//
// Why this is a typed stub today:
//   The actual implementation is gated on the first real DSR arriving.

import type { PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across revenue-rec's tables.
 *
 * Stable schema — once shipped, ledger-core's export bundle will
 * persist these counts.
 */
export interface RevenueRecAttribution {
  /**
   * Revenue contracts the subject (as ADMIN+) created. Counts the
   * `RevenueContract` rows whose attribution chain ends at this
   * userId. Does NOT include contract descriptions (encrypted at
   * rest + preserved on erasure).
   */
  revenueContractsCreated: number;
  /**
   * Contract documents the subject uploaded. Counts the
   * `ContractDocument` rows attributable to the user.
   * IMPORTANT: rawText is the highest-sensitivity column in the
   * portfolio (counterparty PII; signatories). NOT included in
   * the export.
   */
  contractDocumentsUploaded: number;
  /**
   * Recognition schedules the subject approved. Counts
   * `RecognitionSchedule` rows attributable to the user.
   */
  recognitionSchedulesApproved: number;
  /**
   * AI extraction suggestions the subject accepted or rejected.
   * Counts `AiExtractionSuggestion` rows attributable to the user.
   * Suggestion bodies are encrypted at rest + preserved under the
   * 7-year AI-audit-trail retention window.
   */
  aiExtractionsAccepted: number;
  aiExtractionsRejected: number;
  /** When the count snapshot was taken. */
  snapshotAt: string;
}

/**
 * Assemble revenue-rec's attribution contribution to the portfolio-
 * wide DSR export bundle.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * Called via HTTP at a future `/api/internal/dsr/attribution` endpoint.
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * @throws NotImplementedError — body not yet written. Triggered when
 *         the first real DSR arrives.
 */
export async function revenueRecAttribution(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: string
): Promise<RevenueRecAttribution> {
  throw new NotImplementedError(
    "revenueRecAttribution is a typed stub. See " +
      "docs/policies/data-subject-requests.md → \"Open items\" for " +
      "the implementation trigger."
  );
}

/**
 * Distinct error class so a real-DSR caller can catch this specifically
 * vs. an unexpected error (e.g., DB outage) and surface the right
 * message to the privacy lead.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
