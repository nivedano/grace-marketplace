import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { NearFar, PackageRoots, PathRule } from "./committed-scope-near";
import { comparePlansIgnoringObservedScope, isPlanAmendment } from "./plan-compare";
import { extractObservedWriteScope, observedWriteScopeContains, type ObservedWriteScope } from "./scope";
import type { Grace4Issue } from "./types";
import { parseGraceXmlArtifact, type GraceXmlNode } from "./xml";

/** One committed version of a change's plan.xml. scope is null when the version does not parse. */
export type PlanVersion = {
  commit: string;
  status: string;
  scope: ObservedWriteScope | null;
  parsed: boolean;
};

/** A change's plan history read from git: approval points, mutations, widenings and the scopes they imply. */
export type PlanHistory = {
  /** B: the first commit that contains the bundle's spec.xml or plan.xml, under active/ or archive/. */
  firstCommit: string | null;
  /** A: the first commit in which plan.xml parses with root status approved. */
  approvalCommit: string | null;
  /** A, plus every later commit whose plan status changes into approved from a known other status. */
  approvalPoints: string[];
  versions: PlanVersion[];
  /**
   * Consecutive approved versions after A that differ apart from the wrapper's direct ObservedWriteScope in a gate
   * section: anything but ImplementationPlan and IntentSummary, or an unparseable version.
   */
  mutations: { commit: string; sections: string[] }[];
  /** Consecutive approved versions after A whose only differing sections are ImplementationPlan and IntentSummary. */
  amendments: { commit: string; sections: string[] }[];
  /** Approved plan commits after A that follow an approved version, are not approval points, and gain ObservedWriteScope entries. */
  wideningCommits: { commit: string; added: string[] }[];
  /** Entries a re-approval point added over the last approved version before its gap, minus earlier widening entries. */
  reapprovalAdded: { commit: string; added: string[] }[];
  /**
   * Re-approval points whose plan differs from the last approved version outside ObservedWriteScope in a gate section:
   * anything but ImplementationPlan and IntentSummary, or an unparseable last approved version.
   */
  reapprovalChangedGates: { commit: string; sections: string[] }[];
  /** The scope at A plus reapprovalAdded entries. */
  approvedScope: ObservedWriteScope;
  /** The ObservedWriteScope of plan.xml at HEAD. */
  finalScope: ObservedWriteScope;
  shallow: boolean;
};

/** Reason the history could not be read. */
export type PlanHistorySkip = { skipped: "not-git" | "shallow" };

/** A git command the check needs failed; failed names the command and carries git's stderr. */
export type PlanHistoryFailure = { failed: string };

type GitResult = { ok: boolean; stdout: string; stderr: string };

/** Thrown by requireGit; checkCommittedScope turns it into scope.committed-check-failed. */
class GitCommandFailed extends Error {}

type LoadedVersion = PlanVersion & { root: GraceXmlNode | null };

const APPROVED = "approved";
const ROOT_STATUS = /<GraceChangePlan\b[^>]*?\sstatus\s*=\s*["']([^"']*)["']/;

/**
 * Reads the plan history of changeId from git, whatever the plan's status at HEAD. A project with no .git at or above
 * its root, or a shallow clone in which earlier commits may be missing, is reported as skipped. A git command that
 * fails anywhere else, such as a dubious-ownership refusal, is reported as failed.
 */
export function readPlanHistory(root: string, changeId: string): PlanHistory | PlanHistorySkip | PlanHistoryFailure {
  try {
    return readPlanHistoryOrThrow(root, changeId);
  } catch (error) {
    if (error instanceof GitCommandFailed) {
      return { failed: error.message };
    }
    throw error;
  }
}

