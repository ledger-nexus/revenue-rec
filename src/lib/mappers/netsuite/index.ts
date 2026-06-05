// Public entry points for the NetSuite revenue-arrangement mapper.
//
// Usage (after the orchestrator lands in a follow-up PR):
//
//   import { importFromNsRevenue } from "@/lib/mappers/netsuite";
//
// For now: pure mappers + types are exported so tests + downstream
// callers can compose them directly.

export {
  // Mappers
  mapElement,
  mapArrangement,
  mapRecognitionTemplate,
  mapAllocationMethod,
  mapFairValueMethod,
  NS_REVENUE_MAPPING_VERSION,
  // Output shapes
  type MappedRevenueContract,
  type MappedPerformanceObligation,
  type MappedArrangement,
  type RecognitionPattern,
  type AllocationMethod,
  type FairValueMethod,
} from "./mappers";

export type {
  NsRef,
  NsRecognitionTemplate,
  NsRevenueArrangement,
  NsArrangementElement,
  NsRevenueArrangementExport,
} from "./types";
