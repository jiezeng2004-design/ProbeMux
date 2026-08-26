import assert from "node:assert/strict";
import test from "node:test";
import { renderManifest } from "../src/adapters/index.ts";
import { verifiedManifest } from "./fixtures.ts";

test("Codex emits a Responses provider and omits max without downshifting", () => {
  const result = renderManifest(verifiedManifest(), "codex", { defaultEffort: "max" });
  assert.match(result.content, /wire_api = "responses"/);
  assert.doesNotMatch(result.content, /model_reasoning_effort/);
  assert.ok(result.omittedLevels.includes("max"));
  assert.ok(result.warnings.some((warning) => warning.includes("without downshifting")));
  assert.equal(result.safety, "VERIFIED");
});

test("OpenCode selects the Responses SDK and renders verified variants", () => {
  const result = renderManifest(verifiedManifest(), "opencode", { defaultEffort: "high" });
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.provider["fixture-gateway"].npm, "@ai-sdk/openai");
  assert.equal(parsed.provider["fixture-gateway"].models["fixture-reasoning-model"].variants.high.reasoningEffort, "high");
  assert.equal(parsed.provider["fixture-gateway"].models["fixture-reasoning-model"].options.reasoningEffort, "high");
  assert.equal(result.safety, "VERIFIED");
});

test("DSH preserves canonical-to-wire mappings", () => {
  const result = renderManifest(verifiedManifest(), "dsh", { defaultEffort: "high" });
  assert.match(result.content, /reasoningEfforts:/);
  assert.match(result.content, /off: "none"/);
  assert.match(result.content, /max: "max"/);
  assert.match(result.content, /agent-default-model:/);
  assert.match(result.content, /reasoningEffort: "high"/);
});

test("unknown reasoning is not projected", () => {
  const manifest = verifiedManifest();
  manifest.reasoning.dialects = manifest.reasoning.dialects.map((item) => ({ ...item, status: "UNKNOWN", levels: [] }));
  const result = renderManifest(manifest, "opencode");
  const parsed = JSON.parse(result.content);
  assert.deepEqual(parsed.provider["fixture-gateway"].models["fixture-reasoning-model"].variants, {});
  assert.ok(result.warnings.some((warning) => warning.includes("UNKNOWN")));
});
