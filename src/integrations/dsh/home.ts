import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the DSH home directory.
 *
 * Priority: explicit --dsh-home > process.env.DSH_HOME > ~/.dsh.
 * Cross-platform (homedir() from node:os; never hard-codes a Windows user path).
 */
export function resolveDshHome(explicit?: string): string {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const envHome = process.env.DSH_HOME;
  if (typeof envHome === "string" && envHome.trim() !== "") return envHome.trim();
  return join(homedir(), ".dsh");
}

export function dshSettingsPath(home: string): string {
  return join(home, "settings.yaml");
}

export function dshCredentialsPath(home: string): string {
  return join(home, ".credentials.yaml");
}
