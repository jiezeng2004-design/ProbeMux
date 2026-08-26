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

test("Probe Engine verifies protocols, reasoning dialects, roles, and tool calling", async () => {
  let calls = 0;
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://user:password@example.invalid/v1?token=secret",
    providerId: "fixture",
    modelId: "model",
    observedAt: "2026-08-25T00:00:00.000Z",
    fetchImpl: async (input, init) => {
      calls += 1;
      assert.doesNotMatch(String(input), /password|secret/);
      const protocol = String(input).endsWith("/responses") ? "responses" : "chat-completions";
      const body = bodyOf(init);
      if (Array.isArray(body.tools)) return valid(protocol, true);
      if (hasRole(body, "system") || hasRole(body, "developer")) return valid(protocol);
      const nestedReasoning = typeof body.reasoning === "object" && body.reasoning !== null;
      const topReasoning = body.reasoning_effort === "__probemux_invalid__";
      if (nestedReasoning || topReasoning) {
        const supported = (protocol === "responses" && nestedReasoning) || (protocol === "chat-completions" && topReasoning);
        return new Response(JSON.stringify({ error: { message: supported
          ? "Invalid value. Supported values are: none, minimal, low, medium, high, xhigh, max."
          : "Unknown parameter: reasoning effort dialect." } }), { status: 400 });
      }
      return valid(protocol);
    },
  });

  assert.equal(calls, 12);
  assert.equal(manifest.protocols.responses.status, "VERIFIED");
  assert.equal(manifest.protocols["chat-completions"].status, "VERIFIED");
  assert.equal(manifest.reasoning.status, "VERIFIED");
  assert.deepEqual(manifest.reasoning.levels.map((item) => item.canonical), [
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
  assert.equal(manifest.messageRoles.developer.status, "VERIFIED");
  assert.equal(manifest.toolCalling.status, "VERIFIED");
  assert.equal(manifest.identity.endpointFingerprint, "https://example.invalid/v1");
  assert.doesNotMatch(JSON.stringify(manifest), /password|secret/);
  assert.deepEqual(validateCapabilityManifest(manifest), { valid: true, errors: [] });
});

test("Probe Engine refuses network requests without explicit activation", async () => {
  let called = false;
  await assert.rejects(() => probeEndpointCapabilities({
    active: false,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    fetchImpl: async () => {
      called = true;
      return new Response();
    },
  }), /Active probing is disabled/);
  assert.equal(called, false);
});

test("HTTP 200 without a protocol response shape is not VERIFIED", async () => {
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: "https://example.invalid/v1",
    providerId: "fixture",
    modelId: "model",
    maxRequests: 2,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });
  assert.equal(manifest.protocols.responses.status, "UNKNOWN");
  assert.equal(manifest.protocols["chat-completions"].status, "UNKNOWN");
  assert.equal(manifest.reasoning.status, "UNKNOWN");
});
