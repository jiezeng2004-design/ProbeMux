import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import type { CapabilityManifest } from "../src/domain/manifest.ts";
import { getDshAdapterCapabilities, getDshDeploymentCapabilities } from "../src/integrations/dsh/capabilities.ts";
import { patchDshSettings } from "../src/integrations/dsh/patch.ts";
import type { DshTarget } from "../src/integrations/dsh/types.ts";
import { verifiedManifest } from "./fixtures.ts";

const SETTINGS_WITH_MODELS = 
  "# DSH settings\n" +
  "agent-default-model:\n" +
  "  provider: my-provider\n" +
  "  model: model-a\n" +
  "  reasoningEffort: high\n" +
  "\n" +
  "llm-pi-ai:\n" +
  "  providers:\n" +
  "    my-provider:\n" +
  "      displayName: My Provider\n" +
  "      baseURL: https://api.example.com/v1\n" +
  "      apiKeyEnv: MY_API_KEY\n" +
  "      api: openai-completions\n" +
  "      models:\n" +
  "        - id: model-a\n" +
  "        - id: model-b\n" +
  "\n" +
  "unrelated-section:\n" +
  "  keep: me\n" +
  "  nested:\n" +
  "    - a\n" +
  "    - b\n";

function target(overrides: Partial<DshTarget> = {}): DshTarget {
  return {
    home: "/tmp/dsh",
    settingsPath: "/tmp/dsh/settings.yaml",
    credentialsPath: "/tmp/dsh/.credentials.yaml",
    provider: "my-provider",
    model: "model-a",
    providerKind: "llm-pi-ai",
    source: "llm-pi-ai.providers.my-provider",
    baseUrl: "https://api.example.com/v1",
    protocolHint: "openai-completions",
    apiKeyEnv: "MY_API_KEY",
    credential: { ref: "MY_API_KEY", source: "unresolved", available: false },
    modelsState: "explicit",
    targetInModels: true,
    catalogEndpointUnresolved: false,
    ...overrides,
  };
}

function withChatLevels(manifest: CapabilityManifest, levels: CapabilityManifest["reasoning"]["dialects"][number]["levels"], status: string = "VERIFIED"): CapabilityManifest {
  const copy = structuredClone(manifest);
  const dialect = copy.reasoning.dialects.find((d) => d.protocol === "chat-completions");
  if (dialect) {
    dialect.status = status as CapabilityManifest["reasoning"]["levels"][number]["status"];
    dialect.levels = levels;
  }
  return copy;
}

function verifiedLevels(...canonical: string[]): CapabilityManifest["reasoning"]["dialects"][number]["levels"] {
  return canonical.map((name) => ({
    canonical: name as CapabilityManifest["reasoning"]["dialects"][number]["levels"][number]["canonical"],
    wireValue: name,
    status: "VERIFIED" as const,
    confidence: 0.98,
    evidenceIds: ["e1"],
  }));
}

test("merges verified reasoningEfforts into the target model only", () => {
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target(),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high")),
  });
  assert.equal(result.changed, true);
  assert.equal(result.writeTarget, "models");
  const parsed = parse(result.candidateText) as any;
  const models = parsed["llm-pi-ai"].providers["my-provider"].models;
  assert.deepEqual(models[0].reasoningEfforts, { low: "low", medium: "medium", high: "high" });
  assert.equal(models[0].id, "model-a");
  assert.equal(models[1].reasoningEfforts, undefined, "model-b must stay untouched");
  assert.equal(models[1].id, "model-b");
  assert.equal(parsed["llm-pi-ai"].providers["my-provider"].baseURL, "https://api.example.com/v1");
  assert.equal(parsed["llm-pi-ai"].providers["my-provider"].apiKeyEnv, "MY_API_KEY");
  assert.equal(parsed["llm-pi-ai"].providers["my-provider"].displayName, "My Provider");
  assert.deepEqual(parsed["unrelated-section"], { keep: "me", nested: ["a", "b"] });
  assert.equal(parsed["agent-default-model"].reasoningEffort, "high", "valid current default is kept");
  assert.ok(result.candidateText.includes("# DSH settings"), "comment preserved");
  assert.ok(result.changes.some((c) => c.includes("models[model-a]")) || result.changes.some((c) => c.includes("models[0]")));
});

