#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineCommand, type CommandDef, runMain } from "citty";

import { committedScopeExemptGlobs, loadGraceLintConfig } from "../lint/config";
import { GraceCommandError, runGraceCommand } from "../query/errors";
import { checkCommittedScope, type CommittedScopeReport } from "./committed-scope";
import { detectGraceProjectKind, resolveGrace4Paths } from "./project";
import { projectSlug, resolveLogRoot } from "./run-log-store";
import { ANCHOR_PATTERNS } from "./types";
import { readGraceXmlArtifact } from "./xml";

/** Status every archived bundle artifact carries once the change is applied. */
const APPLIED_STATUS = "applied";

/** Status both bundle artifacts must carry before a change may be archived. */
const APPROVED_STATUS = "approved";

/** Root element expected at the top of each bundle artifact. */
const BUNDLE_ARTIFACTS = [
  { file: "spec.xml", rootTag: "GraceChangeSpec" },
  { file: "plan.xml", rootTag: "GraceChangePlan" },
] as const;

/** Options accepted by the archive operation. */
export type ArchiveOptions = {
  /** C-* anchor of the active bundle to archive. */
  changeId: string;
  /** Overrides resolveLogRoot() for tests. */
  logRoot?: string;
};

/** Final-run evidence accepted as the precondition for archiving. */
export type ArchiveEvidence = {
  runId: string;
  runDir: string;
  status: string;
  assertionMode: string;
  startedAt: string;
  finishedAt: string;
  /** True only when the run recorded a VCS head that matched the current HEAD. */
  headVerified: boolean;
  /** Head recorded in meta.json; null for a run outside git or written before schema 1.1.0. */
  recordedHead: string | null;
};

/** One status attribute rewritten in place. */
export type ArchiveStatusFlip = {
  file: string;
  from: string;
  to: string;
};

/** Result of one completed archive operation. */
export type ArchiveResult = {
  schemaVersion: "1.0.0";
  tool: "grace-archive";
  generatedAt: string;
  root: string;
  changeId: string;
  from: string;
  to: string;
  evidence: ArchiveEvidence;
  /** Committed-scope report for the change; the archive proceeds only when it holds no error. */
  committedScope: CommittedScopeReport;
  /** Warning-severity issues of the committed-scope check, in the order the check raised them. */
  committedScopeWarnings: { code: string; message: string }[];
  statusFlips: ArchiveStatusFlip[];
  moveMode: "git" | "filesystem";
  /** True when the rename and the flipped content were staged. The archive never commits. */
  staged: boolean;
  warnings: string[];
};

/** Located start tag of one XML document root element. */
type RootStartTag = {
  tagName: string;
  start: number;
  end: number;
};

/** meta.json fields the archive gate reads. Unknown fields are tolerated. */
type RunMetaEvidence = {
  changeId: unknown;
  assertionMode: unknown;
  status: unknown;
  startedAt: unknown;
  finishedAt: unknown;
  /**
   * VCS head recorded by lint. Absent in meta.json written before schema 1.1.0 and null outside a
   * git repository; either way the gate degrades to run-identity matching with an explicit warning.
   */
  head?: unknown;
  /** Whether the tree carried uncommitted changes when the run started; recorded with `head`. */
  dirty?: unknown;
};

/** Refusal carrying the stable `precondition-failed` code. */
function refuse(message: string): GraceCommandError {
  return new GraceCommandError("precondition-failed", message);
}

/**
 * Finds the start tag of the document root element, skipping the XML declaration, comments,
 * and doctype. Returns the tag name plus the byte range covering `<Tag ...>` so attribute
 * edits can never touch a descendant element carrying its own `status` attribute.
 */
export function locateRootStartTag(text: string): RootStartTag | null {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open < 0) {
      return null;
    }
    const next = text[open + 1];
    if (next === "?") {
      const close = text.indexOf("?>", open);
      if (close < 0) return null;
      index = close + 2;
      continue;
    }
    if (next === "!") {
      if (text.startsWith("<!--", open)) {
        const close = text.indexOf("-->", open);
        if (close < 0) return null;
        index = close + 3;
        continue;
      }
      const close = text.indexOf(">", open);
      if (close < 0) return null;
      index = close + 1;
      continue;
    }
    if (!next || !/[A-Za-z_]/.test(next)) {
      return null;
    }

    let quote: string | null = null;
    for (let cursor = open + 1; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") {
        const tagName = /^<([^\s/>]+)/.exec(text.slice(open, cursor + 1))?.[1];
        return tagName ? { tagName, start: open, end: cursor + 1 } : null;
      }
    }
    return null;
  }
  return null;
}

