import { CANONICAL_EFFORTS, type CapabilityObservation, type CanonicalEffort, type Protocol } from "../domain/types.ts";

interface ModelsDevLookupOptions {
  providerId: string;
  modelId: string;
  protocol: Protocol;
  observedAt?: string;
  source?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locateModel(catalog: unknown, providerId: string, modelId: string): Record<string, unknown> | null {
  if (!isObject(catalog)) return null;

  const providers = isObject(catalog.providers) ? catalog.providers : catalog;
  const provider = providers[providerId];
  if (!isObject(provider)) return null;
  const models = isObject(provider.models) ? provider.models : provider;
  const direct = models[modelId];
  if (isObject(direct)) return direct;

  for (const candidate of Object.values(models)) {
    if (!isObject(candidate)) continue;
    if (candidate.id === modelId || candidate.canonical_slug === modelId) return candidate;
  }
  return null;
}

function canonicalEfforts(values: unknown): CanonicalEffort[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is CanonicalEffort => (
    typeof value === "string" && CANONICAL_EFFORTS.includes(value as CanonicalEffort)
  ));
}

function defaultEffortPath(protocol: Protocol): string | undefined {
  if (protocol === "openai-responses") return "reasoning.effort";
  if (protocol === "openai-chat-completions") return "reasoning_effort";
  if (protocol === "anthropic-messages") return "output_config.effort";
  if (protocol === "gemini-generate-content") return "generationConfig.thinkingConfig.thinkingLevel";
  return undefined;
}

export function observationFromModelsDev(
  rawCatalog: unknown,
  options: ModelsDevLookupOptions,
): CapabilityObservation | null {
  const model = locateModel(rawCatalog, options.providerId, options.modelId);
  if (!model) return null;

  const rawOptions = Array.isArray(model.reasoning_options)
    ? model.reasoning_options
    : Array.isArray(model.reasoningOptions)
      ? model.reasoningOptions
      : [];

  const efforts: CanonicalEffort[] = [];
  let toggle = false;
  let budgetTokens = false;
  for (const option of rawOptions) {
    if (!isObject(option)) continue;
    if (option.type === "effort") efforts.push(...canonicalEfforts(option.values));
    if (option.type === "toggle") toggle = true;
    if (option.type === "budget_tokens") budgetTokens = true;
  }

  const reasoningState = model.reasoning === true || rawOptions.length > 0
    ? "supported"
    : model.reasoning === false
      ? "unsupported"
      : "unknown";
  const effortPath = efforts.length > 0 ? defaultEffortPath(options.protocol) : undefined;
  return {
    id: `models-dev:${options.providerId}:${options.modelId}`,
    kind: "models-dev",
    source: options.source ?? "https://models.dev/api.json",
    observedAt: options.observedAt ?? new Date().toISOString(),
    confidence: 0.75,
    claim: `models.dev catalog entry for ${options.providerId}/${options.modelId}`,
    outcome: "declared",
    reasoning: {
      state: reasoningState,
      ...(efforts.length > 0
        ? { effortLevels: [...new Set(efforts)].map((canonical) => ({ canonical, wire: canonical })) }
        : {}),
      ...(toggle ? { toggle: { supported: true } } : {}),
      ...(budgetTokens ? { budgetTokens: { supported: true } } : {}),
      wire: {
        protocol: options.protocol,
        ...(effortPath ? { effortPath } : {}),
      },
    },
  };
}