test("catalog route uses modelOverrides and never adds a models list", () => {
  const settings = SETTINGS_WITH_MODELS.replace("      models:\n", "").replace("        - id: model-a\n", "").replace("        - id: model-b\n", "");
  const result = patchDshSettings({
    settingsText: settings,
    target: target({ modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
  });
  assert.equal(result.changed, true);
  assert.equal(result.writeTarget, "modelOverrides");
  const parsed = parse(result.candidateText) as any;
  const provider = parsed["llm-pi-ai"].providers["my-provider"];
  assert.deepEqual(provider.modelOverrides["model-a"].reasoningEfforts, { low: "low", high: "high" });
  assert.equal(provider.models, undefined, "must not add a models list to a catalog provider");
});

test("existing modelOverrides are merged, other models untouched", () => {
  const settings = SETTINGS_WITH_MODELS.replace(
    "        - id: model-b\n",
    "        - id: model-b\n" +
    "      modelOverrides:\n" +
    "        other-model:\n" +
    "          reasoningEfforts:\n" +
    "            high: high\n" +
    "          extra: keep-me\n",
  );
  const result = patchDshSettings({
    settingsText: settings,
    target: target({ model: "model-a", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
  });
  const parsed = parse(result.candidateText) as any;
  const overrides = parsed["llm-pi-ai"].providers["my-provider"].modelOverrides;
  assert.deepEqual(overrides["other-model"], { reasoningEfforts: { high: "high" }, extra: "keep-me" });
  assert.deepEqual(overrides["model-a"].reasoningEfforts, { low: "low", high: "high" });
});

test("model not listed in explicit models falls back to modelOverrides", () => {
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target({ model: "model-c", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("medium", "high")),
  });
  assert.equal(result.changed, true);
  assert.equal(result.writeTarget, "modelOverrides");
  const parsed = parse(result.candidateText) as any;
  assert.deepEqual(parsed["llm-pi-ai"].providers["my-provider"].modelOverrides["model-c"].reasoningEfforts, { medium: "medium", high: "high" });
  assert.equal(parsed["llm-pi-ai"].providers["my-provider"].models.length, 2, "models list untouched");
});

test("invalid current default effort is corrected to a verified high", () => {
  const settings = SETTINGS_WITH_MODELS.replace("  reasoningEffort: high\n", "  reasoningEffort: turbo\n");
  const result = patchDshSettings({
    settingsText: settings,
    target: target({ reasoningEffort: "turbo" }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
  });
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "high");
  assert.ok(result.changes.some((c) => c.includes("agent-default-model.reasoningEffort")));
});

test("valid current default effort is preserved", () => {
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target({ reasoningEffort: "low" }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high")),
  });
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "low");
});

test("explicit default effort not VERIFIED refuses to write", () => {
  assert.throws(() => patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target(),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low")),
    patchOptions: { defaultEffort: "max" },
  }), /Refusing to write default effort/);
});

test("explicit default effort VERIFIED is written", () => {
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target({ reasoningEffort: "medium" }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high")),
    patchOptions: { defaultEffort: "low" },
  });
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "low");
});

test("deepseek-official writes nothing and warns", () => {
  const settings = 
    "agent-default-model:\n" +
    "  provider: deepseek-official\n" +
    "  model: deepseek-chat\n" +
    "llm-deepseek:\n" +
    "  apiKeyEnv: DEEPSEEK_API_KEY\n";
  const result = patchDshSettings({
    settingsText: settings,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", modelsState: "catalog", targetInModels: false }),
    manifest: verifiedManifest(),
  });
  assert.equal(result.changed, false);
  assert.equal(result.writeTarget, "none");
  assert.ok(result.warnings.some((w) => w.includes("whitelist")));
});

test("LIKELY-only reasoning is never written as capability", () => {
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target(),
    manifest: withChatLevels(verifiedManifest(), [], "LIKELY"),
  });
  assert.equal(result.changed, false);
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["llm-pi-ai"].providers["my-provider"].models[0].reasoningEfforts, undefined);
  assert.equal(parsed["agent-default-model"].reasoningEffort, "high");
});