function readPlanHistoryOrThrow(root: string, changeId: string): PlanHistory | PlanHistorySkip {
  if (!hasGitAncestor(root)) {
    return { skipped: "not-git" };
  }
  const inside = requireGit(root, ["rev-parse", "--is-inside-work-tree"]).trim();
  if (inside !== "true") {
    throw new GitCommandFailed(`git rev-parse --is-inside-work-tree printed "${inside}": the project root is not inside a git work tree.`);
  }
  if (requireGit(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    return { skipped: "shallow" };
  }

  const bundles = bundlePaths(changeId);
  const firstCommit = listCommits(root, bundles.flatMap((bundle) => [`${bundle}/spec.xml`, `${bundle}/plan.xml`]))[0] ?? null;
  const versions = listCommits(root, bundles.map((bundle) => `${bundle}/plan.xml`))
    .map((commit) => loadVersion(root, changeId, commit))
    .filter((version): version is LoadedVersion => version !== null);
  const head = loadVersion(root, changeId, "HEAD");
  const finalScope = head?.scope ?? emptyScope();

  const history: PlanHistory = {
    firstCommit,
    approvalCommit: null,
    approvalPoints: [],
    versions: versions.map(({ commit, status, scope, parsed }) => ({ commit, status, scope, parsed })),
    mutations: [],
    amendments: [],
    wideningCommits: [],
    reapprovalAdded: [],
    reapprovalChangedGates: [],
    approvedScope: emptyScope(),
    finalScope,
    shallow: false,
  };

  const approvalIndex = versions.findIndex((version) => version.parsed && version.status === APPROVED);
  if (approvalIndex < 0) {
    return history;
  }
  const approval = versions[approvalIndex]!;
  history.approvalCommit = approval.commit;
  history.approvalPoints.push(approval.commit);
  history.approvedScope = copyScope(approval.scope!);

  const widened = emptyScope();
  // Scope of the last parsed approved version: the base for both widenings and re-approvals, so entries added
  // during a non-approved gap surface at the re-approval rather than as a widening.
  let lastApprovedScope = approval.scope!;
  // Last version with root status approved, parsed or not: the base a re-approval's gate sections are compared with.
  let lastApproved: LoadedVersion = approval;
  for (let index = approvalIndex + 1; index < versions.length; index += 1) {
    const previous = versions[index - 1]!;
    const current = versions[index]!;

    if (current.parsed && current.status === APPROVED && !maybeApproved(previous)) {
      history.approvalPoints.push(current.commit);
      const added = scopeDifference(scopeDifference(current.scope!, lastApprovedScope), widened);
      if (scopeEntries(added).length > 0) {
        history.reapprovalAdded.push({ commit: current.commit, added: scopeEntries(added) });
        history.approvedScope = scopeUnion(history.approvedScope, added);
      }
      const gates = changedGateSections(lastApproved, current);
      if (gates.length > 0) {
        history.reapprovalChangedGates.push({ commit: current.commit, sections: gates });
      }
    } else {
      if (maybeApproved(previous) && maybeApproved(current)) {
        if (!previous.root || !current.root) {
          history.mutations.push({ commit: current.commit, sections: ["unparseable"] });
        } else {
          const comparison = comparePlansIgnoringObservedScope(previous.root, current.root);
          if (!comparison.equal) {
            const edits = isPlanAmendment(comparison.sections, previous.root, current.root) ? history.amendments : history.mutations;
            edits.push({ commit: current.commit, sections: comparison.sections });
          }
        }
      }
      if (current.scope && current.status === APPROVED && maybeApproved(previous)) {
        const added = scopeDifference(current.scope, lastApprovedScope);
        if (scopeEntries(added).length > 0) {
          history.wideningCommits.push({ commit: current.commit, added: scopeEntries(added) });
          Object.assign(widened, scopeUnion(widened, added));
        }
      }
    }

    if (current.scope && current.status === APPROVED) {
      lastApprovedScope = current.scope;
    }
    if (current.status === APPROVED) {
      lastApproved = current;
    }
  }

  return history;
}

/** Sections in which a re-approval differs from the last approved version, unless every difference is an amendment. */
function changedGateSections(lastApproved: LoadedVersion, reapproval: LoadedVersion): string[] {
  if (!lastApproved.root || !reapproval.root) {
    return ["unparseable"];
  }
  const comparison = comparePlansIgnoringObservedScope(lastApproved.root, reapproval.root);
  if (comparison.equal || isPlanAmendment(comparison.sections, lastApproved.root, reapproval.root)) {
    return [];
  }
  return comparison.sections;
}

/** Result of the committed-scope check for one change. Commit fields are 7-character short hashes except B and A. */
export type CommittedScopeReport = {
  changeId: string;
  firstCommit: string | null;
  approvalCommit: string | null;
  approvalPoints: string[];
  reapprovalAdded: { commit: string; added: string[] }[];
  /** Re-approval points whose gate sections differ from the last approved version. */
  reapprovalChangedGates: { commit: string; sections: string[] }[];
  mutations: { commit: string; sections: string[] }[];
  amendments: { commit: string; sections: string[] }[];
  wideningCommits: { commit: string; added: string[] }[];
  ownedCommits: number;
  untaggedInScope: string[];
  untaggedOther: { count: number; commits: string[] };
  approved: string[];
  widenedNear: string[];
  widenedFar: string[];
  /** Owned-commit files matching a committedScopeExempt glob, sorted; they get no other class. */
  exempt: string[];
  errors: { file: string; code: string; commit: string }[];
  /** Set when the history could not be read: no .git at or above the root, or a shallow clone. */
  skipped?: "not-git" | "shallow";
  /** Set when a git command the check needs failed: the command and git's stderr. */
  failed?: string;
};

/**
 * requireChangeTrailers makes scope.no-owned-commits an error. exempt holds committedScopeExempt globs in the
 * ObservedWriteScope glob grammar; matching files are listed and never classified. ownershipFallback is a test-only
 * replay switch that also owns any commit whose message names the change id; no CLI flag exposes it.
 */
export type CommittedScopeOptions = {
  requireChangeTrailers: boolean;
  exempt?: string[];
  ownershipFallback?: "message-mentions-id";
};

/** One commit of the window B^..HEAD. Merge commits carry their first-parent diff and count as untagged. */
type WindowCommit = {
  hash: string;
  merge: boolean;
  trailerIds: string[];
  files: string[];
};

type Widening = { hash: string; index: number; scope: ObservedWriteScope; writesCode: boolean };

const UNTAGGED_ISSUE_CAP = 5;
const UNTAGGED_OTHER_CAP = 20;

/**
 * Checks the files written by changeId's own commits against the plan's approved ObservedWriteScope and the widening
 * commits that admitted more files. Any plan status at HEAD is accepted; lint gates approval separately.
 */
export function checkCommittedScope(
  root: string,
  changeId: string,
  options: CommittedScopeOptions,
): { issues: Grace4Issue[]; report: CommittedScopeReport } {
  try {
    return checkOrThrow(root, changeId, options);
  } catch (error) {
    if (!(error instanceof GitCommandFailed)) {
      throw error;
    }
    const report = emptyReport(changeId);
    report.failed = error.message;
    const message = `Committed-scope check for ${changeId} could not run: ${error.message}`;
    return { issues: [issue("error", "scope.committed-check-failed", currentPlanFile(root, changeId), message)], report };
  }
}

function checkOrThrow(root: string, changeId: string, options: CommittedScopeOptions): { issues: Grace4Issue[]; report: CommittedScopeReport } {
  const planFile = currentPlanFile(root, changeId);
  const report = emptyReport(changeId);
  const issues: Grace4Issue[] = [];

  const history = readPlanHistoryOrThrow(root, changeId);
  if ("skipped" in history) {
    report.skipped = history.skipped;
    const reason = history.skipped === "not-git"
      ? "the project is not a git worktree (no .git at or above its root)"
      : "the repository is a shallow clone, so earlier commits may be missing";
    issues.push(issue("warning", "scope.committed-check-skipped", planFile, `Committed-scope check for ${changeId} skipped: ${reason}.`));
    return { issues, report };
  }

  report.firstCommit = history.firstCommit;
  report.approvalCommit = history.approvalCommit;
  if (!history.approvalCommit || !history.firstCommit) {
    issues.push(issue("error", "scope.approval-uncommitted", planFile, `No commit has the plan of ${changeId} as approved, so the committed-scope check has no base.`));
    return { issues, report };
  }

  report.approvalPoints = history.approvalPoints.map(short);
  report.reapprovalAdded = history.reapprovalAdded.map((entry) => ({ commit: short(entry.commit), added: entry.added }));
  report.reapprovalChangedGates = history.reapprovalChangedGates.map((entry) => ({ commit: short(entry.commit), sections: entry.sections }));
  report.mutations = history.mutations.map((entry) => ({ commit: short(entry.commit), sections: entry.sections }));
  report.amendments = history.amendments.map((entry) => ({ commit: short(entry.commit), sections: entry.sections }));
  report.wideningCommits = history.wideningCommits.map((entry) => ({ commit: short(entry.commit), added: entry.added }));
  for (const mutation of history.mutations) {
    issues.push(issue(
      "error",
      "scope.approved-plan-mutated",
      planFile,
      `Approved plan of ${changeId} changed outside ObservedWriteScope in ${short(mutation.commit)} without a re-approval: ${mutation.sections.join(", ")}.`,
    ));
  }
  for (const amendment of history.amendments) {
    issues.push(issue(
      "warning",
      "scope.approved-plan-amended",
      planFile,
      `Approved plan of ${changeId} was amended in ${short(amendment.commit)} without a re-approval: ${amendment.sections.join(", ")}.`,
    ));
  }
  for (const entry of history.reapprovalAdded) {
    issues.push(issue("warning", "scope.reapproval-widened", planFile, `Re-approval ${short(entry.commit)} of ${changeId} added scope entries: ${entry.added.join(", ")}.`));
  }
  for (const entry of history.reapprovalChangedGates) {
    issues.push(issue(
      "warning",
      "scope.reapproval-changed-gates",
      planFile,
      `Re-approval ${short(entry.commit)} of ${changeId} changed gate sections relative to the last approved version: ${entry.sections.join(", ")}.`,
    ));
  }

  const rule = new PathRule();
  const window = readWindow(root, history.firstCommit);
  const ownedHashes = ownedCommits(root, window, changeId, activeBundles(root, changeId), options, history.firstCommit);
  const position = new Map(window.map((entry, index) => [entry.hash, index]));
  const approvalIndex = position.get(history.approvalCommit) ?? -1;
  const isGrace = (file: string) => rule.within(file, ".grace");
  const exemptScope: ObservedWriteScope = { files: [], globs: options.exempt ?? [] };
  const isExempt = (file: string) => observedWriteScopeContains(exemptScope, file);
  const scopeAtApproval = history.versions.find((version) => version.commit === history.approvalCommit)?.scope ?? emptyScope();
  // Re-approval admissions in history order; the first one that matches a file is the one that admitted it.
  const reapprovals = history.reapprovalAdded.map((entry) => ({
    hash: entry.commit,
    index: position.get(entry.commit) ?? -1,
    scope: entriesToScope(entry.added),
  }));

  // Earliest owned write of each file, in topological order.
  const earliest = new Map<string, { file: string; index: number; hash: string }>();
  window.forEach((entry, index) => {
    if (!ownedHashes.has(entry.hash)) {
      return;
    }
    for (const file of entry.files) {
      const key = rule.key(file);
      if (!earliest.has(key)) {
        earliest.set(key, { file, index, hash: entry.hash });
      }
    }
  });
  report.ownedCommits = ownedHashes.size;

  const widenings: Widening[] = history.wideningCommits.map((entry) => {
    const index = position.get(entry.commit) ?? -1;
    return {
      hash: entry.commit,
      index,
      scope: entriesToScope(entry.added),
      // Exempt bookkeeping files never count as writes outside .grace/.
      writesCode: (window[index]?.files ?? []).some((file) => !isGrace(file) && !isExempt(file)),
    };
  });
  const nearFar = new NearFar(history.approvedScope, new PackageRoots(root), rule);
  const fail = (file: string, code: string, commit: string, message: string) => {
    report.errors.push({ file, code, commit: short(commit) });
    issues.push(issue("error", code, file, message));
  };

  const exempt = new Set<string>();
  for (const { file, index, hash } of earliest.values()) {
    if (isGrace(file)) {
      continue;
    }
    if (isExempt(file)) {
      exempt.add(file);
      continue;
    }
    if (index < approvalIndex) {
      fail(file, "scope.written-before-approval", hash, `${file} was written by ${short(hash)}, before ${changeId}'s plan was approved in ${short(history.approvalCommit)}.`);
      continue;
    }
    if (observedWriteScopeContains(history.approvedScope, file)) {
      const reapproval = observedWriteScopeContains(scopeAtApproval, file)
        ? undefined
        : reapprovals.find((entry) => observedWriteScopeContains(entry.scope, file));
      if (reapproval && index < reapproval.index) {
        fail(
          file,
          "scope.written-before-widening",
          hash,
          `${file} was first written by ${short(hash)}, before re-approval ${short(reapproval.hash)} of ${changeId} that admitted it.`,
        );
        continue;
      }
      report.approved.push(file);
      continue;
    }
    const matching = widenings.filter((widening) => observedWriteScopeContains(widening.scope, file));
    if (matching.length === 0) {
      const detail = observedWriteScopeContains(history.finalScope, file)
        ? "lies outside the approved ObservedWriteScope and no widening commit admitted it"
        : "lies outside the final ObservedWriteScope";
      fail(file, "scope.committed-outside", hash, `${file}, written by ${short(hash)}, ${detail} of ${changeId}.`);
      continue;
    }
    const preceding = matching.filter((widening) => widening.index < index);
    const clean = preceding.find((widening) => !widening.writesCode);
    if (clean) {
      if (nearFar.isNear(file)) {
        report.widenedNear.push(file);
      } else {
        report.widenedFar.push(file);
        issues.push(issue("warning", "scope.widened-far", file, `${file} was admitted by widening ${short(clean.hash)} of ${changeId} and is far from the approved scope.`));
      }
    } else if (preceding.length > 0) {
      const widening = preceding[0]!;
      fail(file, "scope.widening-with-code", widening.hash, `${file} was admitted by widening ${short(widening.hash)} of ${changeId}, which also wrote outside .grace/.`);
    } else {
      fail(
        file,
        "scope.written-before-widening",
        hash,
        `${file} was first written by ${short(hash)}, not after widening ${short(matching[0]!.hash)} of ${changeId} that admitted it.`,
      );
    }
  }

  report.exempt = [...exempt].sort();

  const untaggedInScope: { commit: WindowCommit; files: string[] }[] = [];
  const untaggedOther: string[] = [];
  for (const entry of window) {
    const tagged = !entry.merge && (ownedHashes.has(entry.hash) || entry.trailerIds.length > 0);
    const code = entry.files.filter((file) => !isGrace(file));
    if (tagged || code.length === 0) {
      continue;
    }
    const inScope = code.filter((file) => !isExempt(file) && observedWriteScopeContains(history.finalScope, file));
    if (inScope.length > 0) {
      untaggedInScope.push({ commit: entry, files: inScope });
    } else {
      untaggedOther.push(short(entry.hash));
    }
  }
  report.untaggedInScope = untaggedInScope.map((entry) => short(entry.commit.hash));
  report.untaggedOther = { count: untaggedOther.length, commits: untaggedOther.slice(0, UNTAGGED_OTHER_CAP) };
  untaggedInScope.slice(0, UNTAGGED_ISSUE_CAP).forEach(({ commit, files }, index) => {
    const kind = commit.merge ? "Merge commit" : "Commit";
    const listed = untaggedInScope.length > UNTAGGED_ISSUE_CAP ? `, ${UNTAGGED_ISSUE_CAP} listed` : "";
    issues.push(issue(
      "warning",
      "scope.untagged-commit",
      files[0]!,
      `${kind} ${short(commit.hash)} carries no effective Change trailer and touched the final scope of ${changeId}: ${files.join(", ")} `
        + `(${index + 1} of ${untaggedInScope.length} untagged commits in scope${listed}).`,
    ));
  });

  const finalIsNone = history.finalScope.files.length + history.finalScope.globs.length === 0;
  if (ownedHashes.size === 0 && !finalIsNone) {
    issues.push(issue(
      options.requireChangeTrailers ? "error" : "warning",
      "scope.no-owned-commits",
      planFile,
      `No commit from ${short(history.firstCommit)} to HEAD carries a Change: ${changeId} trailer, so no committed write was checked.`,
    ));
  }

  return { issues, report };
}

/** Reads the window B^..HEAD oldest first in topological order; with no B^ the window has no lower bound. */
function readWindow(root: string, firstCommit: string): WindowCommit[] {
  const range = windowRange(root, firstCommit);
  const prefix = requireGit(root, ["rev-parse", "--show-prefix"]).trim();
  const listed = requireGit(root, [
    "log",
    "-z",
    "--no-renames",
    "--topo-order",
    "--reverse",
    "--name-only",
    "--format=%x1e%H%x00%P%x00%(trailers:key=Change,valueonly,separator=%x1F)%x00",
    range,
    "--",
  ]);
  const commits: WindowCommit[] = [];
  for (const record of listed.split("\x1e").slice(1)) {
    const [hash = "", parents = "", trailers = "", ...names] = record.split("\0");
    const merge = parents.trim().split(" ").filter(Boolean).length > 1;
    const files = merge ? firstParentDiff(root, hash) : names.map((name, index) => (index === 1 ? name.replace(/^\n/, "") : name));
    commits.push({
      hash,
      merge,
      trailerIds: trailers.split("\x1f").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean),
      files: withinProject(files.filter(Boolean), prefix),
    });
  }
  return commits;
}

