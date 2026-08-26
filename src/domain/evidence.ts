import type { Evidence, EvidenceKind, EvidenceOutcome } from "./types.ts";

const KIND_RANK: Record<EvidenceKind, number> = {
  "user-override": 100,
  "active-probe": 90,
  "provider-official": 80,
  "provider-catalog": 70,
  "models-dev": 60,
  "endpoint-metadata": 50,
  heuristic: 10,
};

const OUTCOME_RANK: Record<EvidenceOutcome, number> = {
  observed: 60,
  "rejected-enumerated": 55,
  rejected: 50,
  manual: 45,
  accepted: 30,
  declared: 20,
};

export function evidenceRank(evidence: Evidence): number {
  return KIND_RANK[evidence.kind] * 100 + OUTCOME_RANK[evidence.outcome];
}

export function compareEvidence(a: Evidence, b: Evidence): number {
  const rankDifference = evidenceRank(b) - evidenceRank(a);
  if (rankDifference !== 0) return rankDifference;

  const timeDifference = Date.parse(b.observedAt) - Date.parse(a.observedAt);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;

  const confidenceDifference = b.confidence - a.confidence;
  if (confidenceDifference !== 0) return confidenceDifference;

  return 0;
}

export function sortByEvidence<T extends Evidence>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => compareEvidence(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
}
