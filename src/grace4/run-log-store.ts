import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** One executed command recorded in meta.json. */
export type RunMetaCommand = {
  index: number;
  assertionId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  skipped: boolean;
  logFile: string | null;
  /** Run reference this already-passing command was carried over from; absent for executed commands. */
  resumedFrom?: string;
};

/** meta.json written once per lint --run-commands invocation. */
export type RunMeta = {
  schemaVersion: "1.0.0";
  tool: "grace-lint";
  changeId: string | null;
  assertionMode: string;
  projectRoot: string;
  slug: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "timeout" | "interrupted";
  /** Run reference passed to --only-failed; absent for a full run. */
  resumedFrom?: string;
  commands: RunMetaCommand[];
};

/** How many run directories per project survive pruning after each run. */
export const RUN_RETENTION = 10;

/**
 * Resolves the command-run log root: ${XDG_CACHE_HOME:-~/.cache}/grace/run-commands.
 * An empty XDG_CACHE_HOME is ignored per the XDG base directory specification.
 */
export function resolveLogRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir(), ".cache");
  return path.join(base, "grace", "run-commands");
}

/**
 * Stable directory key for one project root: sanitized basename plus the first
 * eight hex characters of the sha1 of the absolute root, so same-named projects
 * in different locations never collide.
 */
export function projectSlug(root: string): string {
  const absolute = path.resolve(root);
  const base = path.basename(absolute).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Creates and returns the run directory runs/yyyy-MM-ddTHH-mm-ss[_C-CHANGE] under
 * logRoot/slug. Same-second collisions append a -2, -3, ... suffix.
 */
export function createRunDir(logRoot: string, slug: string, startedAt: Date, changeId?: string): string {
  const stamp = formatStamp(startedAt);
  const suffix = changeId ? `_${changeId}` : "";
  const runsParent = path.join(logRoot, slug, "runs");
  let candidate = path.join(runsParent, `${stamp}${suffix}`);
  let counter = 2;
  while (existsSafe(candidate)) {
    candidate = path.join(runsParent, `${stamp}${suffix}-${counter}`);
    counter += 1;
  }
  mkdirSync(candidate, { recursive: true });
  return candidate;
}

/**
 * Resolves a --only-failed run reference to an absolute run directory without creating
 * anything: an absolute path is used verbatim, `last` selects the newest run directory
 * under logRoot/slug/runs (the stamped names sort chronologically), and any other value
 * is treated as a run directory name under that same parent. Returns null when nothing
 * matches, which the caller reports as a refusal.
 */
export function resolveRunDirRef(logRoot: string, slug: string, ref: string): string | null {
  const runsParent = path.join(logRoot, slug, "runs");
  if (path.isAbsolute(ref)) {
    return statSafe(ref)?.isDirectory() ? path.resolve(ref) : null;
  }
  if (ref === "last") {
    let entries: string[];
    try {
      entries = readdirSync(runsParent);
    } catch {
      return null;
    }
    const newest = entries
      .filter((name) => statSafe(path.join(runsParent, name))?.isDirectory() ?? false)
      .sort()
      .pop();
    return newest ? path.join(runsParent, newest) : null;
  }
  const candidate = path.join(runsParent, ref);
  return statSafe(candidate)?.isDirectory() ? candidate : null;
}

/** Reads and parses one run directory's meta.json; returns null when missing or unparseable. */
export function readRunMeta(runDir: string): RunMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8")) as RunMeta;
    return parsed && Array.isArray(parsed.commands) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort meta.json write; returns false (never throws) on filesystem errors. */
export function writeRunMeta(runDir: string, meta: RunMeta): boolean {
  try {
    writeFileSync(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the newest `keep` run directories (lexical sort of the timestamped names,
 * which is chronological for the format above) and removes the rest. Missing or
 * empty parents are a no-op; individual removal failures never throw.
 */
export function pruneRuns(projectRunsParent: string, keep: number = RUN_RETENTION): void {
  let entries: string[];
  try {
    entries = readdirSync(projectRunsParent);
  } catch {
    return;
  }
  const dirs = entries
    .filter((name) => statSafe(path.join(projectRunsParent, name))?.isDirectory() ?? false)
    .sort()
    .reverse();
  for (const stale of dirs.slice(keep)) {
    try {
      rmSync(path.join(projectRunsParent, stale), { recursive: true, force: true });
    } catch {
      // Retention pruning is best-effort; a stale directory is harmless.
    }
  }
}

/**
 * Builds the log file name `${index}-${slug}.log` where slug sanitizes the command
 * to lowercase [a-z0-9-] with at most 40 characters, falling back to "command".
 */
export function commandLogFileName(index: number, command: string): string {
  const slug = command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${index}-${slug || "command"}.log`;
}

function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function existsSafe(target: string): boolean {
  try {
    return statSync(target).isFile() || statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function statSafe(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}
