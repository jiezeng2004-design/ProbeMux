export const CAPABILITY_STATUSES = [
  "VERIFIED",
  "LIKELY",
  "INFERRED",
  "UNKNOWN",
  "UNSUPPORTED",
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const PROBE_PROTOCOLS = ["responses", "chat-completions"] as const;
export type ProbeProtocol = (typeof PROBE_PROTOCOLS)[number];

export const MANIFEST_EFFORTS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ManifestEffort = (typeof MANIFEST_EFFORTS)[number];
export type ProbeKind = "protocol" | "reasoning-dialect" | "message-role" | "tool-calling";

export interface CapabilityFact {
  status: CapabilityStatus;
  confidence: number;
  evidenceIds: string[];
}

export interface ProtocolCapability extends CapabilityFact {
  protocol: ProbeProtocol;
  endpointPath: "/v1/responses" | "/v1/chat/completions";
}

export interface ReasoningLevelCapability extends CapabilityFact {
  canonical: ManifestEffort;
  wireValue: string | number | boolean | null;
}

export interface ReasoningDialectCapability extends CapabilityFact {
  protocol: ProbeProtocol;
  parameterPath: string;
  levels: ReasoningLevelCapability[];
}

export interface ReasoningCapability extends CapabilityFact {
  levels: ReasoningLevelCapability[];
  dialects: ReasoningDialectCapability[];
}

export interface ProtocolCompatibility extends CapabilityFact {
  protocol: ProbeProtocol;
}

export interface CrossProtocolCompatibility extends CapabilityFact {
  byProtocol: ProtocolCompatibility[];
}

export interface CapabilityEvidence {
  id: string;
  probe: ProbeKind;
  protocol: ProbeProtocol;
  status: CapabilityStatus;
  confidence: number;
  observedAt: string;
  endpointPath: string;
  outcome: string;
  detail: string;
  httpStatus?: number;
  parameterPath?: string;
  role?: "system" | "developer";
}

export interface CapabilityConflict {
  field: string;
  evidenceIds: string[];
  detail: string;
}

export interface CapabilityManifest {
  schemaVersion: "0.1.0";
  kind: "probemux.capability-manifest";
  identity: {
    providerId: string;
    modelId: string;
    endpointFingerprint: string;
  };
  protocols: Record<ProbeProtocol, ProtocolCapability>;
  reasoning: ReasoningCapability;
  messageRoles: {
    system: CrossProtocolCompatibility;
    developer: CrossProtocolCompatibility;
  };
  toolCalling: CrossProtocolCompatibility;
  evidence: CapabilityEvidence[];
  conflicts: CapabilityConflict[];
  generatedAt: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFact(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!CAPABILITY_STATUSES.includes(value.status as CapabilityStatus)) errors.push(`${path}.status is invalid`);
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    errors.push(`${path}.confidence must be between 0 and 1`);
  }
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some((item) => typeof item !== "string")) {
    errors.push(`${path}.evidenceIds must be an array of strings`);
  }
}

function validateLevel(value: unknown, path: string, errors: string[]): void {
  validateFact(value, path, errors);
  if (!isObject(value)) return;
  if (!MANIFEST_EFFORTS.includes(value.canonical as ManifestEffort)) errors.push(`${path}.canonical is invalid`);
  if (value.wireValue !== null && !["string", "number", "boolean"].includes(typeof value.wireValue)) {
    errors.push(`${path}.wireValue must be primitive or null`);
  }
}

function validateCrossProtocol(value: unknown, path: string, errors: string[]): void {
  validateFact(value, path, errors);
  if (!isObject(value)) return;
  if (!Array.isArray(value.byProtocol)) {
    errors.push(`${path}.byProtocol must be an array`);
    return;
  }
  for (const [index, item] of value.byProtocol.entries()) {
    validateFact(item, `${path}.byProtocol[${index}]`, errors);
    if (isObject(item) && !PROBE_PROTOCOLS.includes(item.protocol as ProbeProtocol)) {
      errors.push(`${path}.byProtocol[${index}].protocol is invalid`);
    }
  }
}

function collectEvidenceReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceReferences(item, references);
    return;
  }
  if (!isObject(value)) return;
  if (Array.isArray(value.evidenceIds)) {
    for (const id of value.evidenceIds) if (typeof id === "string") references.add(id);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "evidence" && key !== "evidenceIds") collectEvidenceReferences(item, references);
  }
}

