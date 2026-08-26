import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveDshHome } from "./home.ts";
import type { DshDeepseekSection } from "./types.ts";

export type DshAdapterProviderKind = "llm-pi-ai" | "deepseek-official";

export type DshAdapterSource = "dynamic" | "version-table" | "known-static" | "unknown";

export interface DshAdapterCapabilities {
  providerKind: DshAdapterProviderKind;
  /** DSH label-space reasoning efforts this adapter version accepts. */
  allowedReasoningEfforts?: readonly string[];
  source: DshAdapterSource;
  /** False when the adapter's constraints cannot be confirmed safely. */
  safeToWrite: boolean;
  warning?: string;
}

/**
 * Compatibility table: exact @deepseek-ai/dsh-llm-deepseek ADAPTER package
 * version -> deepseek-official adapter constraints.
 *
 * deepseek-official reasoning levels are gated by the installed adapter's own
 * whitelist. Keys are ADAPTER package versions detected from the real DSH
 * runtime — never the DSH CLI version, which is only diagnostic. Only versions
 * present here can be written against; an UNKNOWN version is never guessed
 * (a '*' wildcard is intentionally NOT used).
 */
const DEEPSEEK_ADAPTER_COMPAT: Record<string, { allowedReasoningEfforts: readonly string[] }> = {
  // Legacy placeholder row predating the 0.1.1-rc.2 verification round;
  // kept unchanged so rc.1 behaviour has no regression.
  "0.1.1-rc.1": { allowedReasoningEfforts: ["off", "high", "max"] },
  // verified from upstream adapter implementation
  // (@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2): reasoningEffort settings schema
  // is z.union(["off","low","high","max"]) and the per-request validator
  // accepts exactly those four; thinking is z.union(["enabled","disabled"]),
  // thinking=disabled restricts the model's efforts to off only and rejects
  // any other effort before the request is sent.
  "0.1.1-rc.2": { allowedReasoningEfforts: ["off", "low", "high", "max"] },
};

/**
 * Resolve the DSH adapter capability constraints for a provider kind.
 * llm-pi-ai is user-defined and unrestricted; deepseek-official is gated by
 * the exact installed DSH version.
 */
/**
 * Resolve the DSH adapter capability constraints for a provider kind.
 * llm-pi-ai is user-defined and unrestricted; deepseek-official is gated by
 * the exact detected @deepseek-ai/dsh-llm-deepseek ADAPTER package version
 * (detectDshDeepseekAdapterVersion), never by the DSH CLI version.
 */
export function getDshAdapterCapabilities(
  providerKind: DshAdapterProviderKind,
  adapterVersion?: string,
): DshAdapterCapabilities {
  if (providerKind === "llm-pi-ai") {
    // The adapter imposes no extra restriction; the endpoint VERIFIED set decides.
    return { providerKind, source: "dynamic", safeToWrite: true };
  }
  const row = adapterVersion ? DEEPSEEK_ADAPTER_COMPAT[adapterVersion] : undefined;
  if (row) {
    return {
      providerKind: "deepseek-official",
      allowedReasoningEfforts: row.allowedReasoningEfforts,
      source: "version-table",
      safeToWrite: true,
    };
  }
  return {
    providerKind: "deepseek-official",
    source: "unknown",
    safeToWrite: false,
    warning: adapterVersion === undefined
      ? "deepseek-official reasoning levels are gated by the installed @deepseek-ai/dsh-llm-deepseek adapter whitelist, which ProbeMux could not detect; no reasoning controls were written."
      : `deepseek-official adapter version '${adapterVersion}' is not in the ProbeMux compatibility table; no reasoning controls were written.`,
  };
}

/**
 * Deployment-level reasoning constraints read from the DSH settings.yaml
 * (llm-deepseek section). These are the capabilities of the deployed DSH
 * instance, separate from the adapter version's whitelist.
 */
export type DshDeploymentSource = "settings" | "default" | "unknown";

