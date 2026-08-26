import type { CapabilityManifest, ManifestEffort, ProbeProtocol, ReasoningLevelCapability } from "../domain/manifest.ts";
import { combineSafety, compatibilitySafety, protocolSafety, selectDialect, statusForProtocol } from "./shared.ts";
import type { RenderOptions, RenderResult } from "./types.ts";

const DSH_LABELS: readonly ManifestEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function dshLabel(level: ReasoningLevelCapability): ManifestEffort {
  return level.canonical === "none" ? "off" : level.canonical;
}

export function renderDsh(manifest: CapabilityManifest, options: RenderOptions = {}): RenderResult {
  const warnings: string[] = [];
  const protocol: ProbeProtocol = manifest.protocols["chat-completions"].status === "VERIFIED" ? "chat-completions" : "responses";
  const protocolResult = protocolSafety(manifest, protocol, warnings);
  const developerRole = compatibilitySafety("developer role", statusForProtocol(manifest.messageRoles.developer, protocol), warnings);
  const tools = compatibilitySafety("tool calling", statusForProtocol(manifest.toolCalling, protocol), warnings);
  const expectedPath = protocol === "responses" ? "reasoning.effort" : "reasoning_effort";
  const dialect = selectDialect(manifest, protocol, expectedPath, options, warnings);
  const sourceLevels = dialect?.levels ?? [];
  const mapped = new Map<ManifestEffort, ReasoningLevelCapability>();

  for (const level of sourceLevels) {
    const label = dshLabel(level);
    if (!DSH_LABELS.includes(label)) continue;
    if (mapped.has(label)) {
      warnings.push(`Both '${mapped.get(label)?.canonical}' and '${level.canonical}' map to DSH '${label}'; the higher-priority profile order won.`);
      continue;
    }
    mapped.set(label, level);
  }

  const providerId = options.providerId ?? manifest.identity.providerId;
  const apiKeyEnv = options.apiKeyEnv ?? "PROBEMUX_API_KEY";
  const lines = [
    "llm-pi-ai:",
    "  providers:",
    `    ${JSON.stringify(providerId)}:`,
    `      displayName: ${JSON.stringify(providerId)}`,
    `      baseURL: ${JSON.stringify(manifest.identity.endpointFingerprint)}`,
    `      apiKeyEnv: ${JSON.stringify(apiKeyEnv)}`,
    `      api: ${JSON.stringify(protocol === "responses" ? "openai-responses" : "openai-completions")}`,
    "      models:",
    `        - id: ${JSON.stringify(manifest.identity.modelId)}`,
  ];

  if (mapped.size > 0) {
    lines.push("          reasoningEfforts:");
    for (const label of DSH_LABELS) {
      const level = mapped.get(label);
      if (!level) continue;
      lines.push(`            ${label}: ${yamlScalar(level.wireValue)}`);
    }
  }

  if (options.defaultEffort) {
    const selected = sourceLevels.find((level) => level.canonical === options.defaultEffort && level.status === "VERIFIED");
    if (!selected) {
      warnings.push(`Requested default '${options.defaultEffort}' is not VERIFIED for the selected DSH protocol; it was omitted.`);
    } else {
      const label = dshLabel(selected);
      lines.push(
        "",
        "agent-default-model:",
        `  provider: ${JSON.stringify(providerId)}`,
        `  model: ${JSON.stringify(manifest.identity.modelId)}`,
        `  reasoningEffort: ${JSON.stringify(label)}`,
      );
    }
  }

  const omittedLevels = sourceLevels
    .map((level) => level.canonical)
    .filter((level) => !DSH_LABELS.includes(level) && level !== "none");
  return {
    target: "dsh",
    content: `${lines.join("\n")}\n`,
    warnings,
    omittedLevels,
    safety: combineSafety(protocolResult, developerRole, tools),
  };
}