test("no VERIFIED protocol means no patch at all", () => {
  const manifest = structuredClone(verifiedManifest());
  manifest.protocols["chat-completions"].status = "UNKNOWN";
  manifest.protocols.responses.status = "UNKNOWN";
  const result = patchDshSettings({ settingsText: SETTINGS_WITH_MODELS, target: target(), manifest });
  assert.equal(result.changed, false);
  assert.ok(result.warnings.some((w) => w.includes("VERIFIED protocol")));
});

test("non-VERIFIED level entries are filtered out", () => {
  const levels = verifiedLevels("low", "high");
  levels.push({ canonical: "max", wireValue: "max", status: "UNKNOWN", confidence: 0.2, evidenceIds: [] });
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target(),
    manifest: withChatLevels(verifiedManifest(), levels),
  });
  const parsed = parse(result.candidateText) as any;
  const efforts = parsed["llm-pi-ai"].providers["my-provider"].models[0].reasoningEfforts;
  assert.equal(efforts.max, undefined, "UNKNOWN levels must never be written");
  assert.deepEqual(efforts, { low: "low", high: "high" });
});

test("none maps to the off label", () => {
  const result = patchDshSettings({
    settingsText: SETTINGS_WITH_MODELS,
    target: target({ reasoningEffort: "off" }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("none", "high")),
  });
  const parsed = parse(result.candidateText) as any;
  const efforts = parsed["llm-pi-ai"].providers["my-provider"].models[0].reasoningEfforts;
  assert.equal(efforts.off, "none", "none canonical maps to the off label");
  assert.equal(efforts.high, "high");
  assert.equal(parsed["agent-default-model"].reasoningEffort, "off");
});

test("CRLF line endings are preserved in the candidate", () => {
  const crlf = SETTINGS_WITH_MODELS.replace(/\n/g, "\r\n");
  const result = patchDshSettings({
    settingsText: crlf,
    target: target(),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
  });
  assert.ok(result.candidateText.includes("\r\n"));
  const withoutCrlf = result.candidateText.replace(/\r\n/g, "");
  assert.ok(!withoutCrlf.includes("\n"), "no bare LF-only lines");
});
// ---------- deepseek-official adapter capability intersection ----------

const DEEPSEEK_KNOWN = getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.1");

const DEEPSEEK_SETTINGS = 
  "# deepseek settings\n" +
  "agent-default-model:\n" +
  "  provider: deepseek-official\n" +
  "  model: deepseek-chat\n" +
  "  reasoningEffort: high\n" +
  "\n" +
  "llm-deepseek:\n" +
  "  apiKeyEnv: DEEPSEEK_API_KEY\n" +
  "  baseURL: https://api.deepseek.com\n";

test("deepseek-official known version: writable default preserved, no changes", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "high", modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high", "max")),
    patchOptions: { adapterCapabilities: DEEPSEEK_KNOWN },
  });
  assert.equal(result.changed, false, "high is writable, nothing to change");
});

test("deepseek-official known version: unwritable current default is corrected from the intersection", () => {
  const settings = DEEPSEEK_SETTINGS.replace("  reasoningEffort: high\n", "  reasoningEffort: low\n");
  const result = patchDshSettings({
    settingsText: settings,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "low", modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high", "max")),
    patchOptions: { adapterCapabilities: DEEPSEEK_KNOWN },
  });
  assert.equal(result.changed, true);
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "high");
  assert.ok(result.changes.some((c) => c.includes("agent-default-model.reasoningEffort")));
});

test("deepseek-official known version: explicit writable default is written", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "high", modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high", "max")),
    patchOptions: { adapterCapabilities: DEEPSEEK_KNOWN, defaultEffort: "max" },
  });
  assert.equal(result.changed, true);
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "max");
});

test("deepseek-official known version: explicit unwritable default refuses to write", () => {
  assert.throws(() => patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "high", modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high", "max")),
    patchOptions: { adapterCapabilities: DEEPSEEK_KNOWN, defaultEffort: "xhigh" },
  }), /Refusing to write default effort/);
});

