import type { CapabilityManifest, ManifestEffort, ProbeProtocol } from "../domain/manifest.ts";
import { combineSafety, compatibilitySafety, protocolSafety, selectDialect, statusForProtocol } from "./shared.ts";
import type { RenderOptions, RenderResult } from "./types.ts";

export function renderOpenCode(manifest: CapabilityManifest, options: RenderOptions = {}): RenderResult {
  const warnings: string[] = [];
  const protocol: ProbeProtocol = manifest.protocols.responses.status === "VERIFIED" ? "responses" : "chat-completions";
  const protocolResult = protocolSafety(manifest, protocol, warnings);
  const role = compatibilitySafety("system role", statusForProtocol(manifest.messageRoles.system, protocol), warnings);
  const tools = compatibilitySafety("tool calling", statusForProtocol(manifest.toolCalling, protocol), warnings);
  const expectedPath = protocol === "responses" ? "reasoning.effort" : "reasoning_effort";
  const dialect = selectDialect(manifest, protocol, expectedPath, options, warnings);
  const levels = dialect?.levels ?? [];
  const providerId = options.providerId ?? manifest.identity.providerId;
  const apiKeyEnv = options.apiKeyEnv ?? "PROBEMUX_API_KEY";
  const variants: Record<string, Record<string, unknown>> = {};
  const omittedLevels: ManifestEffort[] = [];

  for (const level of levels) {
    if (level.canonical === "off" && level.wireValue === null) {
      variants[level.canonical] = { disabled: true };
      continue;
    }
    if (typeof level.wireValue !== "string") {
      omittedLevels.push(level.canonical);
      continue;
    }
    variants[level.canonical] = { reasoningEffort: level.wireValue };
  }

  let defaultOptions: Record<string, unknown> | undefined;
  if (options.defaultEffort) {
    const selected = levels.find((level) => level.canonical === options.defaultEffort && level.status === "VERIFIED");
    if (!selected || typeof selected.wireValue !== "string") {
      warnings.push(`Requested default '${options.defaultEffort}' cannot be safely expressed as an OpenCode model option; it was omitted.`);
    } else {
      defaultOptions = { reasoningEffort: selected.wireValue };
    }
  }

  const fragment = {
    $schema: "https://opencode.ai/config.json",
    model: `${providerId}/${manifest.identity.modelId}`,
    provider: {
      [providerId]: {
        npm: protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        name: providerId,
        options: {
          baseURL: manifest.identity.endpointFingerprint,
          apiKey: `{env:${apiKeyEnv}}`,
        },
        models: {
          [manifest.identity.modelId]: {
            name: manifest.identity.modelId,
            ...(defaultOptions ? { options: defaultOptions } : {}),
            variants,
          },
        },
      },
    },
  };

  return {
    target: "opencode",
    content: `${JSON.stringify(fragment, null, 2)}\n`,
    warnings,
    omittedLevels,
    safety: combineSafety(protocolResult, role, tools),
  };
}
