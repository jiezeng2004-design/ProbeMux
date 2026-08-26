import type { CapabilityManifest, ManifestEffort } from "../domain/manifest.ts";

export const RENDER_TARGETS = ["codex", "opencode", "dsh"] as const;
export type RenderTarget = (typeof RENDER_TARGETS)[number];

export interface RenderOptions {
  providerId?: string;
  defaultEffort?: ManifestEffort;
  apiKeyEnv?: string;
  allowUnverified?: boolean;
}

export interface RenderResult {
  target: RenderTarget;
  content: string;
  warnings: string[];
  omittedLevels: ManifestEffort[];
  safety: "VERIFIED" | "REVIEW_REQUIRED" | "BLOCKED";
}

export type ManifestRenderer = (manifest: CapabilityManifest, options?: RenderOptions) => RenderResult;