/**
 * Rewrites the `status` attribute of the document root element without reserializing the XML,
 * so the archive produces a one-attribute diff instead of a whole-file reformat. Refuses unless
 * the root start tag carries exactly one `status` attribute holding the expected value.
 */
export function rewriteRootStatusAttribute(text: string, file: string, expectedRootTag: string, expected: string, next: string): string {
  const root = locateRootStartTag(text);
  if (!root) {
    throw refuse(`${file} has no readable root start tag, so its status attribute cannot be flipped.`);
  }
  if (root.tagName !== expectedRootTag) {
    throw refuse(`${file} root element is <${root.tagName}>, expected <${expectedRootTag}>.`);
  }

  const startTag = text.slice(root.start, root.end);
  const matches = [...startTag.matchAll(/(\sstatus\s*=\s*)("([^"]*)"|'([^']*)')/g)];
  if (matches.length !== 1) {
    throw refuse(`${file} root element carries ${matches.length} status attributes; exactly one is required.`);
  }

  const match = matches[0];
  const quote = match[2][0];
  const current = match[3] ?? match[4] ?? "";
  if (current !== expected) {
    throw refuse(`${file} root status is "${current}", expected "${expected}".`);
  }

  const offset = match.index ?? 0;
  const replaced = `${startTag.slice(0, offset)}${match[1]}${quote}${next}${quote}${startTag.slice(offset + match[0].length)}`;
  return `${text.slice(0, root.start)}${replaced}${text.slice(root.end)}`;
}

function readEvidenceMeta(metaFile: string): RunMetaEvidence | null {
  try {
    const parsed = JSON.parse(readFileSync(metaFile, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RunMetaEvidence) : null;
  } catch {
    return null;
  }
}

function runSortKey(meta: RunMetaEvidence, runId: string): string {
  return `${typeof meta.startedAt === "string" ? meta.startedAt : ""}|${runId}`;
}

/**
 * Selects the most recent `final` run recorded for one change id. Run status reflects declared
 * command exit codes only; structural lint results are not recorded in meta.json.
 */
function selectFinalRun(logRoot: string, root: string, changeId: string, warnings: string[]) {
  const runsParent = path.join(logRoot, projectSlug(root), "runs");
  let entries: string[];
  try {
    entries = readdirSync(runsParent);
  } catch {
    return null;
  }

  let best: { runId: string; runDir: string; meta: RunMetaEvidence; key: string } | null = null;
  for (const runId of entries) {
    const runDir = path.join(runsParent, runId);
    const metaFile = path.join(runDir, "meta.json");
    if (!existsSync(metaFile)) continue;
    const meta = readEvidenceMeta(metaFile);
    if (!meta) {
      warnings.push(`Ignored unreadable run evidence at ${metaFile}.`);
      continue;
    }
    if (meta.changeId !== changeId || meta.assertionMode !== "final") continue;
    const key = runSortKey(meta, runId);
    if (!best || key > best.key) {
      best = { runId, runDir, meta, key };
    }
  }
  return best;
}

function resolveGitHead(root: string): string | null {
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim() || null;
}

/**
 * Requires a passing final run for the change. When meta.json records a head, the run must have
 * started on a clean tree at the current HEAD, because a matching head proves nothing about
 * uncommitted changes. A run with no recorded head matches on run identity only and warns that
 * the tree the evidence describes cannot be confirmed.
 */
function requireFinalRunEvidence(root: string, options: ArchiveOptions, warnings: string[]): ArchiveEvidence {
  const logRoot = options.logRoot ?? resolveLogRoot();
  const selected = selectFinalRun(logRoot, root, options.changeId, warnings);
  if (!selected) {
    throw refuse(
      `No final run evidence was recorded for ${options.changeId}. Run \`grace lint --path ${root} --change ${options.changeId} --assertions final --run-commands\`. `
      + "A plan that declares no MustPassCommand records no run at all and cannot be archived, and run evidence older than the retention window is pruned; rerun the final gate in both cases.",
    );
  }

  const status = typeof selected.meta.status === "string" ? selected.meta.status : "unknown";
  if (status !== "passed") {
    throw refuse(`The most recent final run for ${options.changeId} recorded status "${status}" at ${selected.runDir}. Archive requires a passing final run.`);
  }

  const recordedHead = typeof selected.meta.head === "string" && selected.meta.head.trim() ? selected.meta.head.trim() : null;
  let headVerified = false;
  if (recordedHead) {
    const currentHead = resolveGitHead(root);
    if (!currentHead) {
      throw refuse(`Final run ${selected.runId} recorded head ${recordedHead}, but the current HEAD could not be resolved.`);
    }
    if (currentHead !== recordedHead) {
      throw refuse(`Final run ${selected.runId} recorded head ${recordedHead}, which is not the current HEAD ${currentHead}. Rerun the final gate.`);
    }
    if (selected.meta.dirty === true) {
      throw refuse(`Final run ${selected.runId} ran against uncommitted changes, so it cannot prove the committed tree. Commit the work, then rerun the final gate.`);
    }
    if (selected.meta.dirty !== false) {
      throw refuse(`Final run ${selected.runId} recorded head ${recordedHead} but did not record whether the tree was clean. Rerun the final gate.`);
    }
    headVerified = true;
  } else {
    warnings.push(
      `Final run ${selected.runId} records no VCS head, so archive verified run identity only and cannot confirm the evidence describes the current tree.`,
    );
  }

  return {
    runId: selected.runId,
    runDir: selected.runDir,
    status,
    assertionMode: "final",
    startedAt: typeof selected.meta.startedAt === "string" ? selected.meta.startedAt : "",
    finishedAt: typeof selected.meta.finishedAt === "string" ? selected.meta.finishedAt : "",
    headVerified,
    recordedHead,
  };
}

/** Git facts the archive needs. All fields are false when the project is not a git worktree. */
type GitContext = {
  available: boolean;
  tracked: boolean;
};

function runGit(root: string, args: string[]) {
  try {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function splitNulPaths(output: string): string[] {
  return output.split("\0").map((entry) => entry.replaceAll("\\", "/")).filter(Boolean);
}

/**
 * Refuses when the index holds anything outside the change bundle, so the archive commit the
 * caller makes next can only ever contain the bundle. When the evidence was verified against a
 * clean tree at HEAD, also refuses any tracked or untracked change outside the bundle, because the
 * tree no longer matches the one the final run proved. Paths are compared project-relative.
 */
function inspectGitContext(root: string, bundleRelative: string, archiveRelative: string, requireCleanTree: boolean, warnings: string[]): GitContext {
  if (runGit(root, ["rev-parse", "--is-inside-work-tree"]).exitCode !== 0) {
    warnings.push("Project is not a git worktree, so the staged-file check was skipped and the bundle was moved on the filesystem.");
    return { available: false, tracked: false };
  }

  const staged = runGit(root, ["diff", "--cached", "--name-only", "--relative", "-z", "--", "."]);
  if (staged.exitCode !== 0) {
    throw refuse(`Unable to inspect the git index: ${staged.stderr.trim() || "git diff --cached failed"}.`);
  }
  const outsideBundle = (entry: string) => !entry.startsWith(`${bundleRelative}/`) && !entry.startsWith(`${archiveRelative}/`);
  const foreign = splitNulPaths(staged.stdout).filter(outsideBundle);
  if (foreign.length > 0) {
    throw refuse(
      `The index holds ${foreign.length} staged file(s) outside the ${bundleRelative} bundle: ${foreign.slice(0, 5).join(", ")}. `
      + "Commit or unstage them so the archive commit carries the bundle alone.",
    );
  }

  if (requireCleanTree) {
    const modified = runGit(root, ["diff", "HEAD", "--name-only", "--relative", "-z", "--", "."]);
    const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
    if (modified.exitCode !== 0 || untracked.exitCode !== 0) {
      throw refuse(`Unable to inspect the worktree: ${(modified.exitCode !== 0 ? modified.stderr : untracked.stderr).trim() || "git failed"}.`);
    }
    const changed = [...splitNulPaths(modified.stdout), ...splitNulPaths(untracked.stdout)].filter(outsideBundle);
    if (changed.length > 0) {
      throw refuse(
        `${changed.length} file(s) changed outside the ${bundleRelative} bundle since the final run: ${changed.slice(0, 5).join(", ")}. `
        + "Commit them and rerun the final gate, or revert them.",
      );
    }
  }

  const tracked = runGit(root, ["ls-files", "-z", "--", bundleRelative]);
  const isTracked = tracked.exitCode === 0 && tracked.stdout.split("\0").filter(Boolean).length > 0;
  if (!isTracked) {
    warnings.push(`${bundleRelative} is not tracked by git, so the bundle was moved on the filesystem and nothing was staged.`);
  }
  return { available: true, tracked: isTracked };
}

/** Cap on the issues named in a committed-scope refusal; the rest are counted. */
const REFUSAL_ISSUE_CAP = 10;

/**
 * Runs the committed-scope check with the project's lint configuration and refuses on any error-severity
 * issue. Warnings never refuse; they are returned with the report.
 */
function requireCommittedScope(root: string, changeId: string): { report: CommittedScopeReport; warnings: { code: string; message: string }[] } {
  const { config } = loadGraceLintConfig(root);
  const { issues, report } = checkCommittedScope(root, changeId, {
    requireChangeTrailers: config?.requireChangeTrailers ?? false,
    exempt: committedScopeExemptGlobs(config),
  });
  const errors = issues.filter((entry) => entry.severity === "error");
  if (report.failed) {
    throw refuse(
      `The committed-scope check for ${changeId} could not run (scope.committed-check-failed): ${report.failed}. `
      + "Fix the git error and run grace archive again; nothing was written.",
    );
  }
  // scope.approval-uncommitted is the only error a new commit clears; the check returns before classifying anything else.
  if (errors.length > 0 && errors.every((entry) => entry.code === "scope.approval-uncommitted")) {
    throw refuse(
      `The committed-scope check for ${changeId} found no committed approval (scope.approval-uncommitted ${errors[0]!.file}). `
      + "Commit the approved plan.xml, rerun the final gate, then run grace archive again. Nothing was written.",
    );
  }
  if (errors.length > 0) {
    const listed = errors.slice(0, REFUSAL_ISSUE_CAP).map((entry) => `${entry.code} ${entry.file}`);
    const more = errors.length > listed.length ? ` and ${errors.length - listed.length} more` : "";
    throw refuse(
      `The committed-scope check for ${changeId} found ${errors.length} error(s): ${listed.join("; ")}${more}. `
      + "They are fixed in history, and no new commit clears them: stop and report them to the user, who chooses "
      + "between rewriting unpublished history and superseding the bundle. Nothing was written.",
    );
  }
  const warnings = issues.filter((entry) => entry.severity === "warning").map((entry) => ({ code: entry.code, message: entry.message }));
  return { report, warnings };
}

/**
 * Archives one active change bundle: verifies a passing final run, refuses a dirty index, refuses on
 * committed-scope errors, flips
 * both root statuses to `applied`, and moves the bundle into .grace/changes/archive. The move is
 * staged when git owns the bundle and is never committed. Every precondition is checked before
 * the first byte is written, and a failed move restores the pre-flip artifact contents.
 */
export async function archiveChange(projectRoot: string, options: ArchiveOptions): Promise<ArchiveResult> {
  const root = path.resolve(projectRoot);
  const warnings: string[] = [];

  if (detectGraceProjectKind(root) !== "grace4") {
    throw new GraceCommandError("invalid-project", `No GRACE 4 .grace directory was found at ${root}.`);
  }
  if (!ANCHOR_PATTERNS.change.test(options.changeId)) {
    throw new GraceCommandError("invalid-arguments", `Invalid change id \`${options.changeId}\`. Use a C-* anchor such as C-ARCHIVE-COMMAND.`);
  }

  const paths = resolveGrace4Paths(root);
  const bundleDir = path.join(paths.changesActiveDir, options.changeId);
  const destinationDir = path.join(paths.changesArchiveDir, options.changeId);
  const bundleRelative = path.relative(root, bundleDir).replaceAll(path.sep, "/");
  const destinationRelative = path.relative(root, destinationDir).replaceAll(path.sep, "/");

  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    throw new GraceCommandError("not-found", `No active change bundle at ${bundleRelative}.`);
  }
  if (existsSync(destinationDir)) {
    throw refuse(`${destinationRelative} already exists. Resolve the existing archived bundle before archiving again.`);
  }

  const pending = BUNDLE_ARTIFACTS.map((artifact) => {
    const file = path.join(bundleDir, artifact.file);
    if (!existsSync(file)) {
      throw refuse(`${bundleRelative}/${artifact.file} is missing. A complete bundle carries spec.xml and plan.xml.`);
    }
    const parsed = readGraceXmlArtifact(file);
    if (!parsed.root) {
      throw refuse(`${bundleRelative}/${artifact.file} could not be parsed: ${parsed.issues[0]?.message ?? "unknown parse failure"}.`);
    }
    if (parsed.root.attributes.status !== APPROVED_STATUS) {
      throw refuse(`${bundleRelative}/${artifact.file} has status "${parsed.root.attributes.status ?? "missing"}", expected "${APPROVED_STATUS}".`);
    }
    const original = readFileSync(file, "utf8");
    return {
      file,
      relative: `${bundleRelative}/${artifact.file}`,
      original,
      flipped: rewriteRootStatusAttribute(original, `${bundleRelative}/${artifact.file}`, artifact.rootTag, APPROVED_STATUS, APPLIED_STATUS),
    };
  });

  const evidence = requireFinalRunEvidence(root, options, warnings);
  const git = inspectGitContext(root, bundleRelative, destinationRelative, evidence.headVerified, warnings);
  const useGit = git.available && git.tracked;
  const { report: committedScope, warnings: committedScopeWarnings } = requireCommittedScope(root, options.changeId);

  for (const artifact of pending) {
    writeFileSync(artifact.file, artifact.flipped);
  }

  try {
    mkdirSync(paths.changesArchiveDir, { recursive: true });
    if (useGit) {
      const staged = runGit(root, ["add", "--", bundleRelative]);
      if (staged.exitCode !== 0) {
        throw new Error(staged.stderr.trim() || "git add failed");
      }
      const moved = runGit(root, ["mv", "--", bundleRelative, destinationRelative]);
      if (moved.exitCode !== 0) {
        throw new Error(moved.stderr.trim() || "git mv failed");
      }
    } else {
      renameSync(bundleDir, destinationDir);
    }
  } catch (error) {
    const restoreFailures: string[] = [];
    for (const artifact of pending) {
      try {
        if (existsSync(artifact.file)) writeFileSync(artifact.file, artifact.original);
      } catch {
        restoreFailures.push(artifact.relative);
      }
    }
    // `git add` may already have staged the flipped content, so restoring the worktree alone would
    // leave `applied` in the index at the active path and reintroduce the defect this command prevents.
    if (useGit && runGit(root, ["reset", "-q", "--", bundleRelative]).exitCode !== 0) {
      restoreFailures.push(`${bundleRelative} (staged copy)`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (restoreFailures.length > 0) {
      throw refuse(`Archive move failed (${detail}) and the status flip could not be rolled back in: ${restoreFailures.join(", ")}. Restore these files by hand.`);
    }
    throw refuse(
      `Archive move failed (${detail}). The status flip was rolled back in ${bundleRelative}`
      + `${useGit ? " and its index entries were reset to HEAD" : ""}.`,
    );
  }

  return {
    schemaVersion: "1.0.0",
    tool: "grace-archive",
    generatedAt: new Date().toISOString(),
    root,
    changeId: options.changeId,
    from: bundleRelative,
    to: destinationRelative,
    evidence,
    committedScope,
    committedScopeWarnings,
    statusFlips: pending.map((artifact) => ({ file: `${destinationRelative}/${path.basename(artifact.file)}`, from: APPROVED_STATUS, to: APPLIED_STATUS })),
    moveMode: useGit ? "git" : "filesystem",
    staged: useGit,
    warnings,
  };
}

/** Cap on the entries of one committed-scope text list, as in the lint report; the rest are counted. */
const COMMITTED_SCOPE_LIST_CAP = 20;

/** At most 20 entries joined with commas, then a count of the rest. */
function capInline(entries: string[]): string {
  const shown = entries.slice(0, COMMITTED_SCOPE_LIST_CAP).join(", ");
  return entries.length > COMMITTED_SCOPE_LIST_CAP ? `${shown}, … ${entries.length - COMMITTED_SCOPE_LIST_CAP} more` : shown;
}

/** True when the check classified committed files: it ran, and the change owns at least one commit. */
function classifiedCommittedFiles(report: CommittedScopeReport): boolean {
  return !report.skipped && report.ownedCommits > 0;
}

/**
 * Renders the committed-scope report as the `Committed scope` text section. When the check was skipped or the
 * change owns no commit, the file lists are replaced by a statement that nothing was classified and the warning
 * that explains it, so an empty list is never read as a clean result.
 */
function formatCommittedScope(report: CommittedScopeReport, warnings: { code: string; message: string }[]): string[] {
  const listing = (label: string, entries: string[]) => [`- ${label}: ${entries.length > 0 ? capInline(entries) : "none"}`];
  const warningLines = warnings.map((warning) => `- Warning ${warning.code}: ${warning.message}`);
  if (report.skipped) {
    return ["Committed scope", `- Check skipped (${report.skipped}); nothing was classified.`, ...warningLines];
  }
  const planHistory = [
    ...listing("Plan amendments", report.amendments.map((entry) => `${entry.commit} (${entry.sections.join(", ")})`)),
    ...listing("Re-approval additions", report.reapprovalAdded.flatMap((entry) => entry.added.map((added) => `${added} (${entry.commit})`))),
    ...listing("Re-approval gate changes", report.reapprovalChangedGates.map((entry) => `${entry.commit} (${entry.sections.join(", ")})`)),
  ];
  if (!classifiedCommittedFiles(report)) {
    return ["Committed scope", "- Owned commits: 0", "- No owned commits; nothing was classified.", ...planHistory, ...warningLines];
  }
  return [
    "Committed scope",
    `- Owned commits: ${report.ownedCommits}`,
    ...listing("Within approved scope", report.approved),
    ...listing("Widened near", report.widenedNear),
    ...listing("Widened far", report.widenedFar),
    ...planHistory,
    ...listing("Exempt", report.exempt),
    ...(report.untaggedInScope.length > 0 ? [`- Untagged commits in scope: ${capInline(report.untaggedInScope)}`] : []),
  ];
}

/** Renders one archive result as the human-readable report. */
export function formatArchiveText(result: ArchiveResult): string {
  const lines = [
    "GRACE Archive",
    "=============",
    `Root: ${result.root}`,
    `Change: ${result.changeId}`,
    `Moved: ${result.from} -> ${result.to}`,
    `Move mode: ${result.moveMode}${result.staged ? " (rename and flipped content staged, not committed)" : " (nothing staged)"}`,
    "",
    "Evidence",
    `- Final run: ${result.evidence.runId} (${result.evidence.status})`,
    `- Run logs: ${result.evidence.runDir}`,
    `- Head verified: ${result.evidence.headVerified ? result.evidence.recordedHead : "no"}`,
    "",
    "Status Flips",
    ...result.statusFlips.map((flip) => `- ${flip.file}: ${flip.from} -> ${flip.to}`),
    "",
    ...formatCommittedScope(result.committedScope, result.committedScopeWarnings),
  ];
  if (result.warnings.length > 0) {
    lines.push("", "Warnings", ...result.warnings.map((warning) => `- ${warning}`));
  }
  lines.push(
    "",
    "Next Action",
    "- Review the staged bundle and commit the archive yourself; grace archive never commits.",
    classifiedCommittedFiles(result.committedScope)
      ? "- Quote the far list, the amendments, the re-approval additions and the re-approval gate changes above in the archive commit body, or state that there are none."
      : "- State in the archive commit body that nothing was classified and quote the committed-scope warning above; quote the amendments, the re-approval additions and the re-approval gate changes.",
  );
  return lines.join("\n");
}

function resolveFormat(format: unknown, json: unknown) {
  const resolved = Boolean(json) ? "json" : String(format ?? "text");
  if (resolved !== "text" && resolved !== "json") throw new GraceCommandError("invalid-arguments", `Unsupported format \`${resolved}\`. Use \`text\` or \`json\`.`);
  return resolved;
}

export const archiveCommand = defineCommand({
  meta: {
    name: "archive",
    description: "Archive an applied GRACE 4 change bundle: verify final-run evidence, flip both statuses to applied, and move the bundle.",
  },
  args: {
    path: { type: "string", alias: "p", description: "Project root to archive in", default: "." },
    change: { type: "string", description: "Active C-* bundle to archive" },
    format: { type: "string", alias: "f", description: "Output format: text or json", default: "text" },
    json: { type: "boolean", description: "Shortcut for --format json", default: false },
  },
  async run(context) {
    const errorFormat = Boolean(context.args.json) || context.args.format === "json" ? "json" : "text";
    await runGraceCommand(errorFormat, async () => {
      const format = resolveFormat(context.args.format, context.args.json);
      const changeId = String(context.args.change ?? "").trim();
      if (!changeId) throw new GraceCommandError("invalid-arguments", "Missing required option `--change C-ID`.");
      const result = await archiveChange(String(context.args.path ?? "."), { changeId });

      if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`${formatArchiveText(result)}\n`);
      process.exitCode = 0;
    }, "Unable to archive the GRACE change. Check the project path and the change id, then run again.");
  },
});

if (import.meta.main) {
  await runMain(archiveCommand as CommandDef);
}
