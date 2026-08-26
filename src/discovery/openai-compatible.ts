import { sanitizeUnknownValue } from "../security.ts";

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
  capabilities?: Record<string, unknown>;
}

export interface DiscoverModelsOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function endpointUrl(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/${resource}`)) return url.toString();
  if (path.endsWith("/v1")) url.pathname = `${path}/${resource}`;
  else url.pathname = `${path}/v1/${resource}`.replace(/\/+/g, "/");
  return url.toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function discoverOpenAICompatibleModels(options: DiscoverModelsOptions): Promise<DiscoveredModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetchImpl(endpointUrl(options.baseUrl, "models"), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isObject(payload) || !Array.isArray(payload.data)) throw new Error("Model discovery response has no data array");

    // Input-boundary sanitize: /models is untrusted remote input. Every field
    // (id, owned_by, capabilities, nested objects, future fields) is run
    // through sanitizeUnknownValue BEFORE business logic sees it, so a
    // malicious service that echoes the Authorization bearer back can never
    // plant it in the scan result. The final writeOutput boundary redacts
    // again as a backstop.
    return payload.data.flatMap((rawEntry): DiscoveredModel[] => {
      if (!isObject(rawEntry)) return [];
      const entry = sanitizeUnknownValue(rawEntry) as Record<string, unknown>;
      if (typeof entry.id !== "string" || !entry.id) return [];
      const model: DiscoveredModel = { id: entry.id };
      if (typeof entry.owned_by === "string") model.ownedBy = entry.owned_by;
      if (isObject(entry.capabilities)) model.capabilities = entry.capabilities;
      return [model];
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function fingerprintEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}