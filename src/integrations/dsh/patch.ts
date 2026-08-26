import { parseDocument, type Document, YAMLMap, YAMLSeq } from "yaml";
import type { CapabilityManifest, ManifestEffort, ReasoningDialectCapability, ReasoningLevelCapability } from "../../domain/manifest.ts";
import {
  computeWritableReasoningEfforts,
  getDshAdapterCapabilities,
  type DshAdapterProviderKind,
} from "./capabilities.ts";
import { DSH_EFFORT_LABELS } from "./settings.ts";
import type { DshPatchOptions, DshPatchResult, DshTarget } from "./types.ts";

type Scalar = string | number | boolean | null;

/**
 * Build a minimal leaf-level patch of an existing DSH settings.yaml.
 *
 * Rules (all enforced here):
 * - Only VERIFIED reasoning levels are ever written; UNKNOWN/UNSUPPORTED never.
 * - The writable set is always Endpoint VERIFIED ∩ DSH adapter allowed ∩ DSH
 *   deployment allowed (e.g. llm-deepseek.thinking=disabled restricts the
 *   writable efforts to off); an unknown adapter or deployment capability
 *   means nothing is written.
 * - Target model in an explicit models list: merge reasoningEfforts into that
 *   entry only; other models untouched.
 * - Catalog route (no explicit models, or model not listed): merge into
 *   modelOverrides.<model>.reasoningEfforts; never add a models list, never
 *   replace the provider catalog.
 * - Everything else (baseURL, apiKeyEnv, displayName, headers, retryPolicy,
 *   timeout, transport, compat, contextWindow, maxTokens, input, other
 *   providers/sections, comments) is preserved untouched.
 * - agent-default-model.reasoningEffort keeps the current value when it is
 *   still VERIFIED; otherwise a verified default is chosen (high first) and the
 *   change appears in the diff. This only applies when the sync target IS the
 *   global default model (provider+model); a non-default target never touches
 *   agent-default-model.reasoningEffort.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerPath(providerId: string): string[] {
  return ["llm-pi-ai", "providers", providerId];
}

/** Map canonical verified levels to DSH labels ("none" merges into "off"). */
function verifiedLabelMap(manifest: CapabilityManifest, protocol: "responses" | "chat-completions"): Map<string, Scalar> {
  const expectedPath = protocol === "responses" ? "reasoning.effort" : "reasoning_effort";
  const dialect = manifest.reasoning.dialects.find((item) => item.protocol === protocol && item.parameterPath === expectedPath);
  if (!dialect || dialect.status !== "VERIFIED") return new Map();
  const mapped = new Map<string, Scalar>();
  for (const level of dialect.levels) {
    if (level.status !== "VERIFIED") continue;
    const label = level.canonical === "none" ? "off" : level.canonical;
    if (!DSH_EFFORT_LABELS.includes(label as (typeof DSH_EFFORT_LABELS)[number])) continue;
    if (!mapped.has(label)) mapped.set(label, level.wireValue as Scalar);
  }
  return mapped;
}

function selectVerifiedProtocol(manifest: CapabilityManifest): "responses" | "chat-completions" | undefined {
  if (manifest.protocols["chat-completions"].status === "VERIFIED") return "chat-completions";
  if (manifest.protocols.responses.status === "VERIFIED") return "responses";
  return undefined;
}