export interface DshDeploymentCapabilities {
  /**
   * Efforts the deployment allows. Absent means the deployment imposes no
   * extra restriction (verified upstream: with thinking unset or enabled the
   * adapter accepts the full whitelist).
   */
  allowedReasoningEfforts?: readonly string[];
  source: DshDeploymentSource;
  /** False when the deployment policy cannot be confirmed safely. */
  safeToWrite: boolean;
  warning?: string;
  /** Human-readable policy, e.g. "thinking=disabled". */
  policy: string;
}

export interface WritableEffortComputation {
  /** Endpoint VERIFIED ∩ adapter allowed ∩ deployment allowed (DSH label space). */
  writable: readonly string[];
  source: DshAdapterSource;
  safeToWrite: boolean;
  /** Deployment constraints applied (present when the caller supplied them). */
  deployment?: DshDeploymentCapabilities;
}

/**
 * Resolve the deployment-level reasoning constraints for deepseek-official
 * from the llm-deepseek settings section.
 *
 * Semantics verified from the upstream adapter implementation
 * (@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2):
 * - thinking=disabled: the deployment accepts ONLY "off". Any other effort is
 *   rejected with UNSUPPORTED_REASONING_EFFORT before the request is sent, and
 *   the model capability exposes off only.
 * - thinking=enabled: the full adapter whitelist applies; no extra restriction.
 * - thinking missing: defaults.thinking stays undefined; the adapter puts no
 *   thinking field on the wire (provider defaults apply) and imposes no extra
 *   effort restriction. It is NOT treated as "enabled" — it is unconstrained.
 * - any other value: unknown; writing is refused rather than guessed.
 */
export function getDshDeploymentCapabilities(section?: DshDeepseekSection): DshDeploymentCapabilities {
  if (section === undefined || section.thinking === undefined) {
    return { source: "default", safeToWrite: true, policy: "thinking=missing" };
  }
  if (section.thinking === "disabled") {
    return { allowedReasoningEfforts: ["off"], source: "settings", safeToWrite: true, policy: "thinking=disabled" };
  }
  if (section.thinking === "enabled") {
    return { source: "settings", safeToWrite: true, policy: "thinking=enabled" };
  }
  return {
    source: "unknown",
    safeToWrite: false,
    policy: "unknown",
    warning: "llm-deepseek.thinking has an unrecognized value; no reasoning controls were written.",
  };
}

/**
 * Final writable effort computation: endpoint VERIFIED efforts intersected
 * with the DSH adapter's allowed efforts and the DSH deployment's allowed
 * efforts. UNKNOWN / LIKELY / BLOCKED efforts never reach this function (the
 * manifest layer filters them first); when the adapter or the deployment is
 * not safely writable, the result is empty.
 */
