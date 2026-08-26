import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SECRET = "sk-integration-secret-000111222";

function startMockEndpoint(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        let payload: any = null;
        try { payload = JSON.parse(body); } catch { /* keep null */ }
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/v1/responses") {
          res.writeHead(404);
          res.end(JSON.stringify({ error: { message: "endpoint not found: /v1/responses" } }));
          return;
        }
        if (req.url === "/v1/chat/completions") {
          const flatEffort = payload?.reasoning_effort;
          const nestedEffort = payload?.reasoning?.effort;
          if (flatEffort !== undefined || nestedEffort !== undefined) {
            if (nestedEffort !== undefined && flatEffort === undefined) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: { message: "unknown parameter: reasoning.effort" } }));
              return;
            }
            res.writeHead(400);
            res.end(JSON.stringify({ error: { message: "reasoning_effort must be one of: low, medium, high" } }));
            return;
          }
          if (payload?.tools) {
            res.writeHead(200);
            res.end(JSON.stringify({
              choices: [{
                index: 0,
                message: { role: "assistant", content: null,
                  tool_calls: [{ id: "call_1", type: "function", function: { name: "probemux_echo", arguments: '{"value":"X"}' } }] }
              }],
            }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { message: "not found" } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

function settingsYaml(port: number): string {
  return (
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
    `      baseURL: http://127.0.0.1:${port}/v1\n` +
    "      apiKeyEnv: MY_API_KEY\n" +
    "      api: openai-completions\n" +
    "      models:\n" +
    "        - id: model-a\n" +
    "        - id: model-b\n" +
    "\n" +
    "unrelated-section:\n" +
    "  keep: me\n"
  );
}

test("dsh inspect -> probe -> sync preview -> sync apply end to end", async () => {
  const { server, port } = await startMockEndpoint();
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-int-"));
    await writeFile(join(home, "settings.yaml"), settingsYaml(port));
    await writeFile(join(home, ".credentials.yaml"), `MY_API_KEY: ${SECRET}\n`);
    const env = { ...process.env, DSH_HOME: home };
    delete env.MY_API_KEY;

    // --- inspect ---
    const inspected = await run(process.execPath, ["src/cli.ts", "dsh", "inspect"], { cwd: REPO_ROOT, env });
    assert.match(inspected.stdout, /Provider: my-provider/);
    assert.match(inspected.stdout, /Model: model-a/);
    assert.match(inspected.stdout, new RegExp(`Base URL: http://127.0.0.1:${port}/v1`));
    assert.match(inspected.stdout, /Credential source: \.credentials\.yaml/);
    assert.match(inspected.stdout, /Credential available: yes/);
    assert.ok(!inspected.stdout.includes(SECRET), "inspect must not print the key");

    const jsonOut = await run(process.execPath, ["src/cli.ts", "dsh", "inspect", "--json"], { cwd: REPO_ROOT, env });
    const inspectedJson = JSON.parse(jsonOut.stdout);
    assert.equal(inspectedJson.provider, "my-provider");
    assert.equal(inspectedJson.credentialAvailable, true);
    assert.ok(!jsonOut.stdout.includes(SECRET), "inspect --json must not print the key");

    // --- probe ---
    const manifestPath = join(home, "manifest.json");
    const probed = await run(process.execPath, ["src/cli.ts", "dsh", "probe", "--active", "--output", manifestPath], { cwd: REPO_ROOT, env });
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.identity.providerId, "my-provider");
    assert.equal(manifest.identity.modelId, "model-a");
    assert.equal(manifest.protocols["chat-completions"].status, "VERIFIED");
    assert.ok(manifest.reasoning.levels.some((level: any) => level.canonical === "high" && level.status === "VERIFIED"));
    assert.ok(!manifestText.includes(SECRET), "manifest must not contain the key");
    assert.ok(!probed.stdout.includes(SECRET));

    // --- sync preview: diff only, no write ---
    const before = await readFile(join(home, "settings.yaml"), "utf8");
    const synced = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(synced.stdout, /Re-run with --confirm APPLY/);
    assert.match(synced.stdout, /reasoningEfforts/);
    assert.ok(!synced.stdout.includes(SECRET), "diff must not contain the key");
    assert.equal(await readFile(join(home, "settings.yaml"), "utf8"), before, "preview must not modify settings");
    const planText = await readFile(join(home, ".probemux-sync-plan.json"), "utf8");
    assert.ok(!planText.includes(SECRET), "plan must not contain the key");
    const plan = JSON.parse(planText);
    assert.ok(typeof plan.beforeSha256 === "string");
    assert.ok(typeof plan.afterSha256 === "string");

    // --- sync apply ---
    await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active", "--confirm", "APPLY"], { cwd: REPO_ROOT, env });
    const after = await readFile(join(home, "settings.yaml"), "utf8");
    assert.ok(!after.includes(SECRET), "settings.yaml must never contain the key");
    const parsed = parse(after) as any;
    const models = parsed["llm-pi-ai"].providers["my-provider"].models;
    const modelA = models.find((entry: any) => entry.id === "model-a");
    assert.deepEqual(modelA.reasoningEfforts, { low: "low", medium: "medium", high: "high" });
    const modelB = models.find((entry: any) => entry.id === "model-b");
    assert.equal(modelB.reasoningEfforts, undefined, "other models must stay untouched");
    assert.equal(parsed["llm-pi-ai"].providers["my-provider"].baseURL, `http://127.0.0.1:${port}/v1`);
    assert.equal(parsed["llm-pi-ai"].providers["my-provider"].apiKeyEnv, "MY_API_KEY");
    assert.equal(parsed["llm-pi-ai"].providers["my-provider"].displayName, "My Provider");
    assert.equal(parsed["agent-default-model"].reasoningEffort, "high", "valid default preserved");
    assert.deepEqual(parsed["unrelated-section"], { keep: "me" });
    assert.ok(after.includes("# DSH settings"), "comment preserved");

    // backup exists
    const files = await readdir(home);
    assert.ok(files.some((file) => file.includes("probemux-backup")), "timestamped backup must exist");

    // --- idempotent re-sync ---
    const again = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(again.stdout, /No settings changes required/);
  } finally {
    server.close();
  }
});

// ---------- deepseek-official: deployment policy (thinking) + rc.2 ----------

function startDeepseekMockEndpoint(enumeration: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        let payload: any = null;
        try { payload = JSON.parse(body); } catch { /* keep null */ }
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/v1/responses") {
          res.writeHead(404);
          res.end(JSON.stringify({ error: { message: "endpoint not found: /v1/responses" } }));
          return;
        }
        if (req.url === "/v1/chat/completions") {
          if (payload?.reasoning_effort !== undefined) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: { message: `reasoning_effort must be one of: ${enumeration}` } }));
            return;
          }
          if (payload?.tools) {
            res.writeHead(200);
            res.end(JSON.stringify({
              choices: [{
                index: 0,
                message: { role: "assistant", content: null,
                  tool_calls: [{ id: "call_1", type: "function", function: { name: "probemux_echo", arguments: '{"value":"X"}' } }] }
              }],
            }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { message: "not found" } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

const DEEPSEEK_SECRET = "sk-integration-deepseek-987654321";

/** Write a @deepseek-ai/dsh-llm-deepseek package.json fixture under the temp home. */
async function writeAdapterFixture(home: string, version: string, profile?: string): Promise<void> {
  const dir = profile === undefined
    ? join(home, "node_modules", "@deepseek-ai", "dsh-llm-deepseek")
    : join(home, "profiles", profile, "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-llm-deepseek", version }) + "\n");
}

function deepseekSettingsYaml(port: number, thinking?: string): string {
  const thinkingLine = thinking === undefined ? "" : `  thinking: ${thinking}\n`;
  return (
    "# DSH settings\n" +
    "agent-default-model:\n" +
    "  provider: deepseek-official\n" +
    "  model: deepseek-chat\n" +
    "  reasoningEffort: high\n" +
    "\n" +
    "llm-deepseek:\n" +
    "  apiKeyEnv: DEEPSEEK_API_KEY\n" +
    `  baseURL: http://127.0.0.1:${port}/v1\n` +
    thinkingLine +
    "  maxTokens: 65536\n"
  );
}

test("deepseek-official thinking disabled: endpoint off/low/high/max -> only off writable (high downgraded)", async () => {
  const { server, port } = await startDeepseekMockEndpoint("off, low, high, max");
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-ds-"));
    await writeFile(join(home, "settings.yaml"), deepseekSettingsYaml(port, "disabled"));
    await writeAdapterFixture(home, "0.1.1-rc.2", "web");
    const env = { ...process.env, DSH_HOME: home, DSH_PROFILE: "web", DEEPSEEK_API_KEY: DEEPSEEK_SECRET };
    delete env.DSH_VERSION;

    const preview = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(preview.stdout, /Provider: deepseek-official/);
    assert.match(preview.stdout, /DSH CLI version: unknown/);
    assert.match(preview.stdout, /DeepSeek adapter version: 0.1.1-rc.2/);
    assert.match(preview.stdout, /Adapter version source: active-profile/);
    assert.match(preview.stdout, /Endpoint verified efforts: off, low, high, max/);
    assert.match(preview.stdout, /Adapter allowed efforts: off, low, high, max/);
    assert.match(preview.stdout, /Deployment policy: thinking=disabled/);
    assert.match(preview.stdout, /Deployment allowed efforts: off/);
    assert.match(preview.stdout, /Writable efforts: off/);
    assert.match(preview.stdout, /reasoningEffort: high/);
    assert.match(preview.stdout, /reasoningEffort: off/);
    assert.match(preview.stdout, /Re-run with --confirm APPLY/);
    assert.ok(!preview.stdout.includes(DEEPSEEK_SECRET), "preview must not contain the key");

    await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active", "--confirm", "APPLY"], { cwd: REPO_ROOT, env });
    const after = await readFile(join(home, "settings.yaml"), "utf8");
    assert.ok(!after.includes(DEEPSEEK_SECRET), "settings must never contain the key");
    const parsed = parse(after) as any;
    assert.equal(parsed["agent-default-model"].reasoningEffort, "off", "high is not writable under thinking=disabled");
    assert.equal(parsed["llm-deepseek"].thinking, "disabled", "deployment policy untouched");
    assert.equal(parsed["llm-deepseek"].apiKeyEnv, "DEEPSEEK_API_KEY", "apiKeyEnv untouched");
    assert.equal(parsed["llm-deepseek"].baseURL, `http://127.0.0.1:${port}/v1`, "baseURL untouched");
    assert.equal(parsed["llm-deepseek"].maxTokens, 65536, "unrelated fields untouched");
    assert.ok(after.includes("# DSH settings"), "comment preserved");

    const again = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(again.stdout, /Writable efforts: off/);
    assert.match(again.stdout, /No settings changes required/);
  } finally {
    server.close();
  }
});

