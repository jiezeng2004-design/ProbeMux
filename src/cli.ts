#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderManifest, RENDER_TARGETS, type RenderTarget } from "./adapters/index.ts";
import { applyConfigDiffPlan, createConfigDiffPlan } from "./config/transaction.ts";
import { discoverOpenAICompatibleModels, fingerprintEndpoint } from "./discovery/openai-compatible.ts";
import {
  MANIFEST_EFFORTS,
  assertCapabilityManifest,
  validateCapabilityManifest,
  type CapabilityManifest,
  type ManifestEffort,
} from "./domain/manifest.ts";
import { probeEndpointCapabilities } from "./probes/probe-engine.ts";
import { redactSecrets, registerResolvedSecret, sanitizeError } from "./security.ts";
import {
  computeWritableReasoningEfforts,
  detectDshDeepseekAdapterVersion,
  detectDshVersion,
  getDshAdapterCapabilities,
  getDshDeploymentCapabilities,
  type DshAdapterProviderKind,
} from "./integrations/dsh/capabilities.ts";
import { CREDENTIAL_SOURCE_LABELS, resolveCredential } from "./integrations/dsh/credentials.ts";
import { CATALOG_ENDPOINT_UNRESOLVED_MESSAGE, discoverDshTarget } from "./integrations/dsh/discovery.ts";
import { patchDshSettings } from "./integrations/dsh/patch.ts";
import { loadDshSettings } from "./integrations/dsh/settings.ts";
import type { DshProbeOptions } from "./integrations/dsh/types.ts";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index += 1;
  }
  return { positionals, flags };
}

function stringFlag(parsed: ParsedArgs, name: string, required = false): string | undefined {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return value;
  if (required) throw new Error(`Missing required option --${name}`);
  return undefined;
}

function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) throw new Error(`--${name} must be a positive number`);
  return parsedValue;
}

function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function apiKeyFromEnv(parsed: ParsedArgs): string | undefined {
  const envName = stringFlag(parsed, "api-key-env");
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value) throw new Error(`Environment variable '${envName}' is not set`);
  // Unified secret boundary: resolve -> registerResolvedSecret -> network.
  // Fail-closed: a too-short value throws here, before any network work.
  return registerResolvedSecret(value, { credentialName: envName });
}

async function loadManifest(path: string): Promise<CapabilityManifest> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  assertCapabilityManifest(value);
  return value;
}

/**
 * FINAL OUTPUT SECURITY BOUNDARY.
 *
 * Every user-visible output or persisted artifact leaves ProbeMux through this
 * function (or through writeStdout/writeStderr below): untrusted remote input
 * -> sanitize at the input boundary -> serialize -> FINAL redactSecrets() ->
 * stdout / file. The redaction here is the backstop; input sanitizers are the
 * first line of defence. Internal bytes that feed SHA-256 / apply (settings
 * candidates, diff plans) never pass through this function.
 */
async function writeOutput(content: string, outputPath?: string): Promise<void> {
  const safeContent = redactSecrets(content);
  if (!outputPath) {
    process.stdout.write(safeContent);
    return;
  }
  await writeFile(resolve(outputPath), safeContent, { mode: 0o600 });
  process.stdout.write(redactSecrets(`${resolve(outputPath)}\n`));
}

/** Redacted stdout sink for runtime/remote-data output (help text stays direct). */
function writeStdout(content: string): void {
  process.stdout.write(redactSecrets(content));
}

/** Redacted stderr sink for runtime/remote-data output. */
function writeStderr(content: string): void {
  process.stderr.write(redactSecrets(content));
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) writeStderr(`warning: ${warning}\n`);
}