export function computeWritableReasoningEfforts(options: {
  verifiedEfforts: readonly string[];
  adapterCapabilities: DshAdapterCapabilities;
  deploymentCapabilities?: DshDeploymentCapabilities;
}): WritableEffortComputation {
  const { verifiedEfforts, adapterCapabilities, deploymentCapabilities } = options;
  if (!adapterCapabilities.safeToWrite || (deploymentCapabilities !== undefined && !deploymentCapabilities.safeToWrite)) {
    return {
      writable: [],
      source: adapterCapabilities.source,
      safeToWrite: false,
      ...(deploymentCapabilities ? { deployment: deploymentCapabilities } : {}),
    };
  }
  const adapterAllowed = adapterCapabilities.allowedReasoningEfforts;
  // No allowed list means the adapter imposes no extra restriction.
  let writable = adapterAllowed ? verifiedEfforts.filter((effort) => adapterAllowed.includes(effort)) : [...verifiedEfforts];
  const deploymentAllowed = deploymentCapabilities?.allowedReasoningEfforts;
  if (deploymentAllowed) {
    writable = writable.filter((effort) => deploymentAllowed.includes(effort));
  }
  return {
    writable,
    source: adapterCapabilities.source,
    safeToWrite: true,
    ...(deploymentCapabilities ? { deployment: deploymentCapabilities } : {}),
  };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Best-effort DSH version detection from stable local sources only:
 * 1. DSH_VERSION environment variable (documented override)
 * 2. $DSH_HOME/package.json .version (metadata inside the DSH home)
 * 3. $DSH_HOME/version (plain text metadata file)
 * 4. the installed @deepseek-ai/dsh package.json when it resolves from this process tree
 *
 * Never executes shells, never scans the disk, never touches the network,
 * never guesses. Returns undefined when the version cannot be established.
 */
export async function detectDshVersion(dshHome?: string): Promise<string | undefined> {
  const envVersion = process.env.DSH_VERSION;
  if (typeof envVersion === "string" && envVersion.trim() !== "") return envVersion.trim();
  const home = resolveDshHome(dshHome);
  for (const candidate of [join(home, "package.json"), join(home, "version")]) {
    const text = await readOptional(candidate);
    if (text === null) continue;
    if (candidate.endsWith("package.json")) {
      try {
        const pkg: unknown = JSON.parse(text);
        if (typeof pkg === "object" && pkg !== null && typeof (pkg as Record<string, unknown>).version === "string") {
          const version = (pkg as Record<string, unknown>).version as string;
          if (version.trim() !== "") return version.trim();
        }
      } catch {
        // Malformed metadata; try the next source.
      }
    } else {
      const version = text.trim();
      if (version !== "" && /^\d+\.\d+\.\d+/.test(version)) return version;
    }
  }
  // Installed DSH package, when resolvable from this process tree.
  try {
    if (typeof import.meta.resolve === "function") {
      const resolved = import.meta.resolve("@deepseek-ai/dsh/package.json");
      if (typeof resolved === "string" && resolved.startsWith("file:")) {
        const pkgPath = fileURLToPath(new URL(resolved));
        const pkgText = await readOptional(pkgPath);
        if (pkgText !== null) {
          try {
            const pkg: unknown = JSON.parse(pkgText);
            if (typeof pkg === "object" && pkg !== null && typeof (pkg as Record<string, unknown>).version === "string") {
              return ((pkg as Record<string, unknown>).version as string).trim();
            }
          } catch {
            // Malformed package metadata; report unknown.
          }
        }
      }
    }
  } catch {
    // @deepseek-ai/dsh is not resolvable from here; version stays unknown.
  }
  return undefined;
}

/**
 * Where the @deepseek-ai/dsh-llm-deepseek adapter version was discovered.
 * - "active-profile": an explicit DSH_PROFILE selection resolved the package.
 * - "profiles-shared": a single distinct version found across the limited
 *   known profile roots ($DSH_HOME/profiles/<name>/node_modules and the flat
 *   $DSH_HOME/profiles/node_modules fallback).
 * - "dsh-home-node-modules": $DSH_HOME/node_modules package.
 * - "probe-process-resolve": ProbeMux's own import resolution (last resort,
 *   does NOT represent the user's DSH runtime).
 * - "ambiguous": multiple conflicting versions under $DSH_HOME/profiles and no
 *   active profile known — never pick one.
 * - "unknown": nothing verifiable.
 */
export type DshAdapterVersionSource =
  | "active-profile"
  | "profiles-shared"
  | "dsh-home-node-modules"
  | "probe-process-resolve"
  | "ambiguous"
  | "unknown";

export interface DshAdapterVersionDetection {
  /** The detected adapter package version; undefined when unknown or ambiguous. */
  version?: string;
  /** Absolute path of the package.json that provided the version, when found. */
  packagePath?: string;
  source: DshAdapterVersionSource;
  warning?: string;
}

const DEEPSEEK_ADAPTER_PACKAGE_DIR = join("@deepseek-ai", "dsh-llm-deepseek");

function adapterPackageJsonPath(root: string): string {
  return join(root, "node_modules", DEEPSEEK_ADAPTER_PACKAGE_DIR, "package.json");
}

/** Read a package.json version; malformed JSON, non-string or empty versions are fail-safe (absent). */
async function readAdapterVersion(packageJsonPath: string): Promise<string | undefined> {
  const text = await readOptional(packageJsonPath);
  if (text === null) return undefined;
  try {
    const pkg: unknown = JSON.parse(text);
    if (typeof pkg === "object" && pkg !== null && typeof (pkg as Record<string, unknown>).version === "string") {
      const version = ((pkg as Record<string, unknown>).version as string).trim();
      return version !== "" ? version : undefined;
    }
  } catch {
    // Malformed package metadata; treat this candidate as absent (fail-safe).
  }
  return undefined;
}

/** A profile name must be a single path segment (mirrors upstream resolveProfileDir). */
function isValidProfileName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && name !== "node_modules" && !name.includes("/") && !name.includes("\\");
}

