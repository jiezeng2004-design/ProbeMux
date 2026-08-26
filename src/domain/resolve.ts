import { sortByEvidence } from "./evidence.ts";
import type {
  CapabilityConflict,
  CapabilityObservation,
  CanonicalEffort,
  EffortLevel,
  ModelIdentity,
  ModelProfile,
  ReasoningState,
  ResolveProfileOptions,
  WireDescriptor,
} from "./types.ts";

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addConflict(
  conflicts: CapabilityConflict[],
  field: string,
  chosen: CapabilityObservation,
  conflicting: CapabilityObservation,
  chosenValue: unknown,
  conflictingValue: unknown,
): void {
  if (sameValue(chosenValue, conflictingValue)) return;
  conflicts.push({
    field,
    chosenEvidenceId: chosen.id,
    conflictingEvidenceId: conflicting.id,
    chosenValue,
    conflictingValue,
  });
}

function resolveState(
  observations: CapabilityObservation[],
  conflicts: CapabilityConflict[],
): ReasoningState {
  const candidates = observations.filter((item) => item.reasoning.state && item.reasoning.state !== "unknown");
  const chosen = candidates[0];
  if (!chosen) return "unknown";

  for (const candidate of candidates.slice(1)) {
    addConflict(
      conflicts,
      "reasoning.state",
      chosen,
      candidate,
      chosen.reasoning.state,
      candidate.reasoning.state,
    );
  }
  return chosen.reasoning.state ?? "unknown";
}

function resolveEffortLevels(
  observations: CapabilityObservation[],
  conflicts: CapabilityConflict[],
): EffortLevel[] {
  const chosenByEffort = new Map<CanonicalEffort, { observation: CapabilityObservation; level: EffortLevel }>();

  for (const observation of observations) {
    for (const level of observation.reasoning.effortLevels ?? []) {
      const chosen = chosenByEffort.get(level.canonical);
      if (!chosen) {
        chosenByEffort.set(level.canonical, {
          observation,
          level: { ...level, evidenceIds: [...new Set([...(level.evidenceIds ?? []), observation.id])] },
        });
        continue;
      }

      addConflict(
        conflicts,
        `reasoning.effort.${level.canonical}`,
        chosen.observation,
        observation,
        { wire: chosen.level.wire, behavior: chosen.level.behavior ?? "send" },
        { wire: level.wire, behavior: level.behavior ?? "send" },
      );
    }
  }

  return [...chosenByEffort.values()].map(({ level }) => level);
}

function firstDefined<T>(
  observations: CapabilityObservation[],
  field: string,
  getter: (observation: CapabilityObservation) => T | undefined,
  conflicts: CapabilityConflict[],
): T | undefined {
  const candidates = observations
    .map((observation) => ({ observation, value: getter(observation) }))
    .filter((entry): entry is { observation: CapabilityObservation; value: T } => entry.value !== undefined);

  const chosen = candidates[0];
  if (!chosen) return undefined;
  for (const candidate of candidates.slice(1)) {
    addConflict(conflicts, field, chosen.observation, candidate.observation, chosen.value, candidate.value);
  }
  return chosen.value;
}

function resolveWire(
  identity: ModelIdentity,
  observations: CapabilityObservation[],
  conflicts: CapabilityConflict[],
): WireDescriptor {
  const keys = [
    "protocol",
    "effortPath",
    "togglePath",
    "budgetPath",
    "reasoningContentPath",
    "omitWhenOff",
  ] as const;
  const wire: WireDescriptor = { protocol: identity.protocol };

  for (const key of keys) {
    const value = firstDefined(observations, `reasoning.wire.${key}`, (item) => item.reasoning.wire?.[key], conflicts);
    if (value !== undefined) {
      Object.assign(wire, { [key]: value });
    }
  }

  return wire;
}

export function resolveProfile(
  identity: ModelIdentity,
  inputObservations: readonly CapabilityObservation[],
  options: ResolveProfileOptions = {},
): ModelProfile {
  const observations = sortByEvidence(inputObservations);
  const conflicts: CapabilityConflict[] = [];
  const effortLevels = resolveEffortLevels(observations, conflicts);
  const defaultEffort = firstDefined(
    observations,
    "reasoning.effort.default",
    (item) => item.reasoning.defaultEffort,
    conflicts,
  );

  return {
    schemaVersion: "0.1",
    identity: { ...identity },
    reasoning: {
      state: resolveState(observations, conflicts),
      effort: effortLevels.length > 0 ? { levels: effortLevels, ...(defaultEffort ? { default: defaultEffort } : {}) } : undefined,
      toggle: firstDefined(observations, "reasoning.toggle", (item) => item.reasoning.toggle, conflicts),
      budgetTokens: firstDefined(
        observations,
        "reasoning.budgetTokens",
        (item) => item.reasoning.budgetTokens,
        conflicts,
      ),
      adaptive: firstDefined(observations, "reasoning.adaptive", (item) => item.reasoning.adaptive, conflicts),
      wire: resolveWire(identity, observations, conflicts),
    },
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
    evidence: observations.map(({ reasoning: _reasoning, ...evidence }) => evidence),
    conflicts,
    resolvedAt: options.resolvedAt ?? new Date().toISOString(),
  };
}
