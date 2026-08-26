import assert from "node:assert/strict";
import test from "node:test";
import { discoverOpenAICompatibleModels, fingerprintEndpoint } from "../src/discovery/openai-compatible.ts";

// ---------- sanitizeUnknownValue: input-boundary redaction of untrusted remote JSON ----------

import { clearSecrets, registerResolvedSecret, sanitizeUnknownValue } from "../src/security.ts";

const SECRET_A = "arbitrary-secret-value-XYZ123456";
const SECRET_B = "another-secret-value-ABCD987654";

test("sanitizeUnknownValue redacts nested remote JSON strings recursively", () => {
  clearSecrets();
  registerResolvedSecret(SECRET_A);
  try {
    const value = sanitizeUnknownValue({
      id: `model-${SECRET_A}`,
      owned_by: `owner-${SECRET_A}`,
      capabilities: {
        echo: SECRET_A,
        nested: { again: SECRET_A },
        list: [SECRET_A, "plain-item"],
      },
      count: 3,
      flag: true,
      nothing: null,
    });
    const json = JSON.stringify(value);
    assert.ok(!json.includes(SECRET_A), "no secret may survive anywhere in the tree");
    assert.ok(json.includes("[REDACTED]"));
    assert.ok((value as any).id.includes("[REDACTED]"));
    assert.ok((value as any).owned_by.includes("[REDACTED]"));
    assert.ok((value as any).capabilities.echo.includes("[REDACTED]"));
    assert.ok((value as any).capabilities.nested.again.includes("[REDACTED]"));
    assert.ok((value as any).capabilities.list[0].includes("[REDACTED]"));
    assert.equal((value as any).capabilities.list[1], "plain-item", "non-secret strings keep their shape");
    assert.equal((value as any).count, 3, "numbers unchanged");
    assert.equal((value as any).flag, true, "booleans unchanged");
    assert.equal((value as any).nothing, null, "null unchanged");
  } finally {
    clearSecrets();
  }
});

test("sanitizeUnknownValue redacts multiple distinct secrets at once", () => {
  clearSecrets();
  registerResolvedSecret(SECRET_A);
  registerResolvedSecret(SECRET_B);
  try {
    const value = sanitizeUnknownValue({ first: SECRET_A, second: SECRET_B, combined: `${SECRET_A}-${SECRET_B}` });
    const json = JSON.stringify(value);
    assert.ok(!json.includes(SECRET_A));
    assert.ok(!json.includes(SECRET_B));
    assert.ok((value as any).first.includes("[REDACTED]"));
    assert.ok((value as any).second.includes("[REDACTED]"));
    assert.ok((value as any).combined.includes("[REDACTED]"));
  } finally {
    clearSecrets();
  }
});

test("sanitizeUnknownValue is prototype-safe for __proto__ and constructor keys", () => {
  clearSecrets();
  try {
    // JSON.parse (not an object literal) produces genuine own "__proto__" keys.
    const hostile = JSON.parse(`{"__proto__": "${SECRET_A}", "constructor": {"polluted": "${SECRET_B}"}}`);
    const value = sanitizeUnknownValue(hostile) as any;
    assert.equal(Object.getPrototypeOf(value), Object.prototype, "the result's prototype must stay untouched");
    assert.equal(({} as any).polluted, undefined, "Object.prototype must not be polluted");
    assert.ok(Object.prototype.hasOwnProperty.call(value, "__proto__"), "__proto__ becomes a plain own data key");
    assert.ok(Object.prototype.hasOwnProperty.call(value, "constructor"));
  } finally {
    clearSecrets();
  }
});

test("sanitizeUnknownValue leaves scalars unchanged", () => {
  clearSecrets();
  registerResolvedSecret(SECRET_A);
  try {
    assert.equal(sanitizeUnknownValue(42), 42);
    assert.equal(sanitizeUnknownValue(true), true);
    assert.equal(sanitizeUnknownValue(null), null);
    assert.equal(sanitizeUnknownValue("plain"), "plain");
    assert.equal(sanitizeUnknownValue([1, 2, 3])[2], 3);
  } finally {
    clearSecrets();
  }
});

test("discoverOpenAICompatibleModels sanitizes malicious /models metadata at the input boundary", async () => {
  clearSecrets();
  registerResolvedSecret(SECRET_A);
  try {
    const models = await discoverOpenAICompatibleModels({
      baseUrl: "https://example.invalid/v1",
      apiKey: SECRET_A,
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{
          id: `model-${SECRET_A}`,
          owned_by: `owner-${SECRET_A}`,
          capabilities: { echo: SECRET_A, nested: { value: SECRET_A } },
        }],
      }), { status: 200 }),
    });
    assert.equal(models.length, 1);
    const json = JSON.stringify(models);
    assert.ok(!json.includes(SECRET_A), "model metadata must never carry the secret");
    assert.ok(models[0].id.includes("[REDACTED]"));
    assert.ok(models[0].ownedBy!.includes("[REDACTED]"));
    assert.ok((models[0].capabilities as any).echo.includes("[REDACTED]"));
    assert.ok((models[0].capabilities as any).nested.value.includes("[REDACTED]"));
  } finally {
    clearSecrets();
  }
});

test("discovers literal model ids and selected metadata", async () => {
  const models = await discoverOpenAICompatibleModels({
    baseUrl: "https://user:password@example.invalid/v1?token=secret",
    apiKey: "secret-key",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://example.invalid/v1/models");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-key");
      return new Response(JSON.stringify({
        data: [
          { id: "alias/model-latest", owned_by: "gateway", capabilities: { reasoning: true } },
          { invalid: true },
        ],
      }), { status: 200 });
    },
  });
  assert.deepEqual(models, [{ id: "alias/model-latest", ownedBy: "gateway", capabilities: { reasoning: true } }]);
  assert.equal(fingerprintEndpoint("https://user:password@example.invalid/v1?token=secret"), "https://example.invalid/v1");
});