test("deepseek-official rc.2 thinking missing: full whitelist writable, no changes", async () => {
  const { server, port } = await startDeepseekMockEndpoint("off, low, high, max");
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-ds-"));
    await writeFile(join(home, "settings.yaml"), deepseekSettingsYaml(port));
    await writeAdapterFixture(home, "0.1.1-rc.2", "web");
    const env = { ...process.env, DSH_HOME: home, DSH_PROFILE: "web", DEEPSEEK_API_KEY: DEEPSEEK_SECRET };
    delete env.DSH_VERSION;

    const synced = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(synced.stdout, /DeepSeek adapter version: 0.1.1-rc.2/);
    assert.match(synced.stdout, /Adapter version source: active-profile/);
    assert.match(synced.stdout, /Deployment policy: thinking=missing/);
    assert.match(synced.stdout, /Deployment allowed efforts: unrestricted/);
    assert.match(synced.stdout, /Writable efforts: off, low, high, max/);
    assert.match(synced.stdout, /No settings changes required/);
  } finally {
    server.close();
  }
});

test("deepseek-official unknown adapter version: CLI version is never used as the compat authority", async () => {
  const { server, port } = await startDeepseekMockEndpoint("off, low, high, max");
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-ds-"));
    await writeFile(join(home, "settings.yaml"), deepseekSettingsYaml(port, "disabled"));
    // CLI version is known and even matches a compat row, but NO adapter
    // package exists -> adapter unknown -> fail-safe, nothing written.
    const env = { ...process.env, DSH_HOME: home, DSH_VERSION: "0.1.1-rc.2", DEEPSEEK_API_KEY: DEEPSEEK_SECRET };
    delete env.DSH_PROFILE;

    const synced = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(synced.stdout, /DSH CLI version: 0.1.1-rc.2/);
    assert.match(synced.stdout, /DeepSeek adapter version: unknown/);
    assert.match(synced.stdout, /Adapter version source: unknown/);
    assert.match(synced.stdout, /Adapter allowed efforts: unknown/);
    assert.match(synced.stdout, /Writable efforts: none/);
    assert.match(synced.stdout, /No reasoning effort changes will be written/);
    const settings = await readFile(join(home, "settings.yaml"), "utf8");
    assert.match(settings, /reasoningEffort: high/, "settings stay untouched");
  } finally {
    server.close();
  }
});