export function validateCapabilityManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { valid: false, errors: ["manifest must be an object"] };
  if (value.schemaVersion !== "0.1.0") errors.push("schemaVersion must be '0.1.0'");
  if (value.kind !== "probemux.capability-manifest") errors.push("kind must be 'probemux.capability-manifest'");

  if (!isObject(value.identity)) {
    errors.push("identity must be an object");
  } else {
    for (const key of ["providerId", "modelId", "endpointFingerprint"] as const) {
      if (typeof value.identity[key] !== "string" || !value.identity[key]) errors.push(`identity.${key} is required`);
    }
  }

  if (!isObject(value.protocols)) {
    errors.push("protocols must be an object");
  } else {
    for (const protocol of PROBE_PROTOCOLS) {
      const item = value.protocols[protocol];
      validateFact(item, `protocols.${protocol}`, errors);
      if (isObject(item) && item.protocol !== protocol) errors.push(`protocols.${protocol}.protocol must equal '${protocol}'`);
    }
  }

  if (!isObject(value.reasoning)) {
    errors.push("reasoning must be an object");
  } else {
    validateFact(value.reasoning, "reasoning", errors);
    if (!Array.isArray(value.reasoning.levels)) {
      errors.push("reasoning.levels must be an array");
    } else {
      for (const [index, level] of value.reasoning.levels.entries()) validateLevel(level, `reasoning.levels[${index}]`, errors);
    }
    if (!Array.isArray(value.reasoning.dialects)) {
      errors.push("reasoning.dialects must be an array");
    } else {
      for (const [index, dialect] of value.reasoning.dialects.entries()) {
        const path = `reasoning.dialects[${index}]`;
        validateFact(dialect, path, errors);
        if (!isObject(dialect)) continue;
        if (!PROBE_PROTOCOLS.includes(dialect.protocol as ProbeProtocol)) errors.push(`${path}.protocol is invalid`);
        if (typeof dialect.parameterPath !== "string" || !dialect.parameterPath) errors.push(`${path}.parameterPath is required`);
        if (!Array.isArray(dialect.levels)) {
          errors.push(`${path}.levels must be an array`);
        } else {
          for (const [levelIndex, level] of dialect.levels.entries()) validateLevel(level, `${path}.levels[${levelIndex}]`, errors);
        }
      }
    }
  }

  if (!isObject(value.messageRoles)) {
    errors.push("messageRoles must be an object");
  } else {
    validateCrossProtocol(value.messageRoles.system, "messageRoles.system", errors);
    validateCrossProtocol(value.messageRoles.developer, "messageRoles.developer", errors);
  }
  validateCrossProtocol(value.toolCalling, "toolCalling", errors);

  const knownEvidenceIds = new Set<string>();
  if (!Array.isArray(value.evidence)) {
    errors.push("evidence must be an array");
  } else {
    for (const [index, item] of value.evidence.entries()) {
      const path = `evidence[${index}]`;
      if (!isObject(item)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (typeof item.id !== "string" || !item.id) errors.push(`${path}.id is required`);
      else if (knownEvidenceIds.has(item.id)) errors.push(`${path}.id is duplicated`);
      else knownEvidenceIds.add(item.id);
      if (!["protocol", "reasoning-dialect", "message-role", "tool-calling"].includes(String(item.probe))) {
        errors.push(`${path}.probe is invalid`);
      }
      if (!PROBE_PROTOCOLS.includes(item.protocol as ProbeProtocol)) errors.push(`${path}.protocol is invalid`);
      if (!CAPABILITY_STATUSES.includes(item.status as CapabilityStatus)) errors.push(`${path}.status is invalid`);
      if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) {
        errors.push(`${path}.confidence must be between 0 and 1`);
      }
      if (typeof item.observedAt !== "string" || Number.isNaN(Date.parse(item.observedAt))) {
        errors.push(`${path}.observedAt must be an ISO date string`);
      }
      if (typeof item.detail !== "string" || item.detail.length > 500) errors.push(`${path}.detail must be at most 500 characters`);
    }
  }
  if (!Array.isArray(value.conflicts)) errors.push("conflicts must be an array");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    errors.push("generatedAt must be an ISO date string");
  }
  const references = new Set<string>();
  collectEvidenceReferences(value, references);
  for (const id of references) {
    if (!knownEvidenceIds.has(id)) errors.push(`evidenceIds references missing evidence '${id}'`);
  }
  return { valid: errors.length === 0, errors };
}

export function assertCapabilityManifest(value: unknown): asserts value is CapabilityManifest {
  const result = validateCapabilityManifest(value);
  if (!result.valid) throw new Error(`Invalid Capability Manifest:\n- ${result.errors.join("\n- ")}`);
}
