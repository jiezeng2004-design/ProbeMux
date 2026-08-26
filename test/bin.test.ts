import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("../bin/probemux.ts", import.meta.url));

test("bin launcher prints help like the direct CLI", async () => {
  const result = await run(process.execPath, [LAUNCHER, "--help"], { cwd: REPO_ROOT });
  assert.match(result.stdout, /ProbeMux v0\.1\.0-dev/);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /probemux dsh inspect/);
});

test("bin launcher exits 2 with a sanitized error on unknown command", async () => {
  await assert.rejects(
    () => run(process.execPath, [LAUNCHER, "bogus-command"], { cwd: REPO_ROOT }),
    (error: any) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr ?? ""), /Unknown command 'bogus-command'/);
      assert.match(String(error.stderr ?? ""), /^ProbeMux: /);
      return true;
    },
  );
});

test("bin launcher runs real subcommands", async () => {
  const result = await run(process.execPath, [LAUNCHER, "validate", "examples/manifests/verified-fixture.json"], { cwd: REPO_ROOT });
  assert.match(result.stdout, /Valid Capability Manifest 0\.1\.0/);
});
