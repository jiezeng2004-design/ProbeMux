import assert from "node:assert/strict";
import test from "node:test";
import { validateCapabilityManifest } from "../src/domain/manifest.ts";
import { probeEndpointCapabilities } from "../src/probes/probe-engine.ts";

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function hasRole(body: Record<string, unknown>, role: string): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  return messages.some((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).role === role);
}

function valid(protocol: "responses" | "chat-completions", tool = false): Response {
  if (protocol === "responses") {
    return new Response(JSON.stringify({
      object: "response",
      output: tool
        ? [{ type: "function_call", name: "probemux_echo", arguments: "{\"value\":\"X\"}" }]
        : [{ type: "message", content: [] }],
    }), { status: 200 });
  }
  return new Response(JSON.stringify({
    choices: [{ message: tool
      ? { tool_calls: [{ type: "function", function: { name: "probemux_echo", arguments: "{\"value\":\"X\"}" } }] }
      : { content: "X" } }],
  }), { status: 200 });
}

const RESPONSES_404 = () => new Response(JSON.stringify({ error: { message: "endpoint not found: /v1/responses" } }), { status: 404 });

// ---------- Fix 1: bounded adaptive max_tokens retry ----------

test("explicit token-lower-bound 400 is retried once with a raised minimum token limit", async () => {
  const bodies: Record<string, unknown>[] = [];
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    observedAt: "2026-08-25T00:00:00.000Z",
    fetchImpl: async (input, init) => {
      const body = bodyOf(init);
      bodies.push(body);
      if (typeof body.max_tokens === "number") {
        if (body.max_tokens <= 2) {
          return new Response(JSON.stringify({ error: { message: "max_tokens must be greater than 2" } }), { status: 400 });
        }
        return valid("chat-completions");
      }
      return RESPONSES_404();
    },
  });
  const retried = bodies.find((body) => typeof body.max_tokens === "number" && body.max_tokens !== 1);
  assert.ok(retried, "a retried body with a raised max_tokens must exist");
  assert.ok(Number(retried.max_tokens) >= 3 && Number(retried.max_tokens) <= 1024, "raised limit is the minimum safe value");
  assert.equal(manifest.protocols["chat-completions"].status, "VERIFIED", "the retried baseline verified the protocol");
  assert.ok(
    manifest.evidence.some((item) => item.detail.includes("retried once after an explicit token-lower-bound error")),
    "evidence records the bounded retry",
  );
  assert.deepEqual(validateCapabilityManifest(manifest), { valid: true, errors: [] });
});

test("token-lower-bound retry never exceeds the per-model request budget", async () => {
  let calls = 0;
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    maxRequests: 2,
    fetchImpl: async (_input, init) => {
      calls += 1;
      const body = bodyOf(init);
      if (typeof body.max_tokens === "number") {
        return new Response(JSON.stringify({ error: { message: "max_tokens must be greater than 2" } }), { status: 400 });
      }
      return RESPONSES_404();
    },
  });
  // budget 2: responses baseline (1) + chat baseline (1); the chat retry would be the 3rd request -> refused.
  assert.equal(calls, 2);
  assert.equal(manifest.protocols.responses.status, "UNSUPPORTED");
  assert.equal(manifest.protocols["chat-completions"].status, "UNKNOWN", "no retry beyond the budget");
  assert.equal(manifest.reasoning.status, "UNKNOWN");
});

test("non-token 400 errors are never retried", async () => {
  let calls = 0;
  await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    maxRequests: 4,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "unknown model: model" } }), { status: 400 });
    },
  });
  assert.equal(calls, 2, "baselines only: a generic 400 is never retried");
});

// ---------- Fix 3: valid/invalid effort contrast (Kimi-style discrimination) ----------

