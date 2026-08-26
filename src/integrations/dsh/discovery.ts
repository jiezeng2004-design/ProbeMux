import { resolveCredential } from "./credentials.ts";
import { dshCredentialsPath, dshSettingsPath, resolveDshHome } from "./home.ts";
import { findProvider, getDefaultModel, loadDshSettings } from "./settings.ts";
import type {
  CredentialResolution,
  DshDeepseekSection,
  DshLlmpiaiProvider,
  DshProbeOptions,
  DshTarget,
  ProtocolHint,
} from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Discover the DSH installation and resolve the current target:
 * DSH_HOME -> settings.yaml -> agent-default-model -> provider config
 * -> endpoint -> credential reference (never the secret itself).
 *
 * Honors --dsh-home / --provider / --model overrides without requiring the
 * user to re-enter anything DSH already knows.
 */
export async function discoverDshTarget(options: DshProbeOptions = {}): Promise<DshTarget> {
  const home = resolveDshHome(options.dshHome);
  const settingsPath = dshSettingsPath(home);
  const credentialsPath = dshCredentialsPath(home);

  const { settings } = await loadDshSettings(settingsPath);
  const def = getDefaultModel(settings);
  const providerId = options.provider ?? def.provider;
  const modelId = options.model ?? def.model;

  const found = findProvider(settings, providerId);
  if (found.kind === "unknown") {
    throw new Error(`DSH provider '${providerId}' is not configured. Expected llm-pi-ai.providers.${providerId} or llm-deepseek for 'deepseek-official'.`);
  }

  let baseUrl: string | undefined;
  let catalogEndpointUnresolved = false;
  let protocolHint: ProtocolHint = "unknown";
  let apiKeyEnv: string | undefined;
  let modelsState: "explicit" | "catalog" = "catalog";
  let targetInModels = false;

  if (found.kind === "llm-pi-ai") {
    const config = found.config as DshLlmpiaiProvider;
    const configuredBaseUrl = typeof config.baseURL === "string" && config.baseURL.trim() !== "" ? config.baseURL.trim() : undefined;
    if (configuredBaseUrl) {
      baseUrl = configuredBaseUrl;
    } else {
      catalogEndpointUnresolved = true;
    }
    if (config.api === "openai-completions") protocolHint = "openai-completions";
    else if (config.api === "openai-responses") protocolHint = "openai-responses";
    if (typeof config.apiKeyEnv === "string" && config.apiKeyEnv.trim() !== "") apiKeyEnv = config.apiKeyEnv.trim();
    if (Array.isArray(config.models)) {
      modelsState = "explicit";
      targetInModels = config.models.some((entry) => isObject(entry) && entry.id === modelId);
    }
  } else {
    // deepseek-official: DSH-native provider. Endpoint is configurable but has a safe default.
    const config = (found.config ?? {}) as DshDeepseekSection;
    apiKeyEnv = typeof config.apiKeyEnv === "string" && config.apiKeyEnv.trim() !== "" ? config.apiKeyEnv.trim() : "DEEPSEEK_API_KEY";
    baseUrl = typeof config.baseURL === "string" && config.baseURL.trim() !== "" ? config.baseURL.trim() : process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
    protocolHint = "openai-completions";
  }

  const resolvedCredential = await resolveCredential({
    apiKeyEnv: apiKeyEnv ?? "",
    dshHome: home,
  });
  const credential: CredentialResolution = {
    ref: apiKeyEnv ?? "",
    source: resolvedCredential.source,
    available: resolvedCredential.value !== undefined,
  };

  return {
    home,
    settingsPath,
    credentialsPath,
    provider: providerId,
    model: modelId,
    reasoningEffort: def.reasoningEffort,
    providerKind: found.kind,
    source: found.source,
    baseUrl,
    protocolHint,
    apiKeyEnv,
    credential,
    modelsState,
    targetInModels,
    catalogEndpointUnresolved,
  };
}

/** Message used whenever a catalog-derived endpoint cannot be resolved safely. */
export const CATALOG_ENDPOINT_UNRESOLVED_MESSAGE =
  "DSH provider found, but its effective endpoint is catalog-derived and ProbeMux cannot resolve it safely yet.";