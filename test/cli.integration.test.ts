import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));

test("CLI validates and renders the canonical manifest fixture", async () => {
  const validated = await run(process.execPath, ["src/cli.ts", "validate", "examples/manifests/verified-fixture.json"], { cwd });
  assert.match(validated.stdout, /Valid Capability Manifest 0\.1\.0/);
  const rendered = await run(process.execPath, [
    "src/cli.ts",
    "render",
    "examples/manifests/verified-fixture.json",
    "--target",
    "codex",
    "--default-effort",
    "high",
  ], { cwd });
  assert.match(rendered.stdout, /model_reasoning_effort = "high"/);
  assert.match(rendered.stderr, /render safety: VERIFIED/);
});

test("CLI probe refuses to run without --active before network work", async () => {
  await assert.rejects(() => run(process.execPath, [
    "src/cli.ts",
    "probe",
    "--base-url",
    "https://example.invalid/v1",
    "--provider-id",
    "fixture",
    "--model",
    "model",
  ], { cwd }), (error: unknown) => {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    assert.match(stderr, /Active probing is disabled/);
    return true;
  });
});
