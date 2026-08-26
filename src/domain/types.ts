export const CANONICAL_EFFORTS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CanonicalEffort = (typeof CANONICAL_EFFORTS)[number];

export const REASONING_STATES = [
  "supported",
  "unsupported",
  "unknown",
  "accepted-but-unverified",
] as const;

export type ReasoningState = (typeof REASONING_STATES)[number];

export const PROTOCOLS = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
  "unknown",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];
export type WireValue = string | number | boolean | null;

export interface ModelIdentity {
  providerId: string;
  modelId: string;
  protocol: Protocol;
  endpointFingerprint?: string;
  canonicalModelId?: string;
}

export interface EffortLevel {
  canonical: CanonicalEffort;
  wire: WireValue;
  behavior?: "send" | "omit";
  evidenceIds?: string[];
}

export interface EffortControl {
  levels: EffortLevel[];
  default?: CanonicalEffort;
}

export interface ToggleControl {
  supported: boolean;
  on?: WireValue;
  off?: WireValue;
}

export interface BudgetTokenControl {
  supported: boolean;
  min?: number;
  max?: number;
  dynamicValue?: number;
  offValue?: number;
}

export interface WireDescriptor {
  protocol: Protocol;
  effortPath?: string;
  togglePath?: string;
  budgetPath?: string;
  reasoningContentPath?: string;
  omitWhenOff?: boolean;
}

export interface ReasoningCapability {
  state: ReasoningState;
  effort?: EffortControl;
  toggle?: ToggleControl;
  budgetTokens?: BudgetTokenControl;
  adaptive?: boolean;
  wire: WireDescriptor;
}

export interface CompatibilityInfo {
  developerRole?: ReasoningState;
  toolCalls?: ReasoningState;
  reasoningUsage?: ReasoningState;
  interleavedThinking?: ReasoningState;
}

export const EVIDENCE_KINDS = [
  "user-override",
  "active-probe",
  "provider-official",
  "provider-catalog",
  "models-dev",
  "endpoint-metadata",
  "heuristic",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_OUTCOMES = [
  "declared",
  "rejected",
  "rejected-enumerated",
  "accepted",
  "observed",
  "manual",
] as const;

export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: string;
  observedAt: string;
  confidence: number;
  claim: string;
  outcome: EvidenceOutcome;
  detail?: string;
}

export interface ReasoningObservation {
  state?: ReasoningState;
  effortLevels?: EffortLevel[];
  defaultEffort?: CanonicalEffort;
  toggle?: ToggleControl;
  budgetTokens?: BudgetTokenControl;
  adaptive?: boolean;
  wire?: Partial<WireDescriptor>;
}

export interface CapabilityObservation extends Evidence {
  reasoning: ReasoningObservation;
}

export interface CapabilityConflict {
  field: string;
  chosenEvidenceId: string;
  conflictingEvidenceId: string;
  chosenValue: unknown;
  conflictingValue: unknown;
}

export interface ModelProfile {
  schemaVersion: "0.1";
  identity: ModelIdentity;
  reasoning: ReasoningCapability;
  compatibility?: CompatibilityInfo;
  evidence: Evidence[];
  conflicts: CapabilityConflict[];
  resolvedAt: string;
}

export interface ResolveProfileOptions {
  resolvedAt?: string;
  compatibility?: CompatibilityInfo;
}
