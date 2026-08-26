import { resolveKnownProviderEndpoint } from "../../discovery/provider-registry.ts";
import { CREDENTIAL_SOURCE_LABELS, resolveCredential } from "./credentials.ts";
import type { CredentialSource, DshSettings } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One row of the DSH discovery listing. Never contains a secret value. */
export interface DshListRow {
  provider: string;
  kind: "deepseek-official" | "llm-pi-ai";
  displayName?: string;
  /** Number of models in the explicit models list; 0 = DSH catalog route. */
  modelCount: number;
  /** The agent-default-model entry for this provider, when it is the default. */
  defaultModel?: string;
  baseUrl?: string;
  /** True when the provider has no explicit baseURL and the catalog cannot be resolved safely. */
  catalogEndpointUnresolved: boolean;
  /** How baseUrl was obtained: explicit settings field, or the trusted provider registry. */
  endpointSource?: "explicit" | "registry";
  apiKeyEnv?: string;
  credentialSource: CredentialSource;
  credentialAvailable: boolean;
}

export interface DshListResult {
  dshHome: string;
  defaultProvider: string;
  defaultModel: string;
  defaultEffort?: string;
  rows: DshListRow[];
}

/**
 * Build the DSH discovery listing: every configured provider (deepseek-official
 * plus every llm-pi-ai.providers entry) with its endpoint state and credential
 * resolution. Read-only: no network, no writes. Credentials are resolved by
 * reference only; the secret itself never enters the result.
 */
export async function buildDshList(settings: DshSettings, dshHome: string): Promise<DshListResult> {
  const def = settings["agent-default-model"];
  const defaultProvider = isObject(def) && typeof def.provider === "string" ? def.provider : undefined;
  const defaultModel = isObject(def) && typeof def.model === "string" ? def.model : undefined;
  const defaultEffort = isObject(def) && typeof def.reasoningEffort === "string" ? def.reasoningEffort : undefined;

  const rows: DshListRow[] = [];

  // deepseek-official is always discoverable: DSH-native provider with a safe default endpoint.
  const deepseek = isObject(settings["llm-deepseek"]) ? settings["llm-deepseek"] : {};
  const deepseekApiKeyEnv = typeof deepseek.apiKeyEnv === "string" && deepseek.apiKeyEnv.trim() !== "" ? deepseek.apiKeyEnv.trim() : "DEEPSEEK_API_KEY";
  const deepseekBaseUrl = typeof deepseek.baseURL === "string" && deepseek.baseURL.trim() !== ""
    ? deepseek.baseURL.trim()
    : process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
  const deepseekCredential = await resolveCredential({ apiKeyEnv: deepseekApiKeyEnv, dshHome });
  rows.push({
    provider: "deepseek-official",
    kind: "deepseek-official",
    modelCount: 0,
    baseUrl: deepseekBaseUrl,
    catalogEndpointUnresolved: false,
    apiKeyEnv: deepseekApiKeyEnv,
    credentialSource: deepseekCredential.source,
    credentialAvailable: deepseekCredential.value !== undefined,
    ...(defaultProvider === "deepseek-official" ? { defaultModel: defaultModel ?? undefined } : {}),
  });

  // llm-pi-ai providers, in settings order.
  const llmpiai = settings["llm-pi-ai"];
  const providers = isObject(llmpiai) && isObject(llmpiai.providers) ? llmpiai.providers : {};
  for (const [providerId, config] of Object.entries(providers)) {
    if (!isObject(config)) continue;
    const explicitBaseUrl = typeof config.baseURL === "string" && config.baseURL.trim() !== "" ? config.baseURL.trim() : undefined;
    // Trusted registry: only explicitly recognized provider ids resolve; unknown providers stay unresolved.
    const registryEntry = explicitBaseUrl === undefined ? resolveKnownProviderEndpoint(providerId) : undefined;
    const baseUrl = explicitBaseUrl ?? registryEntry?.baseUrl;
    const apiKeyEnv = typeof config.apiKeyEnv === "string" && config.apiKeyEnv.trim() !== "" ? config.apiKeyEnv.trim() : undefined;
    const credential = await resolveCredential({ apiKeyEnv: apiKeyEnv ?? "", dshHome });
    rows.push({
      provider: providerId,
      kind: "llm-pi-ai",
      ...(typeof config.displayName === "string" && config.displayName !== "" ? { displayName: config.displayName } : {}),
      modelCount: Array.isArray(config.models) ? config.models.length : 0,
      baseUrl,
      ...(explicitBaseUrl
        ? { endpointSource: "explicit" as const }
        : registryEntry
          ? { endpointSource: "registry" as const }
          : {}),
      catalogEndpointUnresolved: baseUrl === undefined,
      apiKeyEnv,
      credentialSource: credential.source,
      credentialAvailable: credential.value !== undefined,
      ...(defaultProvider === providerId ? { defaultModel: defaultModel ?? undefined } : {}),
    });
  }

  return {
    dshHome,
    defaultProvider: defaultProvider ?? "",
    defaultModel: defaultModel ?? "",
    ...(defaultEffort ? { defaultEffort } : {}),
    rows,
  };
}

