import { CANONICAL_EFFORTS, type CapabilityObservation, type CanonicalEffort } from "../domain/types.ts";

export type OpenAIProbeProtocol = "responses" | "chat-completions";

export type ProbeClassification =
  | "enumerated"
  | "unsupported"
  | "observed"
  | "accepted-but-unverified"
  | "auth-error"
  | "not-found"
  | "rate-limited"
  | "transient-error"
  | "unclassified-error";

export interface OpenAIReasoningProbeOptions {
  active: boolean;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  protocol: OpenAIProbeProtocol;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  observedAt?: string;
}

export interface OpenAIReasoningProbeResult {
  classification: ProbeClassification;
  httpStatus?: number;
  supportedEfforts: CanonicalEffort[];
  detail: string;
  observation?: CapabilityObservation;
}

const SENTINEL = "__probemux_invalid__";

function resourceUrl(baseUrl: string, protocol: OpenAIProbeProtocol): string {
  const url = new URL(baseUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const suffix = protocol === "responses" ? "responses" : "chat/completions";
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/${suffix}`)) return url.toString();
  if (path.endsWith("/v1")) url.pathname = `${path}/${suffix}`;
  else url.pathname = `${path}/v1/${suffix}`.replace(/\/+/g, "/");
  return url.toString();
}

function buildBody(modelId: string, protocol: OpenAIProbeProtocol): Record<string, unknown> {
  if (protocol === "responses") {
    return {
      model: modelId,
      input: "Reply X",
      max_output_tokens: 1,
      reasoning: { effort: SENTINEL },
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: "Reply X" }],
    max_tokens: 1,
    reasoning_effort: SENTINEL,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(text: string): string {
  const parsed = safeJson(text);
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).message === "string") {
      return String((error as Record<string, unknown>).message);
    }
    if (typeof record.message === "string") return record.message;
  }
  return text;
}

function sanitizeDetail(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

export function extractAllowedEfforts(message: string): CanonicalEffort[] {
  const segments = [
    /supported values (?:are|include)\s*:\s*([^\n.]+)/i,
    /must be one of\s*:\s*([^\n.]+)/i,
    /possible values\s*:\s*([^\n.]+)/i,
    /allowed values\s*:\s*([^\n.]+)/i,
  ];
  const matched = segments.map((pattern) => message.match(pattern)?.[1]).find(Boolean);
  if (!matched) return [];

  return CANONICAL_EFFORTS.filter((effort) => new RegExp(`(?:^|[^a-z])${effort}(?:$|[^a-z])`, "i").test(matched));
}

function hasObservedReasoning(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  const usage = record.usage;
  if (typeof usage === "object" && usage !== null) {
    const outputDetails = (usage as Record<string, unknown>).output_tokens_details;
    const completionDetails = (usage as Record<string, unknown>).completion_tokens_details;
    for (const details of [outputDetails, completionDetails]) {
      if (typeof details === "object" && details !== null && typeof (details as Record<string, unknown>).reasoning_tokens === "number") {
        return true;
      }
    }
  }

  if (Array.isArray(record.output) && record.output.some((item) => (
    typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "reasoning"
  ))) return true;

  if (Array.isArray(record.choices)) {
    return record.choices.some((choice) => {
      if (typeof choice !== "object" || choice === null) return false;
      const message = (choice as Record<string, unknown>).message;
      return typeof message === "object" && message !== null && "reasoning_content" in message;
    });
  }
  return false;
}

function observation(
  options: OpenAIReasoningProbeOptions,
  classification: "enumerated" | "unsupported" | "observed" | "accepted-but-unverified",
  detail: string,
  efforts: CanonicalEffort[],
): CapabilityObservation {
  const protocol = options.protocol === "responses" ? "openai-responses" : "openai-chat-completions";
  const state = classification === "unsupported"
    ? "unsupported"
    : classification === "accepted-but-unverified"
      ? "accepted-but-unverified"
      : "supported";
  return {
    id: `active-probe:${options.modelId}:${options.protocol}:${options.observedAt ?? new Date().toISOString()}`,
    kind: "active-probe",
    source: resourceUrl(options.baseUrl, options.protocol),
    observedAt: options.observedAt ?? new Date().toISOString(),
    confidence: classification === "enumerated" ? 0.95 : classification === "observed" ? 0.9 : 0.7,
    claim: `OpenAI-compatible reasoning probe for ${options.modelId}`,
    outcome: classification === "enumerated"
      ? "rejected-enumerated"
      : classification === "unsupported"
        ? "rejected"
        : classification === "observed"
          ? "observed"
          : "accepted",
    detail,
    reasoning: {
      state,
      ...(efforts.length > 0 ? { effortLevels: efforts.map((canonical) => ({ canonical, wire: canonical })) } : {}),
      wire: {
        protocol,
        effortPath: options.protocol === "responses" ? "reasoning.effort" : "reasoning_effort",
      },
    },
  };
}

export async function probeOpenAIReasoning(options: OpenAIReasoningProbeOptions): Promise<OpenAIReasoningProbeResult> {
  if (!options.active) throw new Error("Active probing is disabled. Re-run with --active after reviewing the possible cost.");

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetchImpl(resourceUrl(options.baseUrl, options.protocol), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(buildBody(options.modelId, options.protocol)),
      signal: controller.signal,
    });
    const text = await response.text();
    const message = sanitizeDetail(errorMessage(text));

    if (response.ok) {
      const classification = hasObservedReasoning(safeJson(text)) ? "observed" : "accepted-but-unverified";
      const detail = classification === "observed"
        ? "The response exposed reasoning usage or metadata."
        : "The request was accepted, but the endpoint may have ignored the invalid effort value.";
      return {
        classification,
        httpStatus: response.status,
        supportedEfforts: [],
        detail,
        observation: observation(options, classification, detail, []),
      };
    }

    if (response.status === 400) {
      const efforts = extractAllowedEfforts(message);
      if (efforts.length > 0) {
        return {
          classification: "enumerated",
          httpStatus: 400,
          supportedEfforts: efforts,
          detail: message,
          observation: observation(options, "enumerated", message, efforts),
        };
      }
      if (/unsupported|unknown parameter|unrecognized|extra inputs are not permitted/i.test(message)) {
        return {
          classification: "unsupported",
          httpStatus: 400,
          supportedEfforts: [],
          detail: message,
          observation: observation(options, "unsupported", message, []),
        };
      }
      return { classification: "unclassified-error", httpStatus: 400, supportedEfforts: [], detail: message };
    }

    if (response.status === 401 || response.status === 403) {
      return { classification: "auth-error", httpStatus: response.status, supportedEfforts: [], detail: message };
    }
    if (response.status === 404) {
      return { classification: "not-found", httpStatus: 404, supportedEfforts: [], detail: message };
    }
    if (response.status === 429) {
      return { classification: "rate-limited", httpStatus: 429, supportedEfforts: [], detail: message };
    }
    if (response.status >= 500) {
      return { classification: "transient-error", httpStatus: response.status, supportedEfforts: [], detail: message };
    }
    return { classification: "unclassified-error", httpStatus: response.status, supportedEfforts: [], detail: message };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError" ? "Probe timed out." : "Probe network failure.";
    return { classification: "transient-error", supportedEfforts: [], detail };
  } finally {
    clearTimeout(timeout);
  }
}
