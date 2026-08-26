import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeWritableReasoningEfforts,
  detectDshVersion,
  getDshAdapterCapabilities,
  getDshDeploymentCapabilities,
} from "../src/integrations/dsh/capabilities.ts";

test("llm-pi-ai is dynamic and imposes no adapter restriction", () => {
  const caps = getDshAdapterCapabilities("llm-pi-ai");
  assert.equal(caps.providerKind, "llm-pi-ai");
  assert.equal(caps.source, "dynamic");
  assert.equal(caps.safeToWrite, true);
  assert.equal(caps.allowedReasoningEfforts, undefined);
});

test("deepseek-official with a known version gets the version-table row", () => {
  const caps = getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.1");
  assert.equal(caps.safeToWrite, true);
  assert.equal(caps.source, "version-table");
  assert.deepEqual([...caps.allowedReasoningEfforts!], ["off", "high", "max"]);
});

test("deepseek-official rc.2 is in the compatibility table with the verified whitelist", () => {
  const caps = getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2");
  assert.equal(caps.safeToWrite, true);
  assert.equal(caps.source, "version-table");
  assert.deepEqual(
    [...caps.allowedReasoningEfforts!],
    ["off", "low", "high", "max"],
    "verified from upstream dsh-llm-deepseek@0.1.1-rc.2: off/low/high/max",
  );
});

test("deepseek-official with an unknown version is not writable and warns", () => {
  const caps = getDshAdapterCapabilities("deepseek-official");
  assert.equal(caps.safeToWrite, false);
  assert.equal(caps.source, "unknown");
  assert.ok(caps.warning!.includes("could not detect"));
});

test("deepseek-official with a version missing from the table is not writable", () => {
  const caps = getDshAdapterCapabilities("deepseek-official", "9.9.9");
  assert.equal(caps.safeToWrite, false);
  assert.equal(caps.source, "unknown");
  assert.ok(caps.warning!.includes("not in the ProbeMux compatibility table"));
});

test("computeWritableReasoningEfforts: unrestricted adapter passes verified efforts through", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["low", "medium", "high"],
    adapterCapabilities: getDshAdapterCapabilities("llm-pi-ai"),
  });
  assert.equal(computation.safeToWrite, true);
  assert.deepEqual([...computation.writable], ["low", "medium", "high"]);
});

test("computeWritableReasoningEfforts: intersection drops adapter-unsupported efforts", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["low", "medium", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.1"),
  });
  assert.deepEqual([...computation.writable], ["high", "max"], "low/medium are verified but not adapter-writable");
});

test("computeWritableReasoningEfforts: unsupported verified effort yields empty writable set", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["xhigh"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.1"),
  });
  assert.equal(computation.safeToWrite, true);
  assert.deepEqual([...computation.writable], []);
});

test("computeWritableReasoningEfforts: unknown adapter capability is never guessed", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["low", "medium", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official"),
  });
  assert.equal(computation.safeToWrite, false);
  assert.deepEqual([...computation.writable], []);
});

// ---------- deployment capability layer (llm-deepseek.thinking) ----------

test("deployment: thinking=disabled restricts the writable efforts to off", () => {
  const caps = getDshDeploymentCapabilities({ thinking: "disabled" });
  assert.equal(caps.safeToWrite, true);
  assert.equal(caps.source, "settings");
  assert.equal(caps.policy, "thinking=disabled");
  assert.deepEqual([...caps.allowedReasoningEfforts!], ["off"]);
});

test("deployment: thinking=enabled imposes no extra restriction", () => {
  const caps = getDshDeploymentCapabilities({ thinking: "enabled" });
  assert.equal(caps.safeToWrite, true);
  assert.equal(caps.source, "settings");
  assert.equal(caps.policy, "thinking=enabled");
  assert.equal(caps.allowedReasoningEfforts, undefined);
});

test("deployment: missing thinking is the upstream default and imposes no restriction", () => {
  const caps = getDshDeploymentCapabilities(undefined);
  assert.equal(caps.safeToWrite, true);
  assert.equal(caps.source, "default");
  assert.equal(caps.policy, "thinking=missing");
  assert.equal(caps.allowedReasoningEfforts, undefined, "upstream: missing thinking puts nothing on the wire");
});

test("deployment: an unrecognized thinking value is never guessed", () => {
  const caps = getDshDeploymentCapabilities({ thinking: "sometimes" as "enabled" });
  assert.equal(caps.safeToWrite, false);
  assert.equal(caps.source, "unknown");
  assert.ok(caps.warning!.includes("unrecognized"));
});

test("computeWritableReasoningEfforts: endpoint ∩ adapter ∩ deployment(off) = off", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["off", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2"),
    deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "disabled" }),
  });
  assert.equal(computation.safeToWrite, true);
  assert.deepEqual([...computation.writable], ["off"]);
});

test("computeWritableReasoningEfforts: endpoint without off ∩ deployment(off) is empty", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2"),
    deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "disabled" }),
  });
  assert.equal(computation.safeToWrite, true);
  assert.deepEqual([...computation.writable], [], "nothing may be written without endpoint VERIFIED off");
});

test("computeWritableReasoningEfforts: rc.2 adapter + missing thinking keeps endpoint efforts", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["off", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2"),
    deploymentCapabilities: getDshDeploymentCapabilities(undefined),
  });
  assert.deepEqual([...computation.writable], ["off", "high", "max"]);
});

test("computeWritableReasoningEfforts: low is writable on rc.2 but not on the rc.1 row", () => {
  const rc2 = computeWritableReasoningEfforts({
    verifiedEfforts: ["off", "low", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2"),
  });
  assert.deepEqual([...rc2.writable], ["off", "low", "high", "max"]);
  const rc1 = computeWritableReasoningEfforts({
    verifiedEfforts: ["off", "low", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.1"),
  });
  assert.deepEqual([...rc1.writable], ["off", "high", "max"], "rc.1 row behaviour unchanged");
});

test("computeWritableReasoningEfforts: unknown deployment capability is never guessed", () => {
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: ["off", "high", "max"],
    adapterCapabilities: getDshAdapterCapabilities("deepseek-official", "0.1.1-rc.2"),
    deploymentCapabilities: getDshDeploymentCapabilities({ thinking: "sometimes" as "enabled" }),
  });
  assert.equal(computation.safeToWrite, false);
  assert.deepEqual([...computation.writable], []);
});

const ORIGINAL_DSH_VERSION = process.env.DSH_VERSION;

test("detectDshVersion honors the DSH_VERSION environment override", async () => {
  process.env.DSH_VERSION = "0.1.1-rc.1";
  try {
  assert.equal(await detectDshVersion(), "0.1.1-rc.1");
  } finally {
    if (ORIGINAL_DSH_VERSION === undefined) delete process.env.DSH_VERSION;
    else process.env.DSH_VERSION = ORIGINAL_DSH_VERSION;
  }
});

test("detectDshVersion reads $DSH_HOME/package.json metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-dsv-"));
  await writeFile(join(home, "package.json"), JSON.stringify({ name: "dsh", version: "0.1.1-rc.1" }));
  assert.equal(await detectDshVersion(home), "0.1.1-rc.1");
});

test("detectDshVersion reads a plain $DSH_HOME/version file", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-dsv-"));
  await writeFile(join(home, "version"), "0.1.1-rc.1\n");
  assert.equal(await detectDshVersion(home), "0.1.1-rc.1");
});

test("detectDshVersion returns undefined when no stable source exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-dsv-"));
  assert.equal(await detectDshVersion(home), undefined);
});