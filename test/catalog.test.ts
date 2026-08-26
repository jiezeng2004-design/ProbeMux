import assert from "node:assert/strict";
import test from "node:test";
import { observationFromModelsDev } from "../src/catalog/models-dev.ts";

test("maps models.dev reasoning options into a candidate observation", () => {
  const catalog = {
    deepseek: {
      models: {
        "deepseek-v4-pro": {
          reasoning: true,
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["low", "high", "max"] },
          ],
        },
      },
    },
  };
  const observation = observationFromModelsDev(catalog, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    protocol: "openai-chat-completions",
    observedAt: "2026-08-25T00:00:00.000Z",
  });
  assert.equal(observation?.reasoning.state, "supported");
  assert.deepEqual(observation?.reasoning.effortLevels?.map((item) => item.canonical), ["low", "high", "max"]);
  assert.equal(observation?.reasoning.toggle?.supported, true);
  assert.equal(observation?.reasoning.wire?.effortPath, "reasoning_effort");
});

test("missing reasoning metadata stays unknown instead of becoming unsupported", () => {
  const observation = observationFromModelsDev({
    gateway: { models: { model: { name: "Model" } } },
  }, {
    providerId: "gateway",
    modelId: "model",
    protocol: "openai-responses",
    observedAt: "2026-08-25T00:00:00.000Z",
  });
  assert.equal(observation?.reasoning.state, "unknown");
});
