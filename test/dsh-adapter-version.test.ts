import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectDshDeepseekAdapterVersion,
  getDshAdapterCapabilities,
} from "../src/integrations/dsh/capabilities.ts";

/** Write a @deepseek-ai/dsh-llm-deepseek package.json fixture under the temp home. */
async function writeAdapterFixture(home: string, version: string, profile?: string): Promise<string> {
  const dir = profile === undefined
    ? join(home, "node_modules", "@deepseek-ai", "dsh-llm-deepseek")
    : join(home, "profiles", profile, "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  await writeFile(manifestPath, JSON.stringify({ name: "@deepseek-ai/dsh-llm-deepseek", version }) + "\n");
  return manifestPath;
}

async function writeRawAdapterManifest(home: string, raw: string, profile?: string): Promise<void> {
  const dir = profile === undefined
    ? join(home, "node_modules", "@deepseek-ai", "dsh-llm-deepseek")
    : join(home, "profiles", profile, "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), raw);
}

const ORIGINAL_DSH_PROFILE = process.env.DSH_PROFILE;

function withProfile(name: string | undefined): void {
  if (name === undefined) {
    if (ORIGINAL_DSH_PROFILE === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = ORIGINAL_DSH_PROFILE;
    return;
  }
  process.env.DSH_PROFILE = name;
}

test("adapter version: explicit active profile resolves its package (rc.2)", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2", "web");
  try {
    withProfile("web");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.2");
    assert.equal(detection.source, "active-profile");
    assert.ok(detection.packagePath!.endsWith(join("profiles", "web", "node_modules", "@deepseek-ai", "dsh-llm-deepseek", "package.json")));
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: explicit active profile resolves its package (rc.1)", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.1", "desktop");
  try {
    withProfile("desktop");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.1");
    assert.equal(detection.source, "active-profile");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: shared profiles/node_modules flat fallback is found", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2", undefined);
  const flat = join(home, "profiles", "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  await mkdir(join(home, "profiles"), { recursive: true });
  await mkdir(flat, { recursive: true });
  const { rename } = await import("node:fs/promises");
  await rename(join(home, "node_modules", "@deepseek-ai", "dsh-llm-deepseek", "package.json"), join(flat, "package.json"));
  try {
    withProfile(undefined);
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.2");
    assert.equal(detection.source, "profiles-shared");
    assert.ok(detection.packagePath!.includes(join("profiles", "node_modules")));
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: single profile without explicit selection resolves via profiles-shared", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2", "web");
  try {
    withProfile(undefined);
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.2");
    assert.equal(detection.source, "profiles-shared");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: $DSH_HOME/node_modules package is found", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2");
  try {
    withProfile(undefined);
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.2");
    assert.equal(detection.source, "dsh-home-node-modules");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: no package anywhere -> unknown", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  try {
    withProfile(undefined);
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, undefined);
    assert.equal(detection.source, "unknown");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: CLI version never overrides the detected adapter version", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.1", "web");
  try {
    withProfile("web");
    process.env.DSH_VERSION = "0.1.1-rc.2";
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.1", "adapter package wins over CLI env");
    const caps = getDshAdapterCapabilities("deepseek-official", detection.version);
    assert.deepEqual([...caps.allowedReasoningEfforts!], ["off", "high", "max"], "rc.1 adapter rules apply");
    const cliCaps = getDshAdapterCapabilities("deepseek-official", process.env.DSH_VERSION);
    assert.deepEqual([...cliCaps.allowedReasoningEfforts!], ["off", "low", "high", "max"], "CLI version alone would pick rc.2");
  } finally {
    delete process.env.DSH_VERSION;
    withProfile(undefined);
  }
});

test("adapter version: two profiles with active known -> active wins", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2", "web");
  await writeAdapterFixture(home, "0.1.1-rc.1", "desktop");
  try {
    withProfile("web");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, "0.1.1-rc.2");
    assert.equal(detection.source, "active-profile");
    withProfile("desktop");
    const other = await detectDshDeepseekAdapterVersion(home);
    assert.equal(other.version, "0.1.1-rc.1");
    assert.equal(other.source, "active-profile");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: two profiles with unknown active -> ambiguous, never pick newest", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2", "web");
  await writeAdapterFixture(home, "0.1.1-rc.1", "desktop");
  try {
    withProfile(undefined);
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, undefined, "no version is chosen when ambiguous");
    assert.equal(detection.source, "ambiguous");
    assert.ok(detection.warning!.includes("ambiguous"));
    const caps = getDshAdapterCapabilities("deepseek-official", detection.version);
    assert.equal(caps.safeToWrite, false, "ambiguous -> safeToWrite false");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: malformed adapter package.json is fail-safe", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeRawAdapterManifest(home, "{ this is not json", "web");
  try {
    withProfile("web");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, undefined, "malformed metadata is treated as absent");
    assert.equal(detection.source, "unknown");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: package.json without a version field is fail-safe", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeRawAdapterManifest(home, JSON.stringify({ name: "@deepseek-ai/dsh-llm-deepseek" }), "web");
  try {
    withProfile("web");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, undefined);
    assert.equal(detection.source, "unknown");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: empty version string is fail-safe", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "", "web");
  try {
    withProfile("web");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.version, undefined);
    assert.equal(detection.source, "unknown");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: invalid DSH_PROFILE name is ignored, never traverses", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-adv-"));
  await writeAdapterFixture(home, "0.1.1-rc.2", "web");
  try {
    withProfile("..");
    const detection = await detectDshDeepseekAdapterVersion(home);
    assert.equal(detection.source, "profiles-shared", "falls back to the profile scan, never a traversal");
    assert.equal(detection.version, "0.1.1-rc.2");
    withProfile("node_modules");
    const again = await detectDshDeepseekAdapterVersion(home);
    assert.equal(again.source, "profiles-shared");
  } finally {
    withProfile(undefined);
  }
});

test("adapter version: unknown adapter version is never written against", async () => {
  const caps = getDshAdapterCapabilities("deepseek-official", undefined);
  assert.equal(caps.safeToWrite, false);
  assert.equal(caps.source, "unknown");
  assert.ok(caps.warning!.includes("could not detect"));
});
