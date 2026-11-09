import { comparePlansIgnoringObservedScope } from "./plan-compare";
import { extractObservedWriteScope, type ObservedWriteScope } from "./scope";
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
  /** Consecutive approved versions after A that differ apart from the wrapper's direct ObservedWriteScope. */
  mutations: { commit: string; sections: string[] }[];
  /** Plan commits after A, not approval points, whose ObservedWriteScope gains entries over the previous version. */
  wideningCommits: { commit: string; added: string[] }[];
  /** Entries a re-approval point added over the version before it, minus entries an earlier widening commit added. */
  reapprovalAdded: { commit: string; added: string[] }[];
  /** The scope at A plus reapprovalAdded entries. */
  approvedScope: ObservedWriteScope;
  /** The ObservedWriteScope of plan.xml at HEAD. */
  finalScope: ObservedWriteScope;
  shallow: boolean;
};

/** Reason the history could not be read. */
export type PlanHistorySkip = { skipped: "not-git" | "shallow" };

type GitResult = { ok: boolean; stdout: string };

type LoadedVersion = PlanVersion & { root: GraceXmlNode | null };

const APPROVED = "approved";
const ROOT_STATUS = /<GraceChangePlan\b[^>]*?\sstatus\s*=\s*["']([^"']*)["']/;

/**
 * Reads the plan history of changeId from git, whatever the plan's status at HEAD. A project that is not a git
 * worktree, or a shallow clone in which earlier commits may be missing, is reported as skipped.
 */
export function readPlanHistory(root: string, changeId: string): PlanHistory | PlanHistorySkip {
  const inside = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { skipped: "not-git" };
  }
  const shallow = runGit(root, ["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok || shallow.stdout.trim() === "true") {
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
    wideningCommits: [],
    reapprovalAdded: [],
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
  let lastScope = approval.scope!;
  for (let index = approvalIndex + 1; index < versions.length; index += 1) {
    const previous = versions[index - 1]!;
    const current = versions[index]!;

    if (current.parsed && current.status === APPROVED && !maybeApproved(previous)) {
      history.approvalPoints.push(current.commit);
      const added = scopeDifference(scopeDifference(current.scope!, lastScope), widened);
      if (scopeEntries(added).length > 0) {
        history.reapprovalAdded.push({ commit: current.commit, added: scopeEntries(added) });
        history.approvedScope = scopeUnion(history.approvedScope, added);
      }
    } else {
      if (maybeApproved(previous) && maybeApproved(current)) {
        if (!previous.root || !current.root) {
          history.mutations.push({ commit: current.commit, sections: ["unparseable"] });
        } else {
          const comparison = comparePlansIgnoringObservedScope(previous.root, current.root);
          if (!comparison.equal) {
            history.mutations.push({ commit: current.commit, sections: comparison.sections });
          }
        }
      }
      if (current.scope) {
        const added = scopeDifference(current.scope, lastScope);
        if (scopeEntries(added).length > 0) {
          history.wideningCommits.push({ commit: current.commit, added: scopeEntries(added) });
          Object.assign(widened, scopeUnion(widened, added));
        }
      }
    }

    if (current.scope) {
      lastScope = current.scope;
    }
  }

  return history;
}

/** The one git entry point of the committed-scope check. stdout is piped and decoded as UTF-8. */
function runGit(root: string, args: string[]): GitResult {
  try {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
    return { ok: result.exitCode === 0, stdout: new TextDecoder().decode(result.stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function bundlePaths(changeId: string): string[] {
  return [`.grace/changes/active/${changeId}`, `.grace/changes/archive/${changeId}`];
}

/** Commits touching any of paths, oldest first. Paths are relative to root. */
function listCommits(root: string, paths: string[]): string[] {
  const result = runGit(root, ["log", "--reverse", "--topo-order", "-z", "--no-renames", "--format=%H", "--", ...paths]);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split("\0").map((entry) => entry.trim()).filter(Boolean);
}

/** Reads plan.xml at commit, active path first, then archive. Returns null when the plan exists at neither. */
function loadVersion(root: string, changeId: string, commit: string): LoadedVersion | null {
  for (const bundle of bundlePaths(changeId)) {
    const relativePath = `${bundle}/plan.xml`;
    const shown = runGit(root, ["show", `${commit}:./${relativePath}`]);
    if (!shown.ok) {
      continue;
    }
    const file = `${commit}:${relativePath}`;
    const parsed = parseGraceXmlArtifact(file, shown.stdout);
    if (!parsed.root) {
      return { commit, status: ROOT_STATUS.exec(shown.stdout)?.[1] ?? "", scope: null, parsed: false, root: null };
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
