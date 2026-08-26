import assert from "node:assert/strict";
import test from "node:test";
import { extractAllowedEfforts, probeOpenAIReasoning } from "../src/probes/openai-reasoning.ts";

test("extracts allowed efforts from provider validation messages", () => {
  assert.deepEqual(
    extractAllowedEfforts("Invalid value. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', and 'xhigh'."),
    ["none", "minimal", "low", "medium", "high", "xhigh"],
  );
});

test("refuses network work unless active probing is explicit", async () => {
  let called = false;
  await assert.rejects(
    () => probeOpenAIReasoning({
      active: false,
      baseUrl: "https://example.invalid/v1",
      modelId: "model",
      protocol: "responses",
      fetchImpl: async () => {
        called = true;
        return new Response();
      },
    }),
    /Active probing is disabled/,
  );
  assert.equal(called, false);
});

test("classifies a 400 allowed-values response as enumerated", async () => {
  const result = await probeOpenAIReasoning({
    active: true,
    baseUrl: "https://example.invalid/v1",
    modelId: "model",
    protocol: "responses",
    observedAt: "2026-08-25T00:00:00.000Z",
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "Invalid effort. Supported values are: low, medium, high, xhigh, max." },
    }), { status: 400 }),
  });
  assert.equal(result.classification, "enumerated");
  assert.deepEqual(result.supportedEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(result.observation?.reasoning.state, "supported");
});

test("a 2xx without reasoning metadata remains unverified", async () => {
  const result = await probeOpenAIReasoning({
    active: true,
    baseUrl: "https://example.invalid/v1",
    modelId: "model",
    protocol: "chat-completions",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "X" } }],
      usage: { completion_tokens: 1 },
    }), { status: 200 }),
  });
  assert.equal(result.classification, "accepted-but-unverified");
  assert.equal(result.observation?.reasoning.state, "accepted-but-unverified");
});

test("auth failures do not become capability conclusions", async () => {
  const result = await probeOpenAIReasoning({
    active: true,
    baseUrl: "https://example.invalid/v1",
    modelId: "model",
    protocol: "responses",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }),
  });
  assert.equal(result.classification, "auth-error");
  assert.equal(result.observation, undefined);
});