function help(): string {
  return `ProbeMux v0.1.0-dev — Probe once. Configure everywhere.

Usage:
  probemux scan --base-url <url> [--api-key-env ENV] [--output scan.json]
  probemux probe --base-url <url> --provider-id <id> --model <id> --active [--api-key-env ENV] [--output manifest.json]
  probemux render <manifest.json> --target <codex|opencode|dsh> [--default-effort high] [--output candidate]
  probemux diff --current <config> --candidate <candidate> --plan <plan.json>
  probemux apply --plan <plan.json> --confirm APPLY
  probemux validate <manifest.json>
  probemux dsh inspect [--dsh-home PATH] [--provider ID] [--model ID] [--json]
  probemux dsh probe --active [--dsh-home PATH] [--provider ID] [--model ID] [--output manifest.json]
  probemux dsh sync --active [--default-effort high] [--confirm APPLY] [--dsh-home PATH] [--output manifest.json]

DSH integration:
  dsh discovers DSH_HOME, reads the existing agent-default-model and provider configuration,
  and reuses the credential reference — no Base URL, model, or API key re-entry needed.
  dsh sync patches only VERIFIED model capabilities into settings.yaml (leaf-level) and
  never writes API keys; it requires --active to probe and --confirm APPLY to write.

Safety:
  scan is passive. probe refuses to run without --active and performs at most 12 bounded requests by default.
  render never modifies Agent configuration. diff records file hashes. apply refuses without an unchanged plan,
  creates a timestamped backup, and atomically replaces the reviewed target file.
  API keys are read only from the named environment variable.
`;
}

async function validateCommand(parsed: ParsedArgs): Promise<void> {
  const path = parsed.positionals[0];
  if (!path) throw new Error("validate requires a manifest path");
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  const result = validateCapabilityManifest(value);
  if (!result.valid) throw new Error(`Invalid Capability Manifest:\n- ${result.errors.join("\n- ")}`);
  const manifest = value as CapabilityManifest;
  writeStdout(`Valid Capability Manifest ${manifest.schemaVersion}: ${manifest.identity.providerId}/${manifest.identity.modelId}\n`);
}

async function scanCommand(parsed: ParsedArgs): Promise<void> {
  const baseUrl = stringFlag(parsed, "base-url", true) as string;
  const models = await discoverOpenAICompatibleModels({ baseUrl, apiKey: apiKeyFromEnv(parsed) });
  const result = {
    schemaVersion: "0.1.0",
    kind: "probemux.scan-result",
    endpointFingerprint: fingerprintEndpoint(baseUrl),
    models,
    scannedAt: new Date().toISOString(),
  };
  await writeOutput(`${JSON.stringify(result, null, 2)}\n`, stringFlag(parsed, "output"));
}

async function probeCommand(parsed: ParsedArgs): Promise<void> {
  const manifest = await probeEndpointCapabilities({
    active: booleanFlag(parsed, "active"),
    baseUrl: stringFlag(parsed, "base-url", true) as string,
    providerId: stringFlag(parsed, "provider-id", true) as string,
    modelId: stringFlag(parsed, "model", true) as string,
    apiKey: apiKeyFromEnv(parsed),
    maxRequests: numberFlag(parsed, "max-requests"),
    timeoutMs: numberFlag(parsed, "timeout-ms"),
  });
  await writeOutput(`${JSON.stringify(manifest, null, 2)}\n`, stringFlag(parsed, "output"));
}

async function renderCommand(parsed: ParsedArgs): Promise<void> {
  const path = parsed.positionals[0];
  if (!path) throw new Error("render requires a Capability Manifest path");
  const targetValue = stringFlag(parsed, "target", true);
  if (!RENDER_TARGETS.includes(targetValue as RenderTarget)) throw new Error(`Unsupported target '${targetValue}'`);
  const effortValue = stringFlag(parsed, "default-effort");
  if (effortValue && !MANIFEST_EFFORTS.includes(effortValue as ManifestEffort)) {
    throw new Error(`Unsupported canonical effort '${effortValue}'`);
  }
  const manifest = await loadManifest(path);
  const result = renderManifest(manifest, targetValue as RenderTarget, {
    ...(effortValue ? { defaultEffort: effortValue as ManifestEffort } : {}),
    ...(stringFlag(parsed, "provider-id") ? { providerId: stringFlag(parsed, "provider-id") } : {}),
    ...(stringFlag(parsed, "api-key-env") ? { apiKeyEnv: stringFlag(parsed, "api-key-env") } : {}),
    allowUnverified: booleanFlag(parsed, "allow-unverified"),
  });
  await writeOutput(result.content, stringFlag(parsed, "output"));
  printWarnings([`render safety: ${result.safety}`, ...result.warnings]);
}

