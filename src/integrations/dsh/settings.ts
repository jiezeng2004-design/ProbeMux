import { readFile } from "node:fs/promises";
import { parseDocument, type Document } from "yaml";
import type { DshDefaultModel, DshDeepseekSection, DshLlmpiaiProvider, DshSettings } from "./types.ts";

export interface LoadedDshSettings {
  /** Raw settings.yaml text, untouched. */
  text: string;
  settings: DshSettings;
  /** yaml Document (parseDocument) so later patches preserve comments and unknown sections. */
  doc: Document;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadDshSettings(settingsPath: string): Promise<LoadedDshSettings> {
  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`DSH settings not found at ${settingsPath}. Is DSH installed? (Set DSH_HOME or pass --dsh-home to override.)`);
    }
    throw error;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`DSH settings YAML parse error: ${doc.errors[0]?.message ?? "unknown error"}`);
  }
  let settings: DshSettings;
  try {
    settings = doc.toJS() as DshSettings;
  } catch (error) {
    throw new Error(`DSH settings YAML could not be interpreted: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(settings)) throw new Error("DSH settings.yaml must contain a mapping at the top level.");
  return { text, settings, doc };
}

/** Read agent-default-model; throws a clear error when it is not usable. */
export function getDefaultModel(settings: DshSettings): DshDefaultModel {
  const def = settings["agent-default-model"];
  if (!isObject(def)) throw new Error("DSH settings have no agent-default-model section.");
  const provider = typeof def.provider === "string" ? def.provider : undefined;
  const model = typeof def.model === "string" ? def.model : undefined;
  if (!provider || !model) {
    throw new Error("DSH agent-default-model must define both provider and model.");
  }
  return {
    provider,
    model,
    reasoningEffort: typeof def.reasoningEffort === "string" ? def.reasoningEffort : undefined,
  };
}

export interface FoundProvider {
  kind: "llm-pi-ai" | "deepseek-official" | "unknown";
  config: DshLlmpiaiProvider | DshDeepseekSection | undefined;
  /** Human-readable source of the provider definition. */
  source: string;
}

export function findProvider(settings: DshSettings, providerId: string): FoundProvider {
  if (providerId === "deepseek-official") {
    const section = settings["llm-deepseek"];
    return { kind: "deepseek-official", config: isObject(section) ? (section as DshDeepseekSection) : {}, source: "llm-deepseek" };
  }
  const llmpiai = settings["llm-pi-ai"];
  const providers = isObject(llmpiai) && isObject(llmpiai.providers) ? llmpiai.providers : undefined;
  const config = providers?.[providerId];
  if (config !== undefined && isObject(config)) {
    return { kind: "llm-pi-ai", config: config as DshLlmpiaiProvider, source: `llm-pi-ai.providers.${providerId}` };
  }
  return { kind: "unknown", config: undefined, source: "none" };
}

/** DSH reasoning-effort labels that can be persisted into llm-pi-ai config. */
export const DSH_EFFORT_LABELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
