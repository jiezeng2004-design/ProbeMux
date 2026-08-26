import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { buildDshList, dshListJson, formatDshList } from "../src/integrations/dsh/list.ts";
import { clearSecrets, redactSecrets } from "../src/security.ts";

const REAL_SETTINGS = `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: max
llm-pi-ai:
  providers:
    openrouter-latest:
      displayName: OP
      baseURL: https://openrouter.ai/api/v1
      apiKeyEnv: OPENROUTER_LATEST_API_KEY
      api: openai-completions
      models:
        - id: deepseek/deepseek-v4-flash-vision-exp
        - id: other/model
    opencode:
      apiKeyEnv: OPENCODE_API_KEY
      models:
        - id: deepseek-v4-flash-free
    catalog-x:
      apiKeyEnv: CATALOG_X_API_KEY
      models:
        - id: unknown-model
llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
`;

test("dsh list: versioned refs credentials resolve as available from .credentials.yaml", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-list-"));
  await writeFile(join(home, ".credentials.yaml"),
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-list-deepseek-123\n  OPENROUTER_LATEST_API_KEY: sk-list-openrouter-123\n  OPENCODE_API_KEY: sk-list-opencode-123\n");
  const settings = parse(REAL_SETTINGS) as any;
  const result = await buildDshList(settings, home);
  assert.equal(result.defaultProvider, "deepseek-official");
  assert.equal(result.defaultModel, "deepseek-v4-flash");
  assert.equal(result.defaultEffort, "max");
  const byId = new Map(result.rows.map((row) => [row.provider, row]));
  assert.equal(byId.get("deepseek-official")?.credentialSource, "credentials-yaml");
  assert.equal(byId.get("deepseek-official")?.credentialAvailable, true);
  assert.equal(byId.get("openrouter-latest")?.credentialSource, "credentials-yaml");
  assert.equal(byId.get("openrouter-latest")?.credentialAvailable, true);
  assert.equal(byId.get("opencode")?.credentialSource, "credentials-yaml");
  assert.equal(byId.get("opencode")?.credentialAvailable, true);
});

test("dsh list: missing credential rows report unavailable with the source label", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-list-"));
  const settings = parse(REAL_SETTINGS) as any;
  const result = await buildDshList(settings, home);
  for (const row of result.rows) {
    assert.equal(row.credentialAvailable, false);
    assert.equal(row.credentialSource, "unresolved");
  }
  const text = formatDshList(result);
  assert.match(text, /no credential found for 'DEEPSEEK_API_KEY'/);
  assert.match(text, /missing \/ no/);
});

test("dsh list: registry-known opencode resolves, unknown catalog provider stays flagged, deepseek keeps safe default", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-list-"));
  const settings = parse(REAL_SETTINGS) as any;
  const result = await buildDshList(settings, home);
  const byId = new Map(result.rows.map((row) => [row.provider, row]));
  // opencode is registry-recognized: resolved WITHOUT an explicit baseURL.
  assert.equal(byId.get("opencode")?.catalogEndpointUnresolved, false);
  assert.equal(byId.get("opencode")?.baseUrl, "https://opencode.ai/zen/v1");
  assert.equal(byId.get("opencode")?.endpointSource, "registry");
  // catalog-x is NOT recognized: never guessed.
  assert.equal(byId.get("catalog-x")?.catalogEndpointUnresolved, true);
  assert.equal(byId.get("catalog-x")?.baseUrl, undefined);
  assert.equal(byId.get("catalog-x")?.endpointSource, undefined);
  assert.equal(byId.get("openrouter-latest")?.catalogEndpointUnresolved, false);
  assert.equal(byId.get("openrouter-latest")?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(byId.get("openrouter-latest")?.endpointSource, "explicit");
  assert.equal(byId.get("deepseek-official")?.baseUrl, "https://api.deepseek.com");
  assert.equal(byId.get("deepseek-official")?.catalogEndpointUnresolved, false);
  assert.equal(byId.get("openrouter-latest")?.modelCount, 2);
  const text = formatDshList(result);
  assert.match(text, /will not guess the endpoint/);
  assert.match(text, /opencode\.ai\/zen\/v1 \(registry\)/, "table shows the registry provenance");
});

test("dsh list: json view shape and zero-secret guarantee", async () => {
  clearSecrets();
  const home = await mkdtemp(join(tmpdir(), "probemux-list-"));
  const secret = "sk-list-never-printed-987654321";
  await writeFile(join(home, ".credentials.yaml"), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${secret}\n`);
  const settings = parse(REAL_SETTINGS) as any;
  const result = await buildDshList(settings, home);
  const json = JSON.parse(dshListJson(result));
  assert.equal(json.schemaVersion, "0.1.0");
  assert.equal(json.kind, "probemux.dsh-list");
  assert.equal(json.defaultModel.model, "deepseek-v4-flash");
  assert.equal(json.providers.length, 4);
  const text = dshListJson(result) + "\n" + formatDshList(result);
  assert.ok(!text.includes(secret), "secrets must never appear in list output");
  assert.ok(!redactSecrets(text).includes(secret));
  clearSecrets();
});

test("dsh list: default model marker only on the default provider row", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-list-"));
  const settings = parse(REAL_SETTINGS) as any;
  const result = await buildDshList(settings, home);
  const byId = new Map(result.rows.map((row) => [row.provider, row]));
  assert.equal(byId.get("deepseek-official")?.defaultModel, "deepseek-v4-flash");
  assert.equal(byId.get("openrouter-latest")?.defaultModel, undefined);
  assert.equal(byId.get("opencode")?.defaultModel, undefined);
  assert.equal(byId.get("catalog-x")?.defaultModel, undefined);
});
