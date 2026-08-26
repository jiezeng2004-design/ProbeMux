/**
 * Trusted provider endpoint registry.
 *
 * ProbeMux never guesses an endpoint for an llm-pi-ai provider that has no
 * explicit baseURL. The ONLY exception is this small, explicit, auditable
 * registry: provider ids that are unambiguously the same known service are
 * mapped to their canonical endpoint. Providers not listed here stay
 * unresolved (catalogEndpointUnresolved) — fail-closed, never guessed.
 *
 * Evidence for the entries below (all from the real DSH settings.yaml history
 * of this machine, C:\Users\zengjie\.dsh\settings.yaml and its backups):
 * - "opencode": an llm-pi-ai provider that existed WITHOUT an explicit
 *   baseURL (apiKeyEnv OPENCODE_API_KEY, models deepseek-v4-flash-free,
 *   mimo-v2.5-free, nemotron-3-ultra-free). Those are OpenCode Zen free
 *   models; OpenCode Zen's gateway is https://opencode.ai/zen/v1.
 * - "opencode-latest": the same OpenCode Zen provider, renamed, whose current
 *   settings entry carries the explicit baseURL https://opencode.ai/zen/v1 —
 *   confirming the canonical endpoint for the service.
 */

export interface KnownProviderEndpoint {
  /** Exact llm-pi-ai provider id recognized by this registry (never a prefix match). */
  providerId: string;
  /** Canonical endpoint of the known service. */
  baseUrl: string;
  /** Why this mapping is trusted (auditable provenance). */
  note: string;
}

export const KNOWN_PROVIDER_ENDPOINTS: readonly KnownProviderEndpoint[] = [
  {
    providerId: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    note: "OpenCode Zen: settings.yaml history shows an 'opencode' llm-pi-ai provider without baseURL serving OpenCode Zen free models; the canonical gateway is https://opencode.ai/zen/v1.",
  },
  {
    providerId: "opencode-latest",
    baseUrl: "https://opencode.ai/zen/v1",
    note: "OpenCode Zen: the renamed 'opencode-latest' provider carries the explicit baseURL https://opencode.ai/zen/v1 in settings.yaml; the registry keeps it resolvable when that field is absent.",
  },
];

/** Resolve a provider id to its known canonical endpoint; undefined for unknown providers. */
export function resolveKnownProviderEndpoint(providerId: string): KnownProviderEndpoint | undefined {
  return KNOWN_PROVIDER_ENDPOINTS.find((entry) => entry.providerId === providerId);
}
