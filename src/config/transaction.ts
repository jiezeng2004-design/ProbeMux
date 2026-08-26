import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ConfigDiffPlan {
  schemaVersion: "0.1.0";
  kind: "probemux.config-diff-plan";
  targetPath: string;
  candidatePath: string;
  beforeSha256: string | null;
  afterSha256: string;
  diff: string;
  createdAt: string;
}

export interface ApplyResult {
  targetPath: string;
  backupPath: string | null;
  afterSha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function unifiedDiff(before: string, after: string, beforeLabel = "current", afterLabel = "candidate"): string {
  if (before === after) return `--- ${beforeLabel}\n+++ ${afterLabel}\n`;
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const header = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  ];
  return `${[
    ...header,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n")}\n`;
}

export async function createConfigDiffPlan(options: {
  currentPath: string;
  candidatePath: string;
  planPath: string;
  createdAt?: string;
}): Promise<ConfigDiffPlan> {
  const targetPath = resolve(options.currentPath);
  const candidatePath = resolve(options.candidatePath);
  const planPath = resolve(options.planPath);
  if (targetPath === candidatePath) throw new Error("Current and candidate paths must be different.");
  const before = await readOptional(targetPath);
  const after = await readFile(candidatePath, "utf8");
  const plan: ConfigDiffPlan = {
    schemaVersion: "0.1.0",
    kind: "probemux.config-diff-plan",
    targetPath,
    candidatePath,
    beforeSha256: before === null ? null : sha256(before),
    afterSha256: sha256(after),
    diff: unifiedDiff(before ?? "", after, targetPath, candidatePath),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return plan;
}

function assertPlan(value: unknown): asserts value is ConfigDiffPlan {
  if (typeof value !== "object" || value === null) throw new Error("Diff plan must be an object.");
  const plan = value as Partial<ConfigDiffPlan>;
  if (plan.schemaVersion !== "0.1.0" || plan.kind !== "probemux.config-diff-plan") {
    throw new Error("Unsupported config diff plan.");
  }
  if (typeof plan.targetPath !== "string" || typeof plan.candidatePath !== "string" || typeof plan.afterSha256 !== "string") {
    throw new Error("Config diff plan is incomplete.");
  }
}

function backupSuffix(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
}

export async function applyConfigDiffPlan(options: {
  planPath: string;
  confirmation: string | undefined;
  now?: Date;
}): Promise<ApplyResult> {
  if (options.confirmation !== "APPLY") {
    throw new Error("Refusing to modify configuration. Re-run with --confirm APPLY after reviewing the diff.");
  }
  const planValue: unknown = JSON.parse(await readFile(resolve(options.planPath), "utf8"));
  assertPlan(planValue);
  const plan = planValue;
  const before = await readOptional(plan.targetPath);
  const currentHash = before === null ? null : sha256(before);
  if (currentHash !== plan.beforeSha256) {
    throw new Error("Target configuration changed after diff generation; create a new diff plan.");
  }
  const candidate = await readFile(plan.candidatePath);
  if (sha256(candidate) !== plan.afterSha256) {
    throw new Error("Candidate configuration changed after diff generation; create a new diff plan.");
  }

  await mkdir(dirname(plan.targetPath), { recursive: true });
  let backupPath: string | null = null;
  let mode = 0o600;
  if (before !== null) {
    const metadata = await stat(plan.targetPath);
    mode = metadata.mode;
    backupPath = `${plan.targetPath}.probemux-backup-${backupSuffix(options.now ?? new Date())}`;
    await copyFile(plan.targetPath, backupPath, constants.COPYFILE_EXCL);
  }
  const temporaryPath = `${plan.targetPath}.probemux-tmp-${randomUUID()}`;
  await writeFile(temporaryPath, candidate, { mode, flag: "wx" });
  await rename(temporaryPath, plan.targetPath);
  return { targetPath: plan.targetPath, backupPath, afterSha256: plan.afterSha256 };
}
