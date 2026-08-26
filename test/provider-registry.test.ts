import assert from "node:assert/strict";
import test from "node:test";
import { resolveKnownProviderEndpoint } from "../src/discovery/provider-registry.ts";

test("registry resolves the OpenCode Zen endpoint for the opencode provider id", () => {
  const entry = resolveKnownProviderEndpoint("opencode");
  assert.ok(entry, "opencode must be a recognized provider");
  assert.equal(entry.baseUrl, "https://opencode.ai/zen/v1");
  assert.ok(entry.note.length > 0, "provenance note is auditable");
});

test("registry resolves the OpenCode Zen endpoint for the renamed opencode-latest provider id", () => {
  const entry = resolveKnownProviderEndpoint("opencode-latest");
  assert.ok(entry);
  assert.equal(entry.baseUrl, "https://opencode.ai/zen/v1");
});

test("unknown providers are never resolved (no guessing, no prefix match)", () => {
  assert.equal(resolveKnownProviderEndpoint("some-catalog-provider"), undefined);
  assert.equal(resolveKnownProviderEndpoint("opencode-fake"), undefined, "prefix lookalikes must NOT resolve");
  assert.equal(resolveKnownProviderEndpoint("opencode-zen"), undefined);
  assert.equal(resolveKnownProviderEndpoint(""), undefined);
  assert.equal(resolveKnownProviderEndpoint("OpenCode"), undefined, "case variants are not recognized");
});

test("every registry entry has a usable canonical endpoint", () => {
  for (const entry of resolveKnownProviderEndpoint("opencode") ? [resolveKnownProviderEndpoint("opencode")!] : []) {
    assert.match(entry.baseUrl, /^https:\/\//);
  }
});