// ---------- adapter version discovery: real DSH fixtures ----------

test("deepseek-official DSH CLI 0.1.1-rc.1 + adapter 0.1.1-rc.2: adapter wins, profiles-shared source", async () => {
  const { server, port } = await startDeepseekMockEndpoint("off, low, high, max");
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-ds-"));
    await writeFile(join(home, "settings.yaml"), deepseekSettingsYaml(port));
    await writeAdapterFixture(home, "0.1.1-rc.2", "web");
    const env = { ...process.env, DSH_HOME: home, DSH_VERSION: "0.1.1-rc.1", DEEPSEEK_API_KEY: DEEPSEEK_SECRET };
    delete env.DSH_PROFILE;

    const synced = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(synced.stdout, /DSH CLI version: 0.1.1-rc.1/);
    assert.match(synced.stdout, /DeepSeek adapter version: 0.1.1-rc.2/);
    assert.match(synced.stdout, /Adapter version source: profiles-shared/);
    // rc.2 adapter rules apply (low is writable).
    assert.match(synced.stdout, /Adapter allowed efforts: off, low, high, max/);
    assert.match(synced.stdout, /Writable efforts: off, low, high, max/);
    assert.match(synced.stdout, /No settings changes required/);
  } finally {
    server.close();
  }
});