/** Human-readable table. Never includes a secret value. */
export function formatDshList(result: DshListResult): string {
  const lines: string[] = [];
  lines.push(`DSH home: ${result.dshHome}`);
  lines.push(
    `Default model: ${result.defaultProvider} / ${result.defaultModel}${result.defaultEffort ? ` (effort=${result.defaultEffort})` : ""}`,
  );
  lines.push("");
  lines.push(
    ["PROVIDER", "KIND", "MODELS", "BASE URL", "CREDENTIAL REF (SOURCE / AVAILABLE)"]
      .map((header) => header.padEnd(18))
      .join(""),
  );
  for (const row of result.rows) {
    const endpoint = row.catalogEndpointUnresolved
      ? "<catalog-derived; not resolved>"
      : (row.baseUrl ?? "<none>") + (row.endpointSource === "registry" ? " (registry)" : "");
    const credential = row.apiKeyEnv
      ? `${row.apiKeyEnv} (${CREDENTIAL_SOURCE_LABELS[row.credentialSource]} / ${row.credentialAvailable ? "yes" : "no"})`
      : "(no apiKeyEnv)";
    lines.push(
      [
        row.provider.padEnd(18),
        row.kind.padEnd(18),
        String(row.modelCount || "-").padEnd(18),
        endpoint,
        "  " + credential,
      ].join(""),
    );
  }
  const unresolved = result.rows.filter((row) => row.catalogEndpointUnresolved);
  if (unresolved.length > 0) {
    lines.push("");
    lines.push(
      `Note: ${unresolved.map((row) => row.provider).join(", ")} ha${unresolved.length === 1 ? "s" : "ve"} no explicit baseURL; ProbeMux will not guess the endpoint.`,
    );
  }
  const unavailable = result.rows.filter((row) => row.apiKeyEnv && !row.credentialAvailable);
  if (unavailable.length > 0) {
    lines.push("");
    lines.push(
      `Hint: no credential found for ${unavailable.map((row) => `'${row.apiKeyEnv}'`).join(", ")}. Add it to DSH API keys or export it, then re-run.`,
    );
  }
  lines.push("");
  lines.push("Next: probemux dsh inspect --provider <id> --model <id>  (or just: probemux dsh inspect)");
  return lines.join("\n");
}

/** Structured JSON view. Never includes a secret value. */
export function dshListJson(result: DshListResult): string {
  return JSON.stringify(
    {
      schemaVersion: "0.1.0",
      kind: "probemux.dsh-list",
      dshHome: result.dshHome,
      defaultModel: {
        provider: result.defaultProvider,
        model: result.defaultModel,
        reasoningEffort: result.defaultEffort ?? null,
      },
      providers: result.rows.map((row) => ({
        provider: row.provider,
        kind: row.kind,
        displayName: row.displayName ?? null,
        modelCount: row.modelCount,
        defaultModel: row.defaultModel ?? null,
        baseUrl: row.catalogEndpointUnresolved ? null : (row.baseUrl ?? null),
        endpointSource: row.endpointSource ?? null,
        apiKeyEnv: row.apiKeyEnv ?? null,
        credentialSource: row.credentialSource,
        credentialAvailable: row.credentialAvailable,
        catalogEndpointUnresolved: row.catalogEndpointUnresolved,
      })),
    },
    null,
    2,
  );
}
