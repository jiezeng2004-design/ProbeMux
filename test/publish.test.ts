import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run npm / installed package launchers on both Windows and POSIX CI hosts. */
async function runCmd(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CmdResult> {
  try {
    const env = { ...process.env, ...options.env };
    if (process.platform === "win32") {
      // Quote the command name only when it contains spaces: cmd.exe cannot
      // PATHEXT-resolve a quoted name (npm -> npm.cmd), but absolute paths with
      // spaces need the quotes.
      const quoted = command.includes(" ") ? `"${command}"` : command;
      const result = await run("cmd.exe", ["/d", "/s", "/c", `${quoted} ${args.join(" ")}`], {
        cwd: options.cwd,
        env,
        windowsVerbatimArguments: false,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    }

    const result = await run(command, args, { cwd: options.cwd, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("npm pack -> fresh install -> probemux launcher works (help, dsh help, dsh inspect)", async () => {
  const work = await mkdtemp(join(tmpdir(), "pmux-publish-"));
  const packDir = join(work, "pack");
  const consumer = join(work, "consumer");
  const dshHome = join(work, "dsh-home");
  await mkdir(packDir, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  try {
    // 1. npm pack (prepack runs the build automatically) into packDir
    const packed = await runCmd("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: REPO_ROOT });
    assert.equal(packed.code, 0, `npm pack failed: ${packed.stderr}`);
    const packMeta: { filename?: string }[] = JSON.parse(packed.stdout.trim());
    const tgzName = packMeta[0]?.filename;
    assert.ok(tgzName && tgzName.endsWith(".tgz"), `no tgz filename in pack output: ${packed.stdout}`);
    const tgzPath = join(packDir, tgzName);

    // 2. fresh consumer project: npm init -y equivalent + install the tgz
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "probemux-consumer", private: true, version: "0.0.0" }) + "\n");
    const installed = await runCmd("npm", ["install", "--no-audit", "--no-fund", tgzPath], { cwd: consumer });
    assert.equal(installed.code, 0, `npm install failed: ${installed.stderr}`);
    const binName = process.platform === "win32" ? "probemux.cmd" : "probemux";
    const binCmd = join(consumer, "node_modules", ".bin", binName);
    await assert.doesNotReject(() => readFile(binCmd), `${binName} must exist after install`);

    // 3. probemux --help -> exit 0
    const help = await runCmd(binCmd, ["--help"], { cwd: consumer });
    assert.equal(help.code, 0, `--help exit ${help.code}: ${help.stderr}`);
    assert.match(help.stdout, /ProbeMux v0\.1\.0/);
    assert.ok(!help.stderr.includes("ERR_UNSUPPORTED"), "no Node type-stripping errors");

    // 4. probemux dsh --help -> exit 0
    const dshHelp = await runCmd(binCmd, ["dsh", "--help"], { cwd: consumer });
    assert.equal(dshHelp.code, 0, `dsh --help exit ${dshHelp.code}: ${dshHelp.stderr}`);
    assert.match(dshHelp.stdout, /dsh inspect/);
    assert.ok(!dshHelp.stderr.includes("ERR_UNSUPPORTED"), "no Node type-stripping errors");

    // 5. probemux dsh inspect against a real DSH_HOME fixture -> real ProbeMux logic
    await writeFile(join(dshHome, "settings.yaml"),
      "agent-default-model:\n" +
      "  provider: my-provider\n" +
      "  model: model-a\n" +
      "llm-pi-ai:\n" +
      "  providers:\n" +
      "    my-provider:\n" +
      "      baseURL: https://example.invalid/v1\n" +
      "      apiKeyEnv: MY_API_KEY\n");
    const inspected = await runCmd(binCmd, ["dsh", "inspect"], { cwd: consumer, env: { DSH_HOME: dshHome } });
    assert.equal(inspected.code, 0, `dsh inspect exit ${inspected.code}: ${inspected.stderr}`);
    assert.match(inspected.stdout, /Provider: my-provider/);
    assert.match(inspected.stdout, /Model: model-a/);
    const joined = inspected.stdout + inspected.stderr;
    for (const forbidden of ["ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING", "--experimental-strip-types", "tsx", "ts-node", "TypeScript"]) {
      assert.ok(!joined.includes(forbidden), `forbidden marker ${forbidden} in dsh inspect output`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
