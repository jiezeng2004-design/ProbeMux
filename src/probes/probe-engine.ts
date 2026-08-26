import { fingerprintEndpoint } from "../discovery/openai-compatible.ts";
import { redactSecrets } from "../security.ts";
import { extractMinimumTokens, isTokenLowerBoundError, raiseTokenLimit } from "./token-limit.ts";
import {
  MANIFEST_EFFORTS,
  PROBE_PROTOCOLS,
  type CapabilityEvidence,
  type CapabilityFact,
  type CapabilityManifest,
  type CapabilityStatus,
  type CrossProtocolCompatibility,
  type ManifestEffort,
  type ProbeProtocol,
  type ProtocolCapability,
  type ProtocolCompatibility,
  type ReasoningDialectCapability,
  type ReasoningLevelCapability,
} from "../domain/manifest.ts";

export interface ProbeEngineOptions {
  active: boolean;
  baseUrl: string;
  apiKey?: string;
  providerId: string;
  modelId: string;
  timeoutMs?: number;
  maxRequests?: number;
  fetchImpl?: typeof fetch;
  observedAt?: string;
}

interface HttpObservation {
  status?: number;
  payload: unknown;
  message: string;
  networkError?: string;
  /** True when this observation came from a bounded token-lower-bound retry. */
  retriedTokenLowerBound?: boolean;
}

interface EvidenceResult {
  evidence: CapabilityEvidence;
  payload: unknown;
}

const SENTINEL = "__probemux_invalid__";
const DIALECTS: Record<ProbeProtocol, string[]> = {
  responses: ["reasoning.effort", "reasoning_effort"],
  "chat-completions": ["reasoning_effort", "reasoning.effort"],
};

function endpointPath(protocol: ProbeProtocol): "/v1/responses" | "/v1/chat/completions" {
  return protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
}