async function diffCommand(parsed: ParsedArgs): Promise<void> {
  const planPath = stringFlag(parsed, "plan", true) as string;
  const plan = await createConfigDiffPlan({
    currentPath: stringFlag(parsed, "current", true) as string,
    candidatePath: stringFlag(parsed, "candidate", true) as string,
    planPath,
  });
  writeStdout(plan.diff);
  writeStderr(`plan: ${resolve(planPath)}\n`);
}

async function applyCommand(parsed: ParsedArgs): Promise<void> {
  const result = await applyConfigDiffPlan({
    planPath: stringFlag(parsed, "plan", true) as string,
    confirmation: stringFlag(parsed, "confirm"),
  });
  writeStdout(`${JSON.stringify(result, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(help());
    return;
  }
  const parsed = parseArgs(rest);
  if (command === "scan") return scanCommand(parsed);
  if (command === "probe") return probeCommand(parsed);
  if (command === "render") return renderCommand(parsed);
  if (command === "diff") return diffCommand(parsed);
  if (command === "apply") return applyCommand(parsed);
  if (command === "validate") return validateCommand(parsed);
  if (command === "dsh") return dshCommand(parsed);
  throw new Error(`Unknown command '${command}'`);
}

function dshOptions(parsed: ParsedArgs): DshProbeOptions {
  return {
    dshHome: stringFlag(parsed, "dsh-home"),
    provider: stringFlag(parsed, "provider"),
    model: stringFlag(parsed, "model"),
  };
}

function warnUnavailableCredential(target: { apiKeyEnv?: string; credential: { available: boolean } }): void {
  if (!target.credential.available) {
    writeStderr(`warning: credential '${target.apiKeyEnv ?? "<unset>"}' is not available; probing without authentication.\n`);
  }
}

async function dshInspectCommand(parsed: ParsedArgs): Promise<void> {
  const target = await discoverDshTarget(dshOptions(parsed));
  const baseUrl = target.catalogEndpointUnresolved
    ? "<catalog-derived; not resolved>"
    : (target.baseUrl ?? "<unset>");
  const lines = [
    `DSH home: ${target.home}`,
    `Settings: ${target.settingsPath}`,
    `Provider: ${target.provider}`,
    `Model: ${target.model}`,
    `Base URL: ${baseUrl}`,
    `Protocol hint: ${target.protocolHint}`,
    `Credential ref: ${target.apiKeyEnv ?? "<none>"}`,
    `Credential source: ${CREDENTIAL_SOURCE_LABELS[target.credential.source]}`,
    `Credential available: ${target.credential.available ? "yes" : "no"}`,
    `Provider kind: ${target.providerKind}`,
    `Models state: ${target.modelsState === "explicit" ? "explicit models list" : "catalog route"}`,
    ...(target.reasoningEffort ? [`Current default effort: ${target.reasoningEffort}`] : []),
    ...(target.catalogEndpointUnresolved ? [`Warning: ${CATALOG_ENDPOINT_UNRESOLVED_MESSAGE}`] : []),
  ];
  if (booleanFlag(parsed, "json")) {
    const json = {
      schemaVersion: "0.1.0",
      kind: "probemux.dsh-inspect",
      dshHome: target.home,
      settingsPath: target.settingsPath,
      provider: target.provider,
      model: target.model,
      baseUrl: target.catalogEndpointUnresolved ? null : (target.baseUrl ?? null),
      protocolHint: target.protocolHint,
      apiKeyEnv: target.apiKeyEnv ?? null,
      credentialSource: target.credential.source,
      credentialAvailable: target.credential.available,
      providerKind: target.providerKind,
      modelsState: target.modelsState,
      reasoningEffort: target.reasoningEffort ?? null,
      catalogEndpointUnresolved: target.catalogEndpointUnresolved,
    };
    writeStdout(`${JSON.stringify(json, null, 2)}\n`);
    return;
  }
  writeStdout(`${lines.join("\n")}\n`);
}

async function dshProbeCommand(parsed: ParsedArgs): Promise<void> {
  if (!booleanFlag(parsed, "active")) {
    throw new Error("Active probing is disabled. Re-run with --active after reviewing the possible cost.");
  }
  const target = await discoverDshTarget(dshOptions(parsed));
  if (target.catalogEndpointUnresolved) throw new Error(CATALOG_ENDPOINT_UNRESOLVED_MESSAGE);
  warnUnavailableCredential(target);
  const credentialValue = (await resolveCredential({ apiKeyEnv: target.apiKeyEnv ?? "", dshHome: target.home })).value;
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: target.baseUrl as string,
    providerId: target.provider,
    modelId: target.model,
    apiKey: credentialValue,
    maxRequests: numberFlag(parsed, "max-requests"),
    timeoutMs: numberFlag(parsed, "timeout-ms"),
  });
  await writeOutput(`${JSON.stringify(manifest, null, 2)}\n`, stringFlag(parsed, "output"));
}

async function dshSyncCommand(parsed: ParsedArgs): Promise<void> {
  if (!booleanFlag(parsed, "active")) {
    throw new Error("Active probing is disabled. Re-run with --active after reviewing the possible cost.");
  }
  const effortValue = stringFlag(parsed, "default-effort");
  if (effortValue && !MANIFEST_EFFORTS.includes(effortValue as ManifestEffort)) {
    throw new Error(`Unsupported canonical effort '${effortValue}'`);
  }
  const target = await discoverDshTarget(dshOptions(parsed));
  if (target.catalogEndpointUnresolved) throw new Error(CATALOG_ENDPOINT_UNRESOLVED_MESSAGE);
  warnUnavailableCredential(target);
  const credentialValue = (await resolveCredential({ apiKeyEnv: target.apiKeyEnv ?? "", dshHome: target.home })).value;
  const manifest = await probeEndpointCapabilities({
    active: true,
    baseUrl: target.baseUrl as string,
    providerId: target.provider,
    modelId: target.model,
    apiKey: credentialValue,
    maxRequests: numberFlag(parsed, "max-requests"),
    timeoutMs: numberFlag(parsed, "timeout-ms"),
  });
  const outputPath = stringFlag(parsed, "output");
  if (outputPath) await writeOutput(`${JSON.stringify(manifest, null, 2)}\n`, outputPath);
  // DSH capability constraints: adapter (real @deepseek-ai/dsh-llm-deepseek
  // package version, never the CLI version) ∩ deployment (settings).
  const dshVersion = target.providerKind === "deepseek-official" ? await detectDshVersion(target.home) : undefined;
  const adapterDetection = target.providerKind === "deepseek-official"
    ? await detectDshDeepseekAdapterVersion(target.home)
    : undefined;
  if (adapterDetection?.warning) writeStderr(`warning: ${adapterDetection.warning}\n`);
  // target.providerKind is narrowed at discovery; "unknown" already fell into
  // the deepseek-official branch at runtime, so the cast preserves behaviour.
  const adapterCapabilities = getDshAdapterCapabilities(target.providerKind as DshAdapterProviderKind, adapterDetection?.version);
  const { text: settingsText, settings } = await loadDshSettings(target.settingsPath);
  const deploymentCapabilities = target.providerKind === "deepseek-official"
    ? getDshDeploymentCapabilities(settings["llm-deepseek"])
    : undefined;
  const result = patchDshSettings({
    settingsText,
    target,
    manifest,
    patchOptions: {
      ...(effortValue ? { defaultEffort: effortValue as ManifestEffort } : {}),
      adapterCapabilities,
      ...(deploymentCapabilities ? { deploymentCapabilities } : {}),
    },
  });
  for (const warning of result.warnings) writeStderr(`warning: ${warning}\n`);
  if (target.providerKind === "deepseek-official") {
    const verifiedEfforts = manifest.reasoning.levels
      .filter((level) => level.status === "VERIFIED")
      .map((level) => level.canonical);
    const computation = computeWritableReasoningEfforts({
      verifiedEfforts,
      adapterCapabilities,
      ...(deploymentCapabilities ? { deploymentCapabilities } : {}),
    });
    const adapterAllowed = adapterCapabilities.allowedReasoningEfforts
      ? [...adapterCapabilities.allowedReasoningEfforts].join(", ")
      : "unknown";
    const deploymentAllowed = deploymentCapabilities?.allowedReasoningEfforts
      ? [...deploymentCapabilities.allowedReasoningEfforts].join(", ")
      : deploymentCapabilities?.source === "unknown"
        ? "unknown"
        : "unrestricted";
    const writable = computation.writable.length > 0 ? computation.writable.join(", ") : "none";
    writeStdout(
      [
        "Provider: deepseek-official",
        `DSH CLI version: ${dshVersion ?? "unknown"}`,
        `DeepSeek adapter version: ${adapterDetection?.version ?? "unknown"}`,
        `Adapter version source: ${adapterDetection?.source ?? "n/a"}`,
        `Endpoint verified efforts: ${verifiedEfforts.join(", ") || "(none)"}`,
        `Adapter allowed efforts: ${adapterAllowed}`,
        `Deployment policy: ${deploymentCapabilities?.policy ?? "n/a"}`,
        `Deployment allowed efforts: ${deploymentAllowed}`,
        `Writable efforts: ${writable}`,
        ...(writable === "none" ? ["No reasoning effort changes will be written."] : []),
        "",
      ].join("\n"),
    );
  }
  if (!result.changed) {
    writeStdout("No settings changes required.\n");
    return;
  }
  const planPath = join(target.home, ".probemux-sync-plan.json");
  const candidatePath = join(target.home, ".probemux-sync-candidate.yaml");
  await mkdir(target.home, { recursive: true });
  await writeFile(candidatePath, result.candidateText, { mode: 0o600 });
  const plan = await createConfigDiffPlan({
    currentPath: target.settingsPath,
    candidatePath,
    planPath,
  });
  writeStdout(plan.diff);
  const confirm = stringFlag(parsed, "confirm");
  if (confirm !== "APPLY") {
    writeStdout("\nRe-run with --confirm APPLY to apply this configuration.\n");
    writeStderr(`plan: ${planPath}\n`);
    return;
  }
  const applied = await applyConfigDiffPlan({ planPath, confirmation: confirm });
  writeStdout(`${JSON.stringify(applied, null, 2)}\n`);
  await rm(planPath, { force: true });
  await rm(candidatePath, { force: true });
}

async function dshCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[0];
  if (parsed.flags.get("help") === true || sub === "-h" || sub === "help") {
    process.stdout.write([
      "probe/dsh subcommands:",
      "  dsh inspect [--dsh-home PATH] [--provider ID] [--model ID] [--json]",
      "  dsh probe --active [--dsh-home PATH] [--provider ID] [--model ID] [--output manifest.json]",
      "  dsh sync --active [--default-effort high] [--confirm APPLY] [--dsh-home PATH] [--output manifest.json]",
      "",
    ].join("\n"));
    return;
  }
  if (sub === "inspect") return dshInspectCommand(parsed);
  if (sub === "probe") return dshProbeCommand(parsed);
  if (sub === "sync") return dshSyncCommand(parsed);
  if (!sub) throw new Error("dsh requires a subcommand: inspect | probe | sync");
  throw new Error(`Unknown dsh subcommand '${sub}'`);
}

/**
 * Stable CLI entry used by bin/probemux.ts and by direct node src/cli.ts execution.
 * All error sanitization and exit-code handling lives here so the bin launcher
 * stays a thin shim without duplicated error handling.
 */
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (error) {
    writeStderr(`ProbeMux: ${sanitizeError(error)}\n`);
    return 2;
  }
}

// Direct execution (node src/cli.ts ...); the npm bin path goes through bin/probemux.ts.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await runCli();
}