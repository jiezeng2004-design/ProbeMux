import type { ManifestEffort } from "../../domain/manifest.ts";
import type { DshAdapterCapabilities, DshDeploymentCapabilities } from "./capabilities.ts";

/** agent-default-model section of settings.yaml. */
export interface DshDefaultModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One entry of an explicit llm-pi-ai models list. */
export interface DshModelEntry {
  id: string;
  reasoningEfforts?: Record<string, string | number | boolean | null>;
  [key: string]: unknown;
}

/** A llm-pi-ai provider config. Every other field is preserved untouched. */
export interface DshLlmpiaiProvider {
  displayName?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  api?: string;
  models?: DshModelEntry[];
  modelOverrides?: Record<string, { reasoningEfforts?: Record<string, string | number | boolean | null>; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface DshLlmpiaiSection {
  providers?: Record<string, DshLlmpiaiProvider>;
}

/**
 * DSH-native deepseek-official section.
 *
 * thinking follows the upstream dsh-llm-deepseek settings schema exactly:
 * z.union(["enabled", "disabled"]). Absent means the adapter puts no thinking
 * field on the wire (provider defaults apply) and imposes no extra effort
 * restriction.
 */
export interface DshDeepseekSection {
  apiKeyEnv?: string;
  baseURL?: string;
  thinking?: "enabled" | "disabled";
  [key: string]: unknown;
}

export interface DshSettings {
  "agent-default-model"?: DshDefaultModel;
  "llm-pi-ai"?: DshLlmpiaiSection;
  "llm-deepseek"?: DshDeepseekSection;
  [key: string]: unknown;
}

export type ProviderKind = "llm-pi-ai" | "deepseek-official" | "unknown";

export type ProtocolHint = "openai-completions" | "openai-responses" | "unknown";

export type CredentialSource = "process-env" | "credentials-yaml" | "cwd-dotenv" | "dsh-home-dotenv" | "unresolved";

export interface CredentialResolution {
  ref: string;
  source: CredentialSource;
  available: boolean;
}

/** Fully resolved DSH target that ProbeMux operates on. Never contains the secret itself. */
export interface DshTarget {
  home: string;
  settingsPath: string;
  credentialsPath: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  providerKind: ProviderKind;
  /** Human-readable source of the provider config. */
  source: string;
  /** Effective endpoint; undefined when catalog-derived and not safely resolvable. */
  baseUrl?: string;
  protocolHint: ProtocolHint;
  apiKeyEnv?: string;
  credential: CredentialResolution;
  /** Whether the provider has an explicit models list or relies on the DSH catalog. */
  modelsState: "explicit" | "catalog";
  /** True when the target model appears in the explicit models list. */
  targetInModels: boolean;
  /** Provider found, but no explicit baseURL exists; endpoint cannot be resolved safely. */
  catalogEndpointUnresolved: boolean;
}

export interface DshProbeOptions {
  dshHome?: string;
  provider?: string;
  model?: string;
}

export interface DshPatchOptions {
  /** Explicit default effort; must be VERIFIED for the endpoint or writing is refused. */
  defaultEffort?: ManifestEffort;
  /** DSH adapter capability constraints; defaults to the unknown-version state. */
  adapterCapabilities?: DshAdapterCapabilities;
  /**
   * DSH deployment-level constraints (e.g. llm-deepseek.thinking=disabled
   * restricting the writable efforts to off). Absent means no deployment
   * restriction applies.
   */
  deploymentCapabilities?: DshDeploymentCapabilities;
}

export type PatchWriteTarget = "none" | "models" | "modelOverrides";

export interface DshPatchResult {
  /** Full settings.yaml candidate text (leaf-patched, everything else preserved). */
  candidateText: string;
  /** Whether the candidate differs from the original settings text. */
  changed: boolean;
  /** Human-readable list of the leaf changes made. */
  changes: string[];
  warnings: string[];
  /** Resulting agent-default-model.reasoningEffort, when the patch touches it. */
  defaultEffort?: string;
  writeTarget: PatchWriteTarget;
}