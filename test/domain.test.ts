import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfile } from "../src/domain/resolve.ts";
import type { CapabilityObservation } from "../src/domain/types.ts";

const base = {
  source: "fixture",
  observedAt: "2026-08-25T00:00:00.000Z",
  confidence: 0.8,
  claim: "fixture",
  outcome: "declared" as const,
};

test("active probe outranks models.dev and preserves a conflict", () => {
  const observations: CapabilityObservation[] = [
    {
      ...base,
      id: "catalog",
      kind: "models-dev",
      reasoning: {
        state: "supported",
        effortLevels: [{ canonical: "high", wire: "high" }],
      },
    },
    {
      ...base,
      id: "probe",
      kind: "active-probe",
      outcome: "rejected",
      reasoning: { state: "unsupported" },
    },
  ];

  const profile = resolveProfile(
    { providerId: "gateway", modelId: "model", protocol: "openai-responses" },
    observations,
    { resolvedAt: "2026-08-25T01:00:00.000Z" },
  );
  assert.equal(profile.reasoning.state, "unsupported");
  assert.ok(profile.conflicts.some((conflict) => conflict.field === "reasoning.state"));
});

test("user override wins a wire-value conflict", () => {
  const observations: CapabilityObservation[] = [
    {
      ...base,
      id: "probe",
      kind: "active-probe",
      outcome: "rejected-enumerated",
      reasoning: {
        state: "supported",
        effortLevels: [{ canonical: "xhigh", wire: "max" }],
      },
    },
    {
      ...base,
      id: "override",
      kind: "user-override",
      outcome: "manual",
      reasoning: {
        effortLevels: [{ canonical: "xhigh", wire: "ultra" }],
      },
    },
  ];

  const profile = resolveProfile(
    { providerId: "gateway", modelId: "model", protocol: "openai-chat-completions" },
    observations,
  );
  assert.equal(profile.reasoning.effort?.levels[0]?.wire, "ultra");
  assert.ok(profile.conflicts.some((conflict) => conflict.field === "reasoning.effort.xhigh"));
});

test("unknown never overwrites a known state", () => {
  const observations: CapabilityObservation[] = [
    {
      ...base,
      id: "heuristic",
      kind: "heuristic",
      reasoning: { state: "unknown" },
    },
    {
      ...base,
      id: "official",
      kind: "provider-official",
      reasoning: { state: "supported" },
    },
  ];
  const profile = resolveProfile(
    { providerId: "provider", modelId: "model", protocol: "anthropic-messages" },
    observations,
  );
  assert.equal(profile.reasoning.state, "supported");
});