test("deepseek-official known version: endpoint efforts outside the adapter whitelist are dropped", () => {
  const settings = DEEPSEEK_SETTINGS.replace("  reasoningEffort: high\n", "  reasoningEffort: low\n");
  const result = patchDshSettings({
    settingsText: settings,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "low", modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("medium", "xhigh")),
    patchOptions: { adapterCapabilities: DEEPSEEK_KNOWN },
  });
  // medium/xhigh are verified but not adapter-writable; intersection is empty -> nothing written
  assert.equal(result.changed, false);
});

test("deepseek-official unknown version: nothing is written even with verified efforts", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS,
    target: target({ providerKind: "deepseek-official", provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "high", modelsState: "catalog", targetInModels: false }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "medium", "high", "max")),
  });
  assert.equal(result.changed, false);
  assert.ok(result.warnings.some((w) => w.includes("whitelist")));
});

// ---------- deployment policy: llm-deepseek.thinking ----------

const DEEPSEEK_RC2 = getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2");

const DEEPSEEK_SETTINGS_DISABLED =
  "# deepseek settings\n" +
  "agent-default-model:\n" +
  "  provider: deepseek-official\n" +
  "  model: deepseek-chat\n" +
  "  reasoningEffort: high\n" +
  "\n" +
  "llm-deepseek:\n" +
  "  apiKeyEnv: DEEPSEEK_API_KEY\n" +
  "  baseURL: https://api.deepseek.com\n" +
  "  thinking: disabled\n" +
  "  maxTokens: 65536\n";

function deepseekTarget(reasoningEffort: string): DshTarget {
  return target({
    providerKind: "deepseek-official",
    provider: "deepseek-official",
    model: "deepseek-chat",
    reasoningEffort,
    modelsState: "catalog",
    targetInModels: false,
  });
}

test("thinking disabled: endpoint off/high/max -> current high is downgraded to off", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS_DISABLED,
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("off", "high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "disabled" }),
    },
  });
  assert.equal(result.changed, true);
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "off", "high is not writable when thinking is disabled");
  assert.ok(result.changes.some((c) => c.includes("agent-default-model.reasoningEffort")));
});

test("thinking disabled: endpoint without VERIFIED off leaves nothing writable and writes nothing", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS_DISABLED,
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "disabled" }),
    },
  });
  assert.equal(result.changed, false, "empty writable -> zero writes");
  assert.equal(result.writeTarget, "none");
  assert.ok(
    result.warnings.some((w) => w.includes("No writable reasoning effort remains after applying DSH deployment constraints.")),
    "clear deployment message expected",
  );
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "high", "settings stay untouched");
});

test("thinking disabled: current high is never preserved when deployment forbids it", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS_DISABLED,
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("off", "high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "disabled" }),
    },
  });
  const parsed = parse(result.candidateText) as any;
  assert.notEqual(parsed["agent-default-model"].reasoningEffort, "high", "high is not in the final writable set");
});

test("thinking disabled: unrelated llm-deepseek fields and comments are preserved", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS_DISABLED,
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("off", "high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "disabled" }),
    },
  });
  assert.ok(result.candidateText.includes("# deepseek settings"), "comment preserved");
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["llm-deepseek"].apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(parsed["llm-deepseek"].baseURL, "https://api.deepseek.com");
  assert.equal(parsed["llm-deepseek"].thinking, "disabled", "deployment policy itself is never rewritten");
  assert.equal(parsed["llm-deepseek"].maxTokens, 65536, "unrelated llm-deepseek fields untouched");
});

test("thinking enabled: no extra deployment restriction (high preserved)", () => {
  const settings = DEEPSEEK_SETTINGS_DISABLED.replace("  thinking: disabled\n", "  thinking: enabled\n");
  const result = patchDshSettings({
    settingsText: settings,
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("off", "high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "enabled" }),
    },
  });
  assert.equal(result.changed, false, "high stays writable; no changes");
});

test("thinking missing: default deployment policy does not restrict (high preserved)", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS,
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("off", "high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities(undefined),
    },
  });
  assert.equal(result.changed, false, "high stays writable; no changes");
});