/**
 * Detect the ACTUAL @deepseek-ai/dsh-llm-deepseek adapter package version that
 * the user's DSH runtime loads. The DSH CLI version (detectDshVersion) is NOT
 * an authority for this: the adapter's own whitelist decides capability.
 *
 * Priority:
 * 1. Explicit active profile: $DSH_HOME/profiles/<DSH_PROFILE>/node_modules/... (DSH_PROFILE
 *    is a ProbeMux convention mirroring `dsh --profile <name>`).
 * 2. Limited known profile roots ONLY: direct children of $DSH_HOME/profiles
 *    (never recursive, never arbitrary directories) plus the flat
 *    $DSH_HOME/profiles/node_modules fallback. Multiple conflicting versions
 *    with no known active profile -> ambiguous (fail-safe, never pick newest).
 * 3. $DSH_HOME/node_modules/... package.
 * 4. ProbeMux's own import resolution as the LAST resort (it does not
 *    represent the DSH runtime; used only when nothing else exists).
 */
export async function detectDshDeepseekAdapterVersion(dshHome?: string): Promise<DshAdapterVersionDetection> {
  const home = resolveDshHome(dshHome);

  // 1. Explicit active profile selection (DSH_PROFILE env, ProbeMux convention).
  const activeProfile = process.env.DSH_PROFILE?.trim();
  if (typeof activeProfile === "string" && activeProfile !== "" && isValidProfileName(activeProfile)) {
    const activePath = adapterPackageJsonPath(join(home, "profiles", activeProfile));
    const version = await readAdapterVersion(activePath);
    if (version !== undefined) return { version, packagePath: activePath, source: "active-profile" };
  }

  // 2. Limited known profile roots: direct children of $DSH_HOME/profiles only.
  const seen = new Map<string, string>(); // version -> packagePath
  try {
    const profilesDir = join(home, "profiles");
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue; // flat fallback handled separately
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = adapterPackageJsonPath(join(profilesDir, entry.name));
      const version = await readAdapterVersion(path);
      if (version !== undefined && !seen.has(version)) seen.set(version, path);
    }
    // Flat shared fallback: $DSH_HOME/profiles/node_modules already IS a
    // modules dir (one entry per package), so no extra node_modules segment.
    const sharedPath = join(profilesDir, "node_modules", DEEPSEEK_ADAPTER_PACKAGE_DIR, "package.json");
    const sharedVersion = await readAdapterVersion(sharedPath);
    if (sharedVersion !== undefined && !seen.has(sharedVersion)) seen.set(sharedVersion, sharedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (seen.size > 1) {
    return {
      source: "ambiguous",
      warning: "DeepSeek adapter version detection is ambiguous: multiple @deepseek-ai/dsh-llm-deepseek versions exist under $DSH_HOME/profiles and no active profile is known; no reasoning controls were written.",
    };
  }
  if (seen.size === 1) {
    const [version, packagePath] = [...seen.entries()][0];
    return { version, packagePath, source: "profiles-shared" };
  }

  // 3. $DSH_HOME/node_modules package.
  const homePath = adapterPackageJsonPath(home);
  const homeVersion = await readAdapterVersion(homePath);
  if (homeVersion !== undefined) return { version: homeVersion, packagePath: homePath, source: "dsh-home-node-modules" };

  // 4. ProbeMux process resolution — last resort only.
  try {
    if (typeof import.meta.resolve === "function") {
      const resolved = import.meta.resolve("@deepseek-ai/dsh-llm-deepseek/package.json");
      if (typeof resolved === "string" && resolved.startsWith("file:")) {
        const pkgPath = fileURLToPath(new URL(resolved));
        const version = await readAdapterVersion(pkgPath);
        if (version !== undefined) return { version, packagePath: pkgPath, source: "probe-process-resolve" };
      }
    }
  } catch {
    // Not resolvable from the ProbeMux process; stays unknown.
  }

  return { source: "unknown" };
}