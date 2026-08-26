import type {
  CapabilityManifest,
  CrossProtocolCompatibility,
  ManifestEffort,
  ProbeProtocol,
  ReasoningDialectCapability,
  ReasoningLevelCapability,
} from "../domain/manifest.ts";
import type { RenderOptions } from "./types.ts";

export function selectDialect(
  manifest: CapabilityManifest,
  protocol: ProbeProtocol,
  parameterPath: string,
  options: RenderOptions,
  warnings: string[],
): ReasoningDialectCapability | undefined {
  const dialect = manifest.reasoning.dialects.find((item) => (
    item.protocol === protocol && item.parameterPath === parameterPath
  ));
  if (!dialect) {
    warnings.push(`No probe result exists for ${protocol} '${parameterPath}'.`);
    return undefined;
  }
  if (dialect.status === "VERIFIED") return dialect;
  if (dialect.status === "LIKELY" && options.allowUnverified) {
    warnings.push(`The ${protocol} '${parameterPath}' dialect is only LIKELY and has no VERIFIED effort enumeration.`);
    return dialect;
  }
  warnings.push(`The ${protocol} '${parameterPath}' dialect is ${dialect.status}; reasoning controls were omitted.`);
  return undefined;
}

export function requestedDefault(
  levels: ReasoningLevelCapability[],
  options: RenderOptions,
  targetAllowed: readonly ManifestEffort[],
  warnings: string[],
): ManifestEffort | undefined {
  const requested = options.defaultEffort;
  if (!requested) return undefined;
  if (!levels.some((level) => level.canonical === requested && level.status === "VERIFIED")) {
    warnings.push(`Requested default '${requested}' is not VERIFIED for this endpoint dialect; it was omitted.`);
    return undefined;
  }
  if (!targetAllowed.includes(requested)) {
    warnings.push(`Requested default '${requested}' cannot be persisted by this target; it was omitted without downshifting.`);
    return undefined;
  }
  return requested;
}

export function protocolSafety(manifest: CapabilityManifest, protocol: ProbeProtocol, warnings: string[]): "VERIFIED" | "REVIEW_REQUIRED" | "BLOCKED" {
  const status = manifest.protocols[protocol].status;
  if (status === "VERIFIED") return "VERIFIED";
  if (status === "UNSUPPORTED") {
    warnings.push(`${protocol} is explicitly UNSUPPORTED by this endpoint.`);
    return "BLOCKED";
  }
  warnings.push(`${protocol} is ${status}; generated configuration requires manual review.`);
  return "REVIEW_REQUIRED";
}

export function compatibilitySafety(
  label: string,
  status: CapabilityManifest["toolCalling"]["status"],
  warnings: string[],
): "VERIFIED" | "REVIEW_REQUIRED" | "BLOCKED" {
  if (status === "VERIFIED") return "VERIFIED";
  if (status === "UNSUPPORTED") {
    warnings.push(`${label} is UNSUPPORTED; the target Agent may not function correctly.`);
    return "BLOCKED";
  }
  warnings.push(`${label} is ${status}; the target Agent compatibility is not fully verified.`);
  return "REVIEW_REQUIRED";
}

export function statusForProtocol(
  capability: CrossProtocolCompatibility,
  protocol: ProbeProtocol,
): CrossProtocolCompatibility["status"] {
  return capability.byProtocol.find((item) => item.protocol === protocol)?.status ?? "UNKNOWN";
}

export function combineSafety(...items: Array<"VERIFIED" | "REVIEW_REQUIRED" | "BLOCKED">): "VERIFIED" | "REVIEW_REQUIRED" | "BLOCKED" {
  if (items.includes("BLOCKED")) return "BLOCKED";
  if (items.includes("REVIEW_REQUIRED")) return "REVIEW_REQUIRED";
  return "VERIFIED";
}