function windowRange(root: string, firstCommit: string): string {
  return runGit(root, ["rev-parse", "--verify", "--quiet", `${firstCommit}^`]).ok ? `${firstCommit}^..HEAD` : "HEAD";
}

function firstParentDiff(root: string, hash: string): string[] {
  return requireGit(root, ["diff", "-z", "--no-renames", "--name-only", `${hash}^1`, hash]).split("\0").filter(Boolean);
}

/** Turns repository-relative paths into project-relative ones and drops paths outside the project root. */
function withinProject(files: string[], prefix: string): string[] {
  return prefix === "" ? files : files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
}

/**
 * Hashes of window commits owned by changeId: non-merge commits whose effective Change trailers name it. First drops,
 * in place, every trailer id that names no active bundle, so such a trailer counts as no trailer at all.
 */
function ownedCommits(
  root: string,
  window: WindowCommit[],
  changeId: string,
  active: Set<string>,
  options: CommittedScopeOptions,
  firstCommit: string,
): Set<string> {
  for (const entry of window) {
    entry.trailerIds = entry.trailerIds.filter((id) => active.has(id));
  }
  const mentioning = options.ownershipFallback === "message-mentions-id" ? commitsMentioning(root, firstCommit, changeId) : new Set<string>();
  return new Set(
    window
      .filter((entry) => !entry.merge && (entry.trailerIds.includes(changeId) || mentioning.has(entry.hash)))
      .map((entry) => entry.hash),
  );
}

