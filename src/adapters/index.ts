import type { CapabilityManifest } from "../domain/manifest.ts";
import { renderCodex } from "./codex.ts";
import { renderDsh } from "./dsh.ts";
import { renderOpenCode } from "./opencode.ts";
import type { RenderOptions, RenderResult, RenderTarget } from "./types.ts";

export function renderManifest(manifest: CapabilityManifest, target: RenderTarget, options: RenderOptions = {}): RenderResult {
  if (target === "dsh") return renderDsh(manifest, options);
  if (target === "codex") return renderCodex(manifest, options);
  if (target === "opencode") return renderOpenCode(manifest, options);
  const exhaustive: never = target;
  throw new Error(`Unsupported render target: ${String(exhaustive)}`);
}

export const renderProfile = renderManifest;

export * from "./types.ts";