function endpointUrl(baseUrl: string, protocol: ProbeProtocol): string {
  const url = new URL(baseUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const suffix = protocol === "responses" ? "responses" : "chat/completions";
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/${suffix}`)) return url.toString();
  url.pathname = path.endsWith("/v1") ? `${path}/${suffix}` : `${path}/v1/${suffix}`.replace(/\/+/g, "/");
  return url.toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, text: string): string {
  if (isObject(payload)) {
    if (isObject(payload.error) && typeof payload.error.message === "string") return payload.error.message;
    if (typeof payload.message === "string") return payload.message;
  }
  return text;
}

function sanitizeDetail(value: string): string {
  return redactSecrets(
    value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
      .replace(/[?&](?:api_?key|token|key)=[^\s&]+/gi, "[REDACTED]"),
  ).slice(0, 500);
}

function baselineBody(modelId: string, protocol: ProbeProtocol): Record<string, unknown> {
  if (protocol === "responses") {
    return { model: modelId, input: "Reply with X.", max_output_tokens: 1 };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: "Reply with X." }],
    max_tokens: 1,
  };
}

function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = body;
  for (const part of parts.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    current[part] = next;
    current = next;
  }
  current[parts.at(-1) as string] = value;
}

function reasoningBody(modelId: string, protocol: ProbeProtocol, path: string): Record<string, unknown> {
  const body = baselineBody(modelId, protocol);
  setPath(body, path, SENTINEL);
  return body;
}

function reasoningBodyWithValue(modelId: string, protocol: ProbeProtocol, path: string, value: string): Record<string, unknown> {
  const body = baselineBody(modelId, protocol);
  setPath(body, path, value);
  return body;
}

function roleBody(modelId: string, protocol: ProbeProtocol, role: "system" | "developer"): Record<string, unknown> {
  const messages = [
    { role, content: "Follow the user request." },
    { role: "user", content: "Reply with X." },
  ];
  if (protocol === "responses") return { model: modelId, input: messages, max_output_tokens: 1 };
  return { model: modelId, messages, max_tokens: 1 };
}

function toolBody(modelId: string, protocol: ProbeProtocol): Record<string, unknown> {
  const name = "probemux_echo";
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string", enum: ["X"] } },
  };
  if (protocol === "responses") {
    return {
      model: modelId,
      input: "Call probemux_echo with value X.",
      max_output_tokens: 32,
      tools: [{ type: "function", name, description: "Echo a fixed test value.", parameters, strict: true }],
      tool_choice: { type: "function", name },
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: "Call probemux_echo with value X." }],
    max_tokens: 32,
    tools: [{ type: "function", function: { name, description: "Echo a fixed test value.", parameters, strict: true } }],
    tool_choice: { type: "function", function: { name } },
  };
}

function validResponseShape(payload: unknown, protocol: ProbeProtocol): boolean {
  if (!isObject(payload)) return false;
  if (protocol === "responses") {
    return payload.object === "response" || Array.isArray(payload.output) || typeof payload.output_text === "string";
  }
  return Array.isArray(payload.choices) && payload.choices.some((choice) => isObject(choice) && isObject(choice.message));
}

function hasReasoningSignal(payload: unknown): boolean {
  if (!isObject(payload)) return false;
  if (Array.isArray(payload.output) && payload.output.some((item) => isObject(item) && item.type === "reasoning")) return true;
  if (isObject(payload.usage)) {
    for (const key of ["output_tokens_details", "completion_tokens_details"] as const) {
      const details = payload.usage[key];
      if (isObject(details) && typeof details.reasoning_tokens === "number") return true;
    }
  }
  if (Array.isArray(payload.choices)) {
    return payload.choices.some((choice) => isObject(choice) && isObject(choice.message) && "reasoning_content" in choice.message);
  }
  return false;
}

function hasExpectedToolCall(payload: unknown, protocol: ProbeProtocol): boolean {
  if (!isObject(payload)) return false;
  if (protocol === "responses" && Array.isArray(payload.output)) {
    return payload.output.some((item) => isObject(item) && item.type === "function_call" && item.name === "probemux_echo");
  }
  if (protocol === "chat-completions" && Array.isArray(payload.choices)) {
    return payload.choices.some((choice) => {
      if (!isObject(choice) || !isObject(choice.message) || !Array.isArray(choice.message.tool_calls)) return false;
      return choice.message.tool_calls.some((call) => (
        isObject(call) && isObject(call.function) && call.function.name === "probemux_echo"
      ));
    });
  }
  return false;
}

export function extractManifestEfforts(message: string): ManifestEffort[] {
  const candidates = [
    /supported values (?:are|include)\s*:?\s*([^\n.]+)/i,
    /must be one of\s*:?\s*([^\n.]+)/i,
    /possible values\s*:?\s*([^\n.]+)/i,
    /allowed values\s*:?\s*([^\n.]+)/i,
    /expected one of\s*:?\s*([^\n.]+)/i,
  ];
  const segment = candidates.map((pattern) => message.match(pattern)?.[1]).find(Boolean);
  if (!segment) return [];
  return MANIFEST_EFFORTS.filter((effort) => new RegExp(`(?:^|[^a-z])${effort}(?:$|[^a-z])`, "i").test(segment));
}

function explicitlyUnsupported(message: string, subject: "parameter" | "role" | "tools" | "endpoint"): boolean {
  const lower = message.toLowerCase();
  if (subject === "role") return /(unsupported|invalid|unknown).*role|role.*(unsupported|not supported|invalid)/i.test(message);
  if (subject === "tools") return /(tool|function).*(unsupported|not supported|unknown parameter)|unsupported.*(tool|function)/i.test(message);
  if (subject === "endpoint") return /endpoint.*(not found|unsupported)|method not allowed|unsupported.*endpoint/i.test(message);
  return /unknown parameter|unrecognized (?:field|parameter)|unsupported parameter|extra inputs are not permitted|not permitted/i.test(lower);
}

function aggregateStatus(items: readonly CapabilityFact[]): CapabilityFact {
  for (const status of ["VERIFIED", "LIKELY", "INFERRED"] as const) {
    const matches = items.filter((item) => item.status === status);
    if (matches.length > 0) {
      return {
        status,
        confidence: Math.max(...matches.map((item) => item.confidence)),
        evidenceIds: [...new Set(matches.flatMap((item) => item.evidenceIds))],
      };
    }
  }
  if (items.length > 0 && items.every((item) => item.status === "UNSUPPORTED")) {
    return {
      status: "UNSUPPORTED",
      confidence: Math.max(...items.map((item) => item.confidence)),
      evidenceIds: [...new Set(items.flatMap((item) => item.evidenceIds))],
    };
  }
  return {
    status: "UNKNOWN",
    confidence: items.length > 0 ? Math.max(...items.map((item) => item.confidence)) : 0,
    evidenceIds: [...new Set(items.flatMap((item) => item.evidenceIds))],
  };
}

function crossProtocol(items: ProtocolCompatibility[]): CrossProtocolCompatibility {
  return { ...aggregateStatus(items), byProtocol: items };
}

export async function probeEndpointCapabilities(options: ProbeEngineOptions): Promise<CapabilityManifest> {
  if (!options.active) throw new Error("Active probing is disabled. Re-run with --active after reviewing the possible cost.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const maxRequests = options.maxRequests ?? 12;
  let requestCount = 0;
  let evidenceCounter = 0;
  const evidence: CapabilityEvidence[] = [];
  const conflicts: CapabilityManifest["conflicts"] = [];

  async function doFetch(protocol: ProbeProtocol, body: Record<string, unknown>): Promise<HttpObservation> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const response = await fetchImpl(endpointUrl(options.baseUrl, protocol), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = safeJson(text);
      return { status: response.status, payload, message: sanitizeDetail(errorMessage(payload, text)) };
    } catch (error) {
      const networkError = error instanceof Error && error.name === "AbortError" ? "Probe timed out." : "Probe network failure.";
      return { payload: null, message: networkError, networkError };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function request(protocol: ProbeProtocol, body: Record<string, unknown>): Promise<HttpObservation | undefined> {
    if (requestCount >= maxRequests) return undefined;
    requestCount += 1;
    let observation = await doFetch(protocol, body);
    // Bounded adaptive max_tokens retry: fires ONLY when the endpoint
    // explicitly reports the token limit / request body as too small, raises
    // to the minimum safe value (endpoint-stated minimum honored, floor 3),
    // at most once per request, and still inside the per-model request budget
    // (requestCount is checked again before the retry).
    if (observation.status === 400 && isTokenLowerBoundError(observation.message) && requestCount < maxRequests) {
      requestCount += 1;
      observation = await doFetch(protocol, raiseTokenLimit(body, extractMinimumTokens(observation.message)));
      observation.message = `${observation.message} (retried once after an explicit token-lower-bound error)`;
      observation.retriedTokenLowerBound = true;
    }
    return observation;
  }

  function record(
    protocol: ProbeProtocol,
    probe: CapabilityEvidence["probe"],
    status: CapabilityStatus,
    confidence: number,
    outcome: string,
    detail: string,
    observation?: HttpObservation,
    extra: Pick<CapabilityEvidence, "parameterPath" | "role"> = {},
  ): EvidenceResult {
    evidenceCounter += 1;
    const item: CapabilityEvidence = {
      id: `probe-${String(evidenceCounter).padStart(3, "0")}`,
      probe,
      protocol,
      status,
      confidence,
      observedAt,
      endpointPath: endpointPath(protocol),
      outcome,
      detail: sanitizeDetail(detail),
      ...(observation?.status ? { httpStatus: observation.status } : {}),
      ...extra,
    };
    evidence.push(item);
    return { evidence: item, payload: observation?.payload ?? null };
  }

  const protocols = {} as Record<ProbeProtocol, ProtocolCapability>;
  for (const protocol of PROBE_PROTOCOLS) {
    const observation = await request(protocol, baselineBody(options.modelId, protocol));
    let status: CapabilityStatus = "UNKNOWN";
    let confidence = 0.2;
    let outcome = "not-probed";
    let detail = "Request budget exhausted before the protocol probe ran.";
    if (observation) {
      if (observation.status && observation.status >= 200 && observation.status < 300 && validResponseShape(observation.payload, protocol)) {
        status = "VERIFIED";
        confidence = 0.99;
        outcome = "structured-response";
        detail = "The endpoint returned a protocol-conformant structured response to the baseline request." + (observation.retriedTokenLowerBound
          ? " The baseline was retried once after an explicit token-lower-bound error."
          : "");
      } else if ((observation.status === 404 || observation.status === 405) && !/model.*not found|unknown model/i.test(observation.message)) {
        status = "UNSUPPORTED";
        confidence = 0.9;
        outcome = "endpoint-rejected";
        detail = observation.message || "The endpoint rejected this protocol path.";
      } else if (observation.status && observation.status >= 200 && observation.status < 300) {
        outcome = "invalid-response-shape";
        detail = "HTTP success did not contain the expected protocol response structure.";
      } else {
        outcome = observation.networkError ? "network-error" : "inconclusive-error";
        detail = observation.message || "The baseline probe was inconclusive.";
      }
    }
    const result = record(protocol, "protocol", status, confidence, outcome, detail, observation);
    protocols[protocol] = {
      protocol,
      endpointPath: endpointPath(protocol),
      status,
      confidence,
      evidenceIds: [result.evidence.id],
    };
  }

  const dialects: ReasoningDialectCapability[] = [];
  for (const protocol of PROBE_PROTOCOLS) {
    for (const parameterPath of DIALECTS[protocol]) {
      if (protocols[protocol].status !== "VERIFIED") {
        dialects.push({
          protocol,
          parameterPath,
          status: "UNKNOWN",
          confidence: 0,
          evidenceIds: [],
          levels: [],
        });
        continue;
      }
      const observation = await request(protocol, reasoningBody(options.modelId, protocol, parameterPath));
      let status: CapabilityStatus = "UNKNOWN";
      let confidence = 0.2;
      let outcome = "not-probed";
      let detail = "Request budget exhausted before the reasoning dialect probe ran.";
      let efforts: ManifestEffort[] = [];
      let sentinelStatus: CapabilityStatus = "UNKNOWN";
      let sentinelOutcome = "not-probed";
      let sentinelDetail = detail;
      let contrastResult: EvidenceResult | undefined;
      if (observation) {
        efforts = extractManifestEfforts(observation.message);
        if (observation.status === 400 && efforts.length > 0) {
          sentinelStatus = status = "VERIFIED";
          sentinelOutcome = outcome = "validator-enumerated-values";
          sentinelDetail = detail = observation.message;
          confidence = 0.98;
        } else if (observation.status === 400 && explicitlyUnsupported(observation.message, "parameter")) {
          sentinelStatus = status = "UNSUPPORTED";
          sentinelOutcome = outcome = "parameter-rejected";
          sentinelDetail = detail = observation.message;
          confidence = 0.95;
        } else if (observation.status && observation.status >= 200 && observation.status < 300 && validResponseShape(observation.payload, protocol) && hasReasoningSignal(observation.payload)) {
          sentinelStatus = status = "LIKELY";
          sentinelOutcome = outcome = "accepted-with-reasoning-signal";
          sentinelDetail = detail = "The request returned reasoning metadata, but the invalid sentinel may have been ignored; no effort level is VERIFIED.";
          confidence = 0.75;
        } else if (observation.status && observation.status >= 200 && observation.status < 300) {
          sentinelOutcome = outcome = "accepted-without-proof";
          sentinelDetail = detail = "The request was accepted, but neither validation nor behavioral evidence proved that the parameter was applied.";
        } else {
          sentinelOutcome = outcome = observation.networkError ? "network-error" : "inconclusive-error";
          sentinelDetail = detail = observation.message || "The reasoning dialect probe was inconclusive.";
        }

        // Valid/invalid effort contrast (Kimi-style discrimination): the
        // endpoint ACCEPTED the invalid sentinel, so no validation evidence
        // exists yet. ONE minimal contrast request with a valid effort value
        // (bounded by the same per-model budget) distinguishes:
        //   - valid value rejected with enumeration  -> VERIFIED levels
        //   - valid value rejected as unknown param -> UNSUPPORTED
        //   - valid value accepted + reasoning meta -> LIKELY for that level
        //   - valid value accepted, no signal      -> still UNKNOWN (ignored?)
        if (observation.status && observation.status >= 200 && observation.status < 300) {
          const contrast = await request(protocol, reasoningBodyWithValue(options.modelId, protocol, parameterPath, "high"));
          if (contrast) {
            const contrastEfforts = extractManifestEfforts(contrast.message);
            if (contrast.status === 400 && contrastEfforts.length > 0) {
              status = "VERIFIED";
              confidence = 0.98;
              outcome = "validator-enumerated-values";
              detail = contrast.message;
              efforts = contrastEfforts;
            } else if (contrast.status === 400 && explicitlyUnsupported(contrast.message, "parameter")) {
              status = "UNSUPPORTED";
              confidence = 0.9;
              outcome = "parameter-rejected";
              detail = contrast.message;
            } else if (contrast.status && contrast.status >= 200 && contrast.status < 300 && validResponseShape(contrast.payload, protocol) && hasReasoningSignal(contrast.payload)) {
              status = "LIKELY";
              confidence = 0.8;
              outcome = "accepted-with-reasoning-signal";
              detail = "The invalid sentinel and a valid effort value were both accepted; the response exposed reasoning metadata, so the probed effort is LIKELY (no server-side enumeration).";
            } else if (contrast.status && contrast.status >= 200 && contrast.status < 300) {
              outcome = "accepted-without-proof";
              detail = "Both the invalid sentinel and a valid effort value were accepted without reasoning metadata; the parameter may be ignored.";
            }
            contrastResult = record(protocol, "reasoning-dialect", status, confidence, "contrast-valid-effort", detail, contrast, { parameterPath });
          }
        }
      }
      const result = record(protocol, "reasoning-dialect", sentinelStatus, confidence, sentinelOutcome, sentinelDetail, observation, { parameterPath });
      const evidenceIds = contrastResult
        ? [...new Set([result.evidence.id, contrastResult.evidence.id])]
        : [result.evidence.id];
      const levels: ReasoningLevelCapability[] = efforts.length > 0
        ? efforts.map((canonical) => ({
            canonical,
            wireValue: canonical,
            status: "VERIFIED",
            confidence: 0.98,
            evidenceIds,
          }))
        : contrastResult && status === "LIKELY"
          ? [{ canonical: "high", wireValue: "high", status: "LIKELY", confidence: 0.8, evidenceIds }]
          : [];
      dialects.push({ protocol, parameterPath, status, confidence, evidenceIds, levels });
    }
  }

  const roleResults: Record<"system" | "developer", ProtocolCompatibility[]> = { system: [], developer: [] };
  for (const role of ["system", "developer"] as const) {
    for (const protocol of PROBE_PROTOCOLS) {
      if (protocols[protocol].status !== "VERIFIED") {
        roleResults[role].push({ protocol, status: "UNKNOWN", confidence: 0, evidenceIds: [] });
        continue;
      }
      const observation = await request(protocol, roleBody(options.modelId, protocol, role));
      let status: CapabilityStatus = "UNKNOWN";
      let confidence = 0.2;
      let outcome = "not-probed";
      let detail = "Request budget exhausted before the message-role probe ran.";
      if (observation) {
        if (observation.status && observation.status >= 200 && observation.status < 300 && validResponseShape(observation.payload, protocol)) {
          status = "VERIFIED";
          confidence = 0.97;
          outcome = "structured-response";
          detail = `The endpoint accepted the ${role} role and returned a protocol-conformant response; semantic adherence was not evaluated.`;
        } else if (observation.status === 400 && explicitlyUnsupported(observation.message, "role")) {
          status = "UNSUPPORTED";
          confidence = 0.95;
          outcome = "role-rejected";
          detail = observation.message;
        } else {
          outcome = observation.networkError ? "network-error" : "inconclusive-error";
          detail = observation.message || `The ${role} role probe was inconclusive.`;
        }
      }
      const result = record(protocol, "message-role", status, confidence, outcome, detail, observation, { role });
      roleResults[role].push({ protocol, status, confidence, evidenceIds: [result.evidence.id] });
    }
  }

  const toolResults: ProtocolCompatibility[] = [];
  for (const protocol of PROBE_PROTOCOLS) {
    if (protocols[protocol].status !== "VERIFIED") {
      toolResults.push({ protocol, status: "UNKNOWN", confidence: 0, evidenceIds: [] });
      continue;
    }
    const observation = await request(protocol, toolBody(options.modelId, protocol));
    let status: CapabilityStatus = "UNKNOWN";
    let confidence = 0.2;
    let outcome = "not-probed";
    let detail = "Request budget exhausted before the tool-calling probe ran.";
    if (observation) {
      if (observation.status && observation.status >= 200 && observation.status < 300 && validResponseShape(observation.payload, protocol) && hasExpectedToolCall(observation.payload, protocol)) {
        status = "VERIFIED";
        confidence = 0.99;
        outcome = "expected-tool-call";
        detail = "The endpoint returned the forced function call with the expected function name.";
      } else if (observation.status === 400 && explicitlyUnsupported(observation.message, "tools")) {
        status = "UNSUPPORTED";
        confidence = 0.95;
        outcome = "tools-rejected";
        detail = observation.message;
      } else if (observation.status && observation.status >= 200 && observation.status < 300) {
        outcome = "accepted-without-tool-call";
        detail = "HTTP success did not contain the forced tool call, so tool compatibility remains UNKNOWN.";
      } else {
        outcome = observation.networkError ? "network-error" : "inconclusive-error";
        detail = observation.message || "The tool-calling probe was inconclusive.";
      }
    }
    const result = record(protocol, "tool-calling", status, confidence, outcome, detail, observation);
    toolResults.push({ protocol, status, confidence, evidenceIds: [result.evidence.id] });
  }

  const overallLevels = new Map<ManifestEffort, ReasoningLevelCapability>();
  for (const dialect of dialects.filter((item) => item.status === "VERIFIED")) {
    for (const level of dialect.levels) {
      const existing = overallLevels.get(level.canonical);
      if (!existing) {
        overallLevels.set(level.canonical, { ...level });
      } else if (existing.wireValue !== level.wireValue) {
        conflicts.push({
          field: `reasoning.levels.${level.canonical}.wireValue`,
          evidenceIds: [...new Set([...existing.evidenceIds, ...level.evidenceIds])],
          detail: `Verified dialects reported different wire values for '${level.canonical}'.`,
        });
      } else {
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...level.evidenceIds])];
        existing.confidence = Math.max(existing.confidence, level.confidence);
      }
    }
  }
  const reasoningFact = aggregateStatus(dialects);
  const system = crossProtocol(roleResults.system);
  const developer = crossProtocol(roleResults.developer);
  const toolCalling = crossProtocol(toolResults);

  return {
    schemaVersion: "0.1.0",
    kind: "probemux.capability-manifest",
    identity: {
      providerId: options.providerId,
      modelId: options.modelId,
      endpointFingerprint: fingerprintEndpoint(options.baseUrl),
    },
    protocols,
    reasoning: {
      ...reasoningFact,
      levels: MANIFEST_EFFORTS.flatMap((effort) => {
        const level = overallLevels.get(effort);
        return level ? [level] : [];
      }),
      dialects,
    },
    messageRoles: { system, developer },
    toolCalling,
    evidence,
    conflicts,
    generatedAt: observedAt,
  };
}