test("deepseek-official conflicting profiles with no active profile: ambiguous, zero writes", async () => {
  const { server, port } = await startDeepseekMockEndpoint("off, low, high, max");
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-ds-"));
    await writeFile(join(home, "settings.yaml"), deepseekSettingsYaml(port, "disabled"));
    await writeAdapterFixture(home, "0.1.1-rc.2", "web");
    await writeAdapterFixture(home, "0.1.1-rc.1", "desktop");
    const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: DEEPSEEK_SECRET };
    delete env.DSH_PROFILE;
    delete env.DSH_VERSION;

    const synced = await run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env });
    assert.match(synced.stdout, /DeepSeek adapter version: unknown/);
    assert.match(synced.stdout, /Adapter version source: ambiguous/);
    assert.match(synced.stdout, /Adapter allowed efforts: unknown/);
    assert.match(synced.stdout, /Writable efforts: none/);
    assert.match(synced.stdout, /No reasoning effort changes will be written/);
    assert.match(synced.stderr, /ambiguous/, "ambiguity is surfaced as a warning");
    const settings = await readFile(join(home, "settings.yaml"), "utf8");
    assert.match(settings, /reasoningEffort: high/, "settings stay untouched");
  } finally {
    server.close();
  }
});

test("dsh sync on a short credential fails before any network request", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-ds-"));
  await writeFile(join(home, "settings.yaml"),
    "agent-default-model:\n" +
    "  provider: p\n" +
    "  model: m\n" +
    "llm-pi-ai:\n" +
    "  providers:\n" +
    "    p:\n" +
    "      baseURL: https://example.invalid/v1\n" +
    "      apiKeyEnv: SHORT_KEY\n",
  );
  await writeFile(join(home, ".credentials.yaml"), "SHORT_KEY: abc\n");
  const env = { ...process.env, DSH_HOME: home };
  delete env.SHORT_KEY;
  await assert.rejects(
    () => run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env }),
    (error: any) => {
      assert.equal(error.code, 2);
      const stderr = String(error.stderr ?? "");
      assert.match(stderr, /too short to handle safely/);
      assert.ok(!stderr.includes("abc"), "the value must never leak");
      return true;
    },
  );
});

test("dsh probe refuses to run without --active", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-int-"));
  await writeFile(join(home, "settings.yaml"), "agent-default-model:\n  provider: p\n  model: m\nllm-pi-ai:\n  providers:\n    p:\n      baseURL: https://x/v1\n");
  const env = { ...process.env, DSH_HOME: home };
  await assert.rejects(
    () => run(process.execPath, ["src/cli.ts", "dsh", "probe"], { cwd: REPO_ROOT, env }),
    (error: any) => {
      assert.match(String(error.stderr ?? ""), /Active probing is disabled/);
      return true;
    },
  );
});

test("dsh sync on a catalog provider without baseURL refuses with the exact message", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-int-"));
  await writeFile(join(home, "settings.yaml"),
    "agent-default-model:\n" +
    "  provider: catalog-x\n" +
    "  model: m\n" +
    "llm-pi-ai:\n" +
    "  providers:\n" +
    "    catalog-x:\n" +
    "      apiKeyEnv: K\n",
  );
  const env = { ...process.env, DSH_HOME: home };
  await assert.rejects(
    () => run(process.execPath, ["src/cli.ts", "dsh", "sync", "--active"], { cwd: REPO_ROOT, env }),
    (error: any) => {
      assert.match(String(error.stderr ?? ""), /catalog-derived and ProbeMux cannot resolve it safely yet/);
      return true;
    },
  );
});