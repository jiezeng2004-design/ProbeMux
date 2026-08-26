import type { CapabilityManifest, ManifestEffort } from "../domain/manifest.ts";
import { combineSafety, compatibilitySafety, protocolSafety, requestedDefault, selectDialect, statusForProtocol } from "./shared.ts";
import type { RenderOptions, RenderResult } from "./types.ts";

const CODEX_PERSISTED_EFFORTS: readonly ManifestEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderCodex(manifest: CapabilityManifest, options: RenderOptions = {}): RenderResult {
  const warnings: string[] = [];
  const protocol = protocolSafety(manifest, "responses", warnings);
  const developerRole = compatibilitySafety("developer role", statusForProtocol(manifest.messageRoles.developer, "responses"), warnings);
  const tools = compatibilitySafety("tool calling", statusForProtocol(manifest.toolCalling, "responses"), warnings);
  const dialect = selectDialect(manifest, "responses", "reasoning.effort", options, warnings);
  const sourceLevels = dialect?.levels ?? [];
  const defaultEffort = requestedDefault(sourceLevels, options, CODEX_PERSISTED_EFFORTS, warnings);
  const providerId = options.providerId ?? manifest.identity.providerId;
  const apiKeyEnv = options.apiKeyEnv ?? "PROBEMUX_API_KEY";

  const lines = [
    `model = ${tomlString(manifest.identity.modelId)}`,
    `model_provider = ${tomlString(providerId)}`,
  ];
  if (defaultEffort) lines.push(`model_reasoning_effort = ${tomlString(defaultEffort)}`);
  lines.push(
    "",
    `[model_providers.${tomlString(providerId)}]`,
    `name = ${tomlString(providerId)}`,
    `base_url = ${tomlString(manifest.identity.endpointFingerprint)}`,
    `env_key = ${tomlString(apiKeyEnv)}`,
    `wire_api = "responses"`,
  );

  const omittedLevels = sourceLevels
    .map((level) => level.canonical)
    .filter((effort) => !CODEX_PERSISTED_EFFORTS.includes(effort));
  if (omittedLevels.length > 0) {
    warnings.push(`Codex persistent config does not express these profile levels: ${omittedLevels.join(", ")}.`);
  }

  return {
    target: "codex",
    content: `${lines.join("\n")}\n`,
    warnings,
    omittedLevels,
    safety: combineSafety(protocol, developerRole, tools),
  };
}
