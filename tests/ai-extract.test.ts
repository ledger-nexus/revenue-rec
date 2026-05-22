// AI extractor unit tests. Mocks the Anthropic SDK via setClientForTesting
// so no live API call. Verifies:
//   - messages.parse round-trip returns typed performance obligations
//   - cache_control wired on the system prefix
//   - User message carries the contract text
//   - Empty contract text errors out
//   - Missing parsed_output errors out
//   - Cache hit/miss telemetry surfaces

import { describe, it, expect, beforeEach } from "vitest";
import {
  extractContract,
  setClientForTesting,
  AI_EXTRACT_MODEL,
} from "../src/lib/extraction/ai-extract";

const sampleContract = `MSA effective 2026-01-01.
Customer: Initech Industries.
Subscription: $5,000/mo, 12 months.
Implementation: $10,000 one-time.
Total: $60,000.`;

const samplePayload = {
  contractCode: "INITECH-2026-01",
  customerName: "Initech Industries",
  contractDescription: "12-month subscription + implementation",
  contractStartDate: "2026-01-01",
  contractEndDate: "2026-12-31",
  totalContractValue: 60000,
  currencyCode: "USD",
  performanceObligations: [
    {
      sequenceNo: 1,
      description: "Northwind Cloud subscription",
      ssp: 60000,
      recognitionPattern: "OVER_TIME_STRAIGHT",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      revenueAccountCode: "4000",
      deferredAccountCode: "2200",
      rationale: "Ratable SaaS access. SSP from list price.",
    },
    {
      sequenceNo: 2,
      description: "Implementation services",
      ssp: 10000,
      recognitionPattern: "POINT_IN_TIME",
      startDate: "2026-03-31",
      endDate: null,
      revenueAccountCode: "4010",
      deferredAccountCode: "2200",
      rationale: "One-time deliverable; distinct from subscription.",
    },
  ],
  notes: "Customer received a $10K discount on implementation.",
};

function makeMockClient(
  parsedOutput: unknown,
  capture: { lastArgs?: Record<string, unknown> } = {}
) {
  return {
    messages: {
      parse: async (args: Record<string, unknown>) => {
        capture.lastArgs = args;
        return {
          content: [{ type: "tool_use", input: parsedOutput }],
          parsed_output: parsedOutput,
          stop_reason: "end_turn",
          usage: {
            input_tokens: 2500,
            output_tokens: 800,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 2000,
          },
        };
      },
      // create is also on the surface; we don't use it here but keep
      // it present so the cast survives.
      create: async () => {
        throw new Error("create() should not be called by extractContract");
      },
    },
  } as unknown as Parameters<typeof setClientForTesting>[0];
}

beforeEach(() => {
  setClientForTesting(null);
});

describe("extractContract", () => {
  it("parses a valid model response into typed POs", async () => {
    setClientForTesting(makeMockClient(samplePayload));
    const r = await extractContract(sampleContract);
    expect(r.modelName).toBe(AI_EXTRACT_MODEL);
    expect(r.extracted.performanceObligations).toHaveLength(2);
    expect(r.extracted.performanceObligations[0].recognitionPattern).toBe(
      "OVER_TIME_STRAIGHT"
    );
    expect(r.extracted.totalContractValue).toBe(60000);
  });

  it("surfaces cache telemetry from the response usage", async () => {
    setClientForTesting(makeMockClient(samplePayload));
    const r = await extractContract(sampleContract);
    expect(r.cacheReadTokens).toBe(2000);
    expect(r.cacheCreationTokens).toBe(0);
    expect(r.promptTokens).toBe(2500);
  });

  it("sends a cache_control breakpoint on the system prompt", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(samplePayload, capture));
    await extractContract(sampleContract);
    const system = capture.lastArgs?.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("includes the contract text in the user message", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(samplePayload, capture));
    await extractContract(sampleContract);
    const messages = capture.lastArgs?.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("Initech Industries");
    expect(messages[0].content).toContain("60,000");
    expect(messages[0].content).toContain("--- CONTRACT BEGIN ---");
  });

  it("uses Claude Opus 4.7 (not Haiku)", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(samplePayload, capture));
    await extractContract(sampleContract);
    expect(capture.lastArgs?.model).toBe("claude-opus-4-7");
  });

  it("rejects empty contract text", async () => {
    await expect(extractContract("")).rejects.toThrow(/empty/);
    await expect(extractContract("   \n\n  ")).rejects.toThrow(/empty/);
  });

  it("throws when the model returns no parsed_output", async () => {
    setClientForTesting({
      messages: {
        parse: async () => ({
          content: [{ type: "text", text: "I cannot" }],
          parsed_output: null,
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      },
    } as unknown as Parameters<typeof setClientForTesting>[0]);
    await expect(extractContract(sampleContract)).rejects.toThrow(/no parsed output/);
  });
});