test("accepted sentinel + valid-effort contrast with reasoning signal -> LIKELY level, never VERIFIED", async () => {
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    observedAt: "2026-08-25T00:00:00.000Z",
    fetchImpl: async (input, init) => {
      const body = bodyOf(init);
      if (String(input).endsWith("/responses")) return RESPONSES_404();
      if (body.reasoning_effort !== undefined) {
        if (body.reasoning_effort === "__probemux_invalid__") {
          return new Response(JSON.stringify({ choices: [{ message: { content: "X" } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "X", reasoning_content: "thinking" } }],
          usage: { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } },
        }), { status: 200 });
      }
      if (body.reasoning?.effort !== undefined) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: reasoning effort dialect." } }), { status: 400 });
      }
      if (Array.isArray(body.tools)) return valid("chat-completions", true);
      if (hasRole(body, "system") || hasRole(body, "developer")) return valid("chat-completions");
      return valid("chat-completions");
    },
  });
  const dialect = manifest.reasoning.dialects.find((d) => d.protocol === "chat-completions" && d.parameterPath === "reasoning_effort");
  assert.ok(dialect, "chat reasoning_effort dialect probed");
  assert.equal(dialect.status, "LIKELY", "no server-side enumeration -> stays LIKELY");
  assert.deepEqual(dialect.levels.map((l) => l.canonical), ["high"]);
  assert.equal(dialect.levels[0].status, "LIKELY", "the probed level is LIKELY, never VERIFIED");
  assert.ok(manifest.evidence.some((item) => item.outcome === "contrast-valid-effort"), "contrast probe recorded as evidence");
  assert.equal(manifest.reasoning.status, "LIKELY");
  assert.deepEqual(validateCapabilityManifest(manifest), { valid: true, errors: [] });
});

test("accepted sentinel + contrast rejected with enumeration -> VERIFIED levels from the server validator", async () => {
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    observedAt: "2026-08-25T00:00:00.000Z",
    fetchImpl: async (input, init) => {
      const body = bodyOf(init);
      if (String(input).endsWith("/responses")) return RESPONSES_404();
      if (body.reasoning_effort !== undefined) {
        if (body.reasoning_effort === "__probemux_invalid__") {
          return new Response(JSON.stringify({ choices: [{ message: { content: "X" } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { message: "reasoning_effort must be one of: low, medium, high" } }), { status: 400 });
      }
      if (body.reasoning?.effort !== undefined) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: reasoning effort dialect." } }), { status: 400 });
      }
      if (Array.isArray(body.tools)) return valid("chat-completions", true);
      if (hasRole(body, "system") || hasRole(body, "developer")) return valid("chat-completions");
      return valid("chat-completions");
    },
  });
  const dialect = manifest.reasoning.dialects.find((d) => d.protocol === "chat-completions" && d.parameterPath === "reasoning_effort");
  assert.ok(dialect);
  assert.equal(dialect.status, "VERIFIED");
  assert.deepEqual(dialect.levels.map((l) => l.canonical), ["low", "medium", "high"]);
  assert.ok(dialect.levels.every((l) => l.status === "VERIFIED"));
  assert.equal(manifest.reasoning.status, "VERIFIED");
});

test("accepted sentinel + contrast accepted without signal -> stays UNKNOWN", async () => {
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    observedAt: "2026-08-25T00:00:00.000Z",
    fetchImpl: async (input, init) => {
      const body = bodyOf(init);
      if (String(input).endsWith("/responses")) return RESPONSES_404();
      if (body.reasoning_effort !== undefined) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "X" } }] }), { status: 200 });
      }
      if (body.reasoning?.effort !== undefined) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: reasoning effort dialect." } }), { status: 400 });
      }
      if (Array.isArray(body.tools)) return valid("chat-completions", true);
      if (hasRole(body, "system") || hasRole(body, "developer")) return valid("chat-completions");
      return valid("chat-completions");
    },
  });
  const dialect = manifest.reasoning.dialects.find((d) => d.protocol === "chat-completions" && d.parameterPath === "reasoning_effort");
  assert.ok(dialect);
  assert.equal(dialect.status, "UNKNOWN", "no validation, no reasoning signal -> UNKNOWN, never VERIFIED");
  assert.equal(dialect.levels.length, 0);
  assert.equal(manifest.reasoning.status, "UNKNOWN");
});