/** Merge keys into the map at basePath, recording only real leaf changes. */
function mergeLeafMap(
  doc: Document,
  basePath: Array<string | number>,
  values: Record<string, Scalar>,
  changes: string[],
): boolean {
  let touched = false;
  for (const [key, value] of Object.entries(values)) {
    const existing = doc.getIn([...basePath, key]);
    if (existing === value) continue; // already correct; no write needed
    doc.setIn([...basePath, key], value);
    const where = [...basePath, key]
      .map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`))
      .join("");
    changes.push(existing === undefined ? `+ ${where}` : `~ ${where} (was ${String(existing)})`);
    touched = true;
  }
  return touched;
}

/** Pick the default effort to persist; returns undefined when nothing can be chosen. */
function chooseDefaultEffort(
  requested: ManifestEffort | undefined,
  writable: ReadonlySet<string>,
  current: string | undefined,
  changes: string[],
  warnings: string[],
): string | undefined {
  if (requested) {
    const label = requested === "none" ? "off" : requested;
    if (!writable.has(label)) {
      throw new Error(`Refusing to write default effort '${requested}': it is not VERIFIED and writable for this endpoint/adapter.`);
    }
    if (current !== label) changes.push(`~ agent-default-model.reasoningEffort (${current ?? "unset"} -> ${label})`);
    return label;
  }
  if (current && writable.has(current)) return current; // keep the user's habit
  if (writable.has("high")) {
    if (current !== "high") {
      warnings.push(`Current default effort '${current ?? "unset"}' is not writable; using 'high'.`);
      changes.push(`~ agent-default-model.reasoningEffort (${current ?? "unset"} -> high)`);
    }
    return "high";
  }
  for (const label of DSH_EFFORT_LABELS) {
    if (label !== "off" && writable.has(label)) {
      warnings.push(`Current default effort '${current ?? "unset"}' is not writable; using '${label}'.`);
      changes.push(`~ agent-default-model.reasoningEffort (${current ?? "unset"} -> ${label})`);
      return label;
    }
  }
  if (writable.has("off")) {
    // The off fallback must record the change too, or a deepseek-official
    // deployment restricted to off would silently write nothing.
    if (current !== "off") {
      warnings.push(`Current default effort '${current ?? "unset"}' is not writable; using 'off'.`);
      changes.push(`~ agent-default-model.reasoningEffort (${current ?? "unset"} -> off)`);
    }
    return "off";
  }
  return undefined;
}

export function patchDshSettings(options: {
  settingsText: string;
  target: DshTarget;
  manifest: CapabilityManifest;
  patchOptions?: DshPatchOptions;
}): DshPatchResult {
  const { settingsText, target, manifest, patchOptions } = options;
  const doc = parseDocument(settingsText);
  const warnings: string[] = [];
  const changes: string[] = [];
  let defaultEffort: string | undefined;

  const noop = (): DshPatchResult => ({ candidateText: settingsText, changed: false, changes: [], warnings, writeTarget: "none" });

  const protocol = selectVerifiedProtocol(manifest);
  if (!protocol) {
    warnings.push("No VERIFIED protocol for this endpoint; no reasoning controls were written.");
    return noop();
  }

  const mapped = verifiedLabelMap(manifest, protocol);
  if (mapped.size === 0) {
    warnings.push(`Reasoning controls for ${protocol} are not VERIFIED; no reasoningEfforts were written.`);
    return noop();
  }

  // --- DSH capability intersection: endpoint VERIFIED ∩ adapter ∩ deployment ---
  const adapterCapabilities = patchOptions?.adapterCapabilities ?? getDshAdapterCapabilities(target.providerKind as DshAdapterProviderKind);
  const deploymentCapabilities = patchOptions?.deploymentCapabilities;
  if (adapterCapabilities.warning) warnings.push(adapterCapabilities.warning);
  if (deploymentCapabilities?.warning) warnings.push(deploymentCapabilities.warning);
  const computation = computeWritableReasoningEfforts({
    verifiedEfforts: [...mapped.keys()],
    adapterCapabilities,
    ...(deploymentCapabilities ? { deploymentCapabilities } : {}),
  });
  if (!computation.safeToWrite) {
    warnings.push("Recommended: use an llm-pi-ai custom route for the full capability mapping.");
    return noop();
  }
  const writable = new Set(computation.writable);
  if (writable.size === 0) {
    warnings.push(
      deploymentCapabilities?.allowedReasoningEfforts
        ? "No writable reasoning effort remains after applying DSH deployment constraints."
        : "No VERIFIED reasoning effort intersects the DSH adapter's allowed set; nothing written.",
    );
    return noop();
  }
  const values = Object.fromEntries([...mapped.entries()].filter(([label]) => writable.has(label))) as Record<string, Scalar>;
  let writeTarget: DshPatchResult["writeTarget"] = "none";

  if (target.providerKind === "deepseek-official") {
    // deepseek-official exposes no per-model reasoningEfforts surface in
    // settings.yaml; only agent-default-model.reasoningEffort can change.
    // That global value may only be touched when the sync target IS the
    // global default model; a non-default target never demotes it.
    if (target.isDefaultModel === false) {
      warnings.push("Target model is not the global default model; agent-default-model.reasoningEffort was left untouched.");
      return noop();
    }
    defaultEffort = chooseDefaultEffort(patchOptions?.defaultEffort, writable, target.reasoningEffort, changes, warnings);
    if (defaultEffort !== undefined) {
      doc.setIn(["agent-default-model", "reasoningEffort"], defaultEffort);
    }
    if (changes.length === 0) {
      warnings.push("deepseek-official exposes no per-model reasoningEfforts in settings.yaml; only agent-default-model.reasoningEffort may change.");
      return noop();
    }
  } else {
    // --- llm-pi-ai leaf patch ---
    const base = providerPath(target.provider);
    const providerNode = doc.getIn(base, true);
    if (!(providerNode instanceof YAMLMap)) {
      warnings.push(`Provider node ${base.join(".")} is missing in settings.yaml; nothing written.`);
      return noop();
    }

    if (target.targetInModels) {
      const modelsNode = doc.getIn([...base, "models"], true);
      const index = modelsNode instanceof YAMLSeq
        ? modelsNode.items.findIndex((item) => item instanceof YAMLMap && String(item.get("id")) === target.model)
        : -1;
      if (index >= 0) {
        mergeLeafMap(doc, [...base, "models", index, "reasoningEfforts"], values, changes);
        writeTarget = "models";
      } else {
        warnings.push(`Model '${target.model}' was not found in the explicit models list; using modelOverrides instead.`);
        writeTarget = "modelOverrides";
      }
    } else {
      writeTarget = "modelOverrides";
    }

    if (writeTarget === "modelOverrides") {
      const overrideNode = doc.getIn([...base, "modelOverrides"], true);
      if (overrideNode !== undefined && !(overrideNode instanceof YAMLMap)) {
        warnings.push("modelOverrides exists but is not a mapping; no reasoningEfforts written to avoid data loss.");
        writeTarget = "none";
      } else {
        const targetNode = doc.getIn([...base, "modelOverrides", target.model], true);
        if (targetNode !== undefined && !(targetNode instanceof YAMLMap)) {
          warnings.push(`modelOverrides.${target.model} exists but is not a mapping; nothing written to avoid data loss.`);
          writeTarget = "none";
        } else {
          mergeLeafMap(doc, [...base, "modelOverrides", target.model, "reasoningEfforts"], values, changes);
        }
      }
    }

    if (writeTarget !== "none" && changes.length > 0 && target.isDefaultModel !== false) {
      defaultEffort = chooseDefaultEffort(
        patchOptions?.defaultEffort,
        writable,
        target.reasoningEffort,
        changes,
        warnings,
      );
      if (defaultEffort !== undefined) {
        doc.setIn(["agent-default-model", "reasoningEffort"], defaultEffort);
      }
    } else if (writeTarget !== "none" && changes.length > 0 && target.isDefaultModel === false) {
      warnings.push("Target model is not the global default model; agent-default-model.reasoningEffort was left untouched.");
    }
  }

  let candidateText = doc.toString();
  if (settingsText.includes("\r\n")) candidateText = candidateText.replace(/\n/g, "\r\n");
  const changed = candidateText !== settingsText;
  return { candidateText, changed, changes, warnings, defaultEffort, writeTarget: changed ? writeTarget : "none" };
}

export type { ReasoningDialectCapability, ReasoningLevelCapability };