import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CATALOG_ENDPOINT_UNRESOLVED_MESSAGE, discoverDshTarget } from "../src/integrations/dsh/discovery.ts";
import { dshSettingsPath, resolveDshHome } from "../src/integrations/dsh/home.ts";

const ORIGINAL_DSH_HOME = process.env.DSH_HOME;

async function makeHome(settingsYaml: string, extra: Record<string, string> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "probemux-dsh-"));
  await writeFile(dshSettingsPath(home), settingsYaml);
  for (const [name, content] of Object.entries(extra)) {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, name), content);
  }
  return home;
}

test("resolveDshHome prefers DSH_HOME then falls back to ~/.dsh", () => {
  process.env.DSH_HOME = "/custom/dsh";
  try {
    assert.equal(resolveDshHome(), "/custom/dsh");
    assert.equal(resolveDshHome(""), "/custom/dsh");
    assert.equal(resolveDshHome("/explicit"), "/explicit");
  } finally {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME;
  }
});

test("resolveDshHome defaults to homedir/.dsh (cross-platform)", () => {
  if (process.env.DSH_HOME !== undefined) return; // skip when env is set
  assert.equal(resolveDshHome(), join(homedir(), ".dsh"));
});

test("discovers llm-pi-ai provider, model, endpoint and credential ref", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: my-provider\n" +
    "  model: model-a\n" +
    "  reasoningEffort: medium\n" +
    "llm-pi-ai:\n" +
    "  providers:\n" +
    "    my-provider:\n" +
    "      baseURL: https://api.example.com/v1\n" +
    "      apiKeyEnv: MY_API_KEY\n" +
    "      api: openai-completions\n" +
    "      models:\n" +
    "        - id: model-a\n" +
    "        - id: model-b\n",
  );
  const target = await discoverDshTarget({ dshHome: home });
  assert.equal(target.provider, "my-provider");
  assert.equal(target.model, "model-a");
  assert.equal(target.reasoningEffort, "medium");
  assert.equal(target.baseUrl, "https://api.example.com/v1");
  assert.equal(target.protocolHint, "openai-completions");
  assert.equal(target.apiKeyEnv, "MY_API_KEY");
  assert.equal(target.providerKind, "llm-pi-ai");
  assert.equal(target.modelsState, "explicit");
  assert.equal(target.targetInModels, true);
  assert.equal(target.catalogEndpointUnresolved, false);
  assert.equal(target.source, "llm-pi-ai.providers.my-provider");
  assert.equal("value" in target.credential, false, "DshTarget must never carry the secret value");
});

test("supports deepseek-official with defaults and custom baseURL", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: deepseek-official\n" +
    "  model: deepseek-chat\n" +
    "llm-deepseek:\n" +
    "  apiKeyEnv: DEEPSEEK_API_KEY\n" +
    "  baseURL: https://gateway.example.com/v1\n",
  );
  const target = await discoverDshTarget({ dshHome: home });
  assert.equal(target.providerKind, "deepseek-official");
  assert.equal(target.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(target.baseUrl, "https://gateway.example.com/v1");
  assert.equal(target.protocolHint, "openai-completions");
});

test("deepseek-official falls back to DEEPSEEK_API_KEY and api.deepseek.com", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: deepseek-official\n" +
    "  model: deepseek-chat\n" +
    "llm-deepseek: {}\n",
  );
  const target = await discoverDshTarget({ dshHome: home });
  assert.equal(target.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(target.baseUrl, "https://api.deepseek.com");
});

test("catalog provider without explicit baseURL is flagged, never guessed", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: some-catalog-provider\n" +
    "  model: model-x\n" +
    "llm-pi-ai:\n" +
    "  providers:\n" +
    "    some-catalog-provider:\n" +
    "      apiKeyEnv: K\n" +
    "      api: openai-completions\n",
  );
  const target = await discoverDshTarget({ dshHome: home });
  assert.equal(target.catalogEndpointUnresolved, true);
  assert.equal(target.baseUrl, undefined);
  assert.match(CATALOG_ENDPOINT_UNRESOLVED_MESSAGE, /catalog-derived/);
});

test("missing provider raises a clear error", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: ghost\n" +
    "  model: m\n" +
    "llm-pi-ai:\n" +
    "  providers: {}\n",
  );
  await assert.rejects(() => discoverDshTarget({ dshHome: home }), /not configured/);
});

test("missing agent-default-model raises a clear error", async () => {
  const home = await makeHome("llm-pi-ai:\n  providers: {}\n");
  await assert.rejects(() => discoverDshTarget({ dshHome: home }), /agent-default-model/);
});

test("missing model raises a clear error", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: p\n" +
    "llm-pi-ai:\n" +
    "  providers:\n" +
    "    p:\n" +
    "      baseURL: https://x/v1\n",
  );
  await assert.rejects(() => discoverDshTarget({ dshHome: home }), /provider and model/);
});

test("--provider and --model overrides win without re-entry", async () => {
  const home = await makeHome(
    "agent-default-model:\n" +
    "  provider: p1\n" +
    "  model: m1\n" +
    "llm-pi-ai:\n" +
    "  providers:\n" +
    "    p2:\n" +
    "      baseURL: https://two/v1\n" +
    "      apiKeyEnv: K2\n" +
    "      models:\n" +
    "        - id: m2\n",
  );
  const target = await discoverDshTarget({ dshHome: home, provider: "p2", model: "m2" });
  assert.equal(target.provider, "p2");
  assert.equal(target.model, "m2");
  assert.equal(target.baseUrl, "https://two/v1");
  assert.equal(target.apiKeyEnv, "K2");
  assert.equal(target.targetInModels, true);
});

test("missing settings.yaml raises a friendly error", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-dsh-"));
  await assert.rejects(() => discoverDshTarget({ dshHome: home }), /DSH settings not found/);
});