/** Test-only replay switch: window commits whose full message names changeId as a whole token. */
function commitsMentioning(root: string, firstCommit: string, changeId: string): Set<string> {
  const listed = requireGit(root, ["log", "--format=%x1e%H%x00%B", windowRange(root, firstCommit), "--"]);
  const escaped = changeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`);
  const found = new Set<string>();
  for (const record of listed.split("\x1e").slice(1)) {
    const [hash = "", message = ""] = record.split("\0");
    if (pattern.test(message)) {
      found.add(hash.trim());
    }
  }
  return found;
}

/** Change ids with a bundle directory under .grace/changes/active/ in the working tree at HEAD, plus changeId. */
function activeBundles(root: string, changeId: string): Set<string> {
  const active = new Set<string>([changeId]);
  try {
    for (const entry of readdirSync(path.join(root, ".grace", "changes", "active"), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        active.add(entry.name);
      }
    }
  } catch {
    // No active directory: only the change under check counts.
  }
  return active;
}

/** Project-relative plan.xml path at HEAD: active first, then archive, defaulting to active. */
function currentPlanFile(root: string, changeId: string): string {
  const candidates = bundlePaths(changeId).map((bundle) => `${bundle}/plan.xml`);
  return candidates.find((candidate) => existsSync(path.join(root, ...candidate.split("/")))) ?? candidates[0]!;
}

/** Splits history entries back into a scope: entries with a wildcard are globs, the rest files. */
function entriesToScope(entries: string[]): ObservedWriteScope {
  return { files: entries.filter((entry) => !/[*?]/.test(entry)), globs: entries.filter((entry) => /[*?]/.test(entry)) };
}

function emptyReport(changeId: string): CommittedScopeReport {
  return {
    changeId,
    firstCommit: null,
    approvalCommit: null,
    approvalPoints: [],
    reapprovalAdded: [],
    mutations: [],
    amendments: [],
    wideningCommits: [],
    reapprovalChangedGates: [],
    ownedCommits: 0,
    untaggedInScope: [],
    untaggedOther: { count: 0, commits: [] },
    approved: [],
    widenedNear: [],
    widenedFar: [],
    exempt: [],
    errors: [],
  };
}

function short(hash: string): string {
  return hash.slice(0, 7);
}

function issue(severity: Grace4Issue["severity"], code: string, file: string, message: string): Grace4Issue {
  return { severity, code, file, message };
}

/** The one git entry point of the committed-scope check. stdout and stderr are piped and decoded as UTF-8. */
function runGit(root: string, args: string[]): GitResult {
  try {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
    const decoder = new TextDecoder();
    return { ok: result.exitCode === 0, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs git and returns stdout; throws GitCommandFailed with the command and git's stderr when git fails. */
function requireGit(root: string, args: string[]): string {
  const result = runGit(root, args);
  if (!result.ok) {
    const stderr = result.stderr.trim().split(/\r?\n/).slice(0, 3).join(" ");
    throw new GitCommandFailed(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout;
}

/** True when the root or one of its ancestors holds a .git directory or file. */
function hasGitAncestor(root: string): boolean {
  let directory = path.resolve(root);
  for (;;) {
    if (existsSync(path.join(directory, ".git"))) {
      return true;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}

function bundlePaths(changeId: string): string[] {
  return [`.grace/changes/active/${changeId}`, `.grace/changes/archive/${changeId}`];
}

/** Commits touching any of paths, oldest first. Paths are relative to root. */
function listCommits(root: string, paths: string[]): string[] {
  return requireGit(root, ["log", "--reverse", "--topo-order", "-z", "--no-renames", "--format=%H", "--", ...paths])
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads plan.xml at commit, active path first, then archive. Returns null when the plan exists at neither; a git
 * failure while listing or reading it throws.
 */
function loadVersion(root: string, changeId: string, commit: string): LoadedVersion | null {
  const candidates = bundlePaths(changeId).map((bundle) => `${bundle}/plan.xml`);
  const present = new Set(requireGit(root, ["ls-tree", "-z", "--name-only", commit, "--", ...candidates]).split("\0").filter(Boolean));
  for (const relativePath of candidates) {
    if (!present.has(relativePath)) {
      continue;
    }
    const text = requireGit(root, ["show", `${commit}:./${relativePath}`]);
    const file = `${commit}:${relativePath}`;
    const parsed = parseGraceXmlArtifact(file, text);
    if (!parsed.root) {
      return { commit, status: ROOT_STATUS.exec(text)?.[1] ?? "", scope: null, parsed: false, root: null };
    }
    return {
      commit,
      status: parsed.root.attributes.status ?? "",
      scope: extractObservedWriteScope(parsed.root, root, file).scope,
      parsed: true,
      root: parsed.root,
    };
  }
  return null;
}

/** An unparseable version whose status cannot be read is treated as possibly approved. */
function maybeApproved(version: LoadedVersion): boolean {
  return version.status === APPROVED || (!version.parsed && version.status === "");
}

function emptyScope(): ObservedWriteScope {
  return { files: [], globs: [] };
}

function copyScope(scope: ObservedWriteScope): ObservedWriteScope {
  return { files: [...scope.files], globs: [...scope.globs] };
}

function scopeDifference(left: ObservedWriteScope, right: ObservedWriteScope): ObservedWriteScope {
  return {
    files: left.files.filter((file) => !right.files.includes(file)),
    globs: left.globs.filter((glob) => !right.globs.includes(glob)),
  };
}

function scopeUnion(left: ObservedWriteScope, right: ObservedWriteScope): ObservedWriteScope {
  return {
    files: [...new Set([...left.files, ...right.files])].sort(),
    globs: [...new Set([...left.globs, ...right.globs])].sort(),
  };
}

function scopeEntries(scope: ObservedWriteScope): string[] {
  return [...scope.files, ...scope.globs];
}
