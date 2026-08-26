import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { registerResolvedSecret } from "../../security.ts";
import type { CredentialSource } from "./types.ts";

export interface CredentialResult {
  /** The raw secret, in process memory only. Never print it. */
  value: string | undefined;
  source: CredentialSource;
}

export const CREDENTIAL_SOURCE_LABELS: Record<CredentialSource, string> = {
  "process-env": "process env",
  "credentials-yaml": ".credentials.yaml",
  "cwd-dotenv": "cwd/.env",
  "dsh-home-dotenv": "DSH_HOME/.env",
  unresolved: "missing",
};

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Minimal .env parser: KEY=VALUE lines, # comments, optional quotes.
 *
 * The VALUE is deliberately NOT trimmed: a padded credential must reach
 * registerResolvedSecret with its raw whitespace so the unified boundary can
 * fail it closed. Silently trimming here would re-introduce the
 * "auto-trim and send" path that changes credential semantics.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    // trimStart only: leading indentation is tolerated, but trailing
    // whitespace is part of the VALUE and must reach the credential boundary
    // untouched so padded credentials fail closed.
    const line = raw.trimStart();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1);
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve an API key by reference only. Priority matches DSH:
 * 1. current ProbeMux process environment
 * 2. $DSH_HOME/.credentials.yaml
 * 3. invocation cwd/.env
 * 4. $DSH_HOME/.env
 *
 * The .credentials.yaml step is FAIL-CLOSED:
 * - file absent -> continue to the next source
 * - file valid but key absent -> continue to the next source
 * - file present but YAML malformed, top level is not a key-value mapping, or
 *   the target key is null / not a string / empty -> FAIL (no fallback).
 *   ProbeMux must never silently use a credential that DSH itself would not
 *   use from the same file.
 *
 * A resolved value shorter than 4 characters is rejected (CredentialTooShortError)
 * instead of being used: it cannot be safely redacted, and the selected source
 * fails instead of falling back to a lower-priority credential.
 *
 * The resolved value is returned (and registered for redaction); it is never
 * written to any output.
 */
export async function resolveCredential(options: {
  apiKeyEnv: string;
  dshHome: string;
  cwd?: string;
}): Promise<CredentialResult> {
  const { apiKeyEnv, dshHome } = options;
  if (!apiKeyEnv) return { value: undefined, source: "unresolved" };
  const cwd = options.cwd ?? process.cwd();

  const envValue = process.env[apiKeyEnv];
  if (envValue) {
    // Fail-closed: a too-short value throws here, so the process env source is
    // never silently skipped in favour of a lower-priority credential.
    registerResolvedSecret(envValue, { credentialName: apiKeyEnv });
    return { value: envValue, source: "process-env" };
  }

  const credentialsText = await readOptional(join(dshHome, ".credentials.yaml"));
  if (credentialsText !== null) {
    const credentialsPath = join(dshHome, ".credentials.yaml");
    let data: unknown;
    try {
      data = parse(credentialsText);
    } catch {
      throw new Error(`Failed to parse DSH credential file:
${credentialsPath}`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`DSH credential file ${credentialsPath} must contain a key-value mapping.`);
    }
    const record = data as Record<string, unknown>;
    if (apiKeyEnv in record) {
      const value = record[apiKeyEnv];
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Credential '${apiKeyEnv}' exists in .credentials.yaml but is not a valid non-empty string.`);
      }
      registerResolvedSecret(value, { credentialName: apiKeyEnv });
      return { value, source: "credentials-yaml" };
    }
    // Valid mapping without the target key: continue fallback.
  }

  const cwdEnvText = await readOptional(join(cwd, ".env"));
  if (cwdEnvText !== null) {
    const parsed = parseDotenv(cwdEnvText);
    if (parsed[apiKeyEnv]) {
      registerResolvedSecret(parsed[apiKeyEnv], { credentialName: apiKeyEnv });
      return { value: parsed[apiKeyEnv], source: "cwd-dotenv" };
    }
  }

  const homeEnvText = await readOptional(join(dshHome, ".env"));
  if (homeEnvText !== null) {
    const parsed = parseDotenv(homeEnvText);
    if (parsed[apiKeyEnv]) {
      registerResolvedSecret(parsed[apiKeyEnv], { credentialName: apiKeyEnv });
      return { value: parsed[apiKeyEnv], source: "dsh-home-dotenv" };
    }
  }

  return { value: undefined, source: "unresolved" };
}