test("unknown deployment thinking: nothing is written", () => {
  const result = patchDshSettings({
    settingsText: DEEPSEEK_SETTINGS_DISABLED.replace("  thinking: disabled\n", "  thinking: sometimes\n"),
    target: deepseekTarget("high"),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("off", "high", "max")),
    patchOptions: {
      adapterCapabilities: DEEPSEEK_RC2,
      deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "sometimes" as "enabled" }),
    },
  });
  assert.equal(result.changed, false);
  assert.ok(result.warnings.some((w) => w.includes("unrecognized value")));
});

// ---------- Fix 4: non-default target sync never touches agent-default-model.reasoningEffort ----------

const SETTINGS_DEFAULT_MAX =
  "# DSH settings\n" +
  "agent-default-model:\n" +
  "  provider: my-provider\n" +
  "  model: model-a\n" +
  "  reasoningEffort: max\n" +
  "\n" +
  "llm-pi-ai:\n" +
  "  providers:\n" +
  "    my-provider:\n" +
  "      baseURL: https://api.example.com/v1\n" +
  "      apiKeyEnv: MY_API_KEY\n" +
  "      models:\n" +
  "        - id: model-a\n" +
  "        - id: model-b\n";

test("non-default llm-pi-ai target never changes agent-default-model.reasoningEffort", () => {
  // Global default is max; the synced model (model-b) only VERIFIES low/high.
  // The old bug would demote the global default to high. It must stay max.
  const result = patchDshSettings({
    settingsText: SETTINGS_DEFAULT_MAX,
    target: target({
      model: "model-b",
      reasoningEffort: "max",
      targetInModels: false,
      isDefaultModel: false,
    }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
  });
  assert.equal(result.changed, true, "model-b capability is still written");
  assert.equal(result.writeTarget, "modelOverrides");
  const parsed = parse(result.candidateText) as any;
  const overrides = parsed["llm-pi-ai"].providers["my-provider"].modelOverrides["model-b"];
  assert.deepEqual(overrides.reasoningEfforts, { low: "low", high: "high" });
  assert.equal(parsed["agent-default-model"].reasoningEffort, "max", "global default must stay max");
  assert.equal(result.defaultEffort, undefined, "no default effort decision for a non-default target");
  assert.ok(
    result.changes.every((c) => !c.includes("agent-default-model")),
    "the diff must never touch agent-default-model",
  );
  assert.ok(result.warnings.some((w) => w.includes("not the global default model")), "clear warning expected");
});

test("non-default deepseek-official target writes nothing and never demotes the global default", () => {
  const settings =
    "agent-default-model:\n" +
    "  provider: deepseek-official\n" +
    "  model: deepseek-chat\n" +
    "  reasoningEffort: max\n" +
    "llm-deepseek:\n" +
    "  apiKeyEnv: DEEPSEEK_API_KEY\n";
  const result = patchDshSettings({
    settingsText: settings,
    target: target({
      providerKind: "deepseek-official",
      provider: "deepseek-official",
      model: "other-model",
      reasoningEffort: "max",
      modelsState: "catalog",
      targetInModels: false,
      isDefaultModel: false,
    }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
    patchOptions: { adapterCapabilities: DEEPSEEK_KNOWN },
  });
  assert.equal(result.changed, false);
  assert.equal(result.writeTarget, "none");
  assert.equal(result.defaultEffort, undefined);
  assert.ok(result.warnings.some((w) => w.includes("not the global default model")), "clear warning expected");
});

test("default llm-pi-ai target still corrects an invalid global default effort (regression guard)", () => {
  const settings = SETTINGS_DEFAULT_MAX.replace("  reasoningEffort: max\n", "  reasoningEffort: turbo\n");
  const result = patchDshSettings({
    settingsText: settings,
    target: target({
      model: "model-a",
      reasoningEffort: "turbo",
      targetInModels: true,
      isDefaultModel: true,
    }),
    manifest: withChatLevels(verifiedManifest(), verifiedLevels("low", "high")),
  });
  assert.equal(result.changed, true);
  const parsed = parse(result.candidateText) as any;
  assert.equal(parsed["agent-default-model"].reasoningEffort, "high", "default-target behavior is preserved");
});