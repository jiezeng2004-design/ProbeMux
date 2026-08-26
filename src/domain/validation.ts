import {
  CANONICAL_EFFORTS,
  EVIDENCE_KINDS,
  PROTOCOLS,
  REASONING_STATES,
  type ModelProfile,
} from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateModelProfile(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { valid: false, errors: ["profile must be an object"] };

  if (value.schemaVersion !== "0.1") errors.push("schemaVersion must be '0.1'");

  if (!isObject(value.identity)) {
    errors.push("identity must be an object");
  } else {
    if (typeof value.identity.providerId !== "string" || !value.identity.providerId) errors.push("identity.providerId is required");
    if (typeof value.identity.modelId !== "string" || !value.identity.modelId) errors.push("identity.modelId is required");
    if (!PROTOCOLS.includes(value.identity.protocol as never)) errors.push("identity.protocol is invalid");
  }

  if (!isObject(value.reasoning)) {
    errors.push("reasoning must be an object");
  } else {
    if (!REASONING_STATES.includes(value.reasoning.state as never)) errors.push("reasoning.state is invalid");
    if (!isObject(value.reasoning.wire)) {
      errors.push("reasoning.wire must be an object");
    } else if (!PROTOCOLS.includes(value.reasoning.wire.protocol as never)) {
      errors.push("reasoning.wire.protocol is invalid");
    }

    if (value.reasoning.effort !== undefined) {
      if (!isObject(value.reasoning.effort) || !Array.isArray(value.reasoning.effort.levels)) {
        errors.push("reasoning.effort.levels must be an array");
      } else {
        const seen = new Set<string>();
        for (const [index, level] of value.reasoning.effort.levels.entries()) {
          if (!isObject(level)) {
            errors.push(`reasoning.effort.levels[${index}] must be an object`);
            continue;
          }
          if (!CANONICAL_EFFORTS.includes(level.canonical as never)) {
            errors.push(`reasoning.effort.levels[${index}].canonical is invalid`);
          }
          if (seen.has(String(level.canonical))) errors.push(`duplicate effort level: ${String(level.canonical)}`);
          seen.add(String(level.canonical));
          const wireType = typeof level.wire;
          if (level.wire !== null && !["string", "number", "boolean"].includes(wireType)) {
            errors.push(`reasoning.effort.levels[${index}].wire must be primitive or null`);
          }
        }
      }
    }
  }

  if (!Array.isArray(value.evidence)) {
    errors.push("evidence must be an array");
  } else {
    for (const [index, evidence] of value.evidence.entries()) {
      if (!isObject(evidence)) {
        errors.push(`evidence[${index}] must be an object`);
        continue;
      }
      if (typeof evidence.id !== "string" || !evidence.id) errors.push(`evidence[${index}].id is required`);
      if (!EVIDENCE_KINDS.includes(evidence.kind as never)) errors.push(`evidence[${index}].kind is invalid`);
      if (typeof evidence.confidence !== "number" || evidence.confidence < 0 || evidence.confidence > 1) {
        errors.push(`evidence[${index}].confidence must be between 0 and 1`);
      }
    }
  }

  if (!Array.isArray(value.conflicts)) errors.push("conflicts must be an array");
  if (typeof value.resolvedAt !== "string" || Number.isNaN(Date.parse(value.resolvedAt))) {
    errors.push("resolvedAt must be an ISO date string");
  }

  return { valid: errors.length === 0, errors };
}

export function assertModelProfile(value: unknown): asserts value is ModelProfile {
  const result = validateModelProfile(value);
  if (!result.valid) throw new Error(`Invalid ModelProfile:\n- ${result.errors.join("\n- ")}`);
}
