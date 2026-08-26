import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyConfigDiffPlan, createConfigDiffPlan } from "../src/config/transaction.ts";

test("diff plan requires confirmation, backs up, and atomically applies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probemux-config-"));
  const current = join(dir, "config.toml");
  const candidate = join(dir, "candidate.toml");
  const planPath = join(dir, "plan.json");
  await writeFile(current, "model = \"old\"\n");
  await writeFile(candidate, "model = \"new\"\n");
  const plan = await createConfigDiffPlan({ currentPath: current, candidatePath: candidate, planPath });
  assert.match(plan.diff, /-model = "old"/);
  assert.match(plan.diff, /\+model = "new"/);
  await assert.rejects(() => applyConfigDiffPlan({ planPath, confirmation: undefined }), /--confirm APPLY/);
  const result = await applyConfigDiffPlan({
    planPath,
    confirmation: "APPLY",
    now: new Date("2026-08-25T00:00:00.000Z"),
  });
  assert.equal(await readFile(current, "utf8"), "model = \"new\"\n");
  assert.ok(result.backupPath);
  assert.equal(await readFile(result.backupPath as string, "utf8"), "model = \"old\"\n");
});

test("apply refuses when the reviewed target changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probemux-stale-"));
  const current = join(dir, "config.json");
  const candidate = join(dir, "candidate.json");
  const planPath = join(dir, "plan.json");
  await writeFile(current, "{}\n");
  await writeFile(candidate, "{\"ok\":true}\n");
  await createConfigDiffPlan({ currentPath: current, candidatePath: candidate, planPath });
  await writeFile(current, "{\"changed\":true}\n");
  await assert.rejects(() => applyConfigDiffPlan({ planPath, confirmation: "APPLY" }), /changed after diff generation/);
});
