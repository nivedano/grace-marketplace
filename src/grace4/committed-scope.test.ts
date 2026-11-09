import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

import { checkCommittedScope, readPlanHistory, type CommittedScopeOptions, type PlanHistory } from "./committed-scope";
import { commit, createRepo, fixtureGit, plan, spec } from "./git-fixture";
import type { Grace4Issue } from "./types";

const ID = "C-TEST";
const ACTIVE = `.grace/changes/active/${ID}`;
const ARCHIVE = `.grace/changes/archive/${ID}`;
const ACTIVE_PLAN = `${ACTIVE}/plan.xml`;

function history(root: string): PlanHistory {
  const result = readPlanHistory(root, ID);
  if ("skipped" in result) {
    throw new Error(`history skipped: ${result.skipped}`);
  }
  return result;
}

function seeded(): string {
  const root = createRepo();
  commit(root, { "README.md": "fixture\n" }, "chore: seed");
  return root;
}

describe("readPlanHistory", () => {
  it("takes A as the first commit with the plan approved, for a plan committed approved", () => {
    const root = seeded();
    const approval = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    commit(root, { "src/a.ts": "a\n" }, "feat: write a");

    const result = history(root);
    expect(result.approvalCommit).toBe(approval);
    expect(result.approvalPoints).toEqual([approval]);
    expect(result.firstCommit).toBe(approval);
    expect(result.versions).toEqual([{ commit: approval, status: "approved", scope: { files: ["src/a.ts"], globs: [] }, parsed: true }]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts"], globs: [] });
    expect(result.finalScope).toEqual({ files: ["src/a.ts"], globs: [] });
    expect(result.mutations).toEqual([]);
    expect(result.wideningCommits).toEqual([]);
    expect(result.reapprovalAdded).toEqual([]);
    expect(result.shallow).toBe(false);
  });

  it("takes A after a draft period", () => {
    const root = seeded();
    const draft = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts"]) }, "docs: draft");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts", "src/b.ts"]) }, "docs: refine draft");
    const approval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts"]) }, "docs: approve");

    const result = history(root);
    expect(result.firstCommit).toBe(draft);
    expect(result.approvalCommit).toBe(approval);
    expect(result.approvalPoints).toEqual([approval]);
    expect(result.versions.map((version) => version.status)).toEqual(["draft", "draft", "approved"]);
    expect(result.wideningCommits).toEqual([]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts", "src/b.ts"], globs: [] });
  });

  it("finds B as the first commit with spec.xml or plan.xml", () => {
    const root = seeded();
    commit(root, { ".grace/changes/active/C-OTHER/spec.xml": spec("C-OTHER", "draft") }, "docs: other change");
    const specOnly = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "draft") }, "docs: spec");
    commit(root, { "src/unrelated.ts": "x\n" }, "feat: unrelated");
    const approval = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");

    const result = history(root);
    expect(result.firstCommit).toBe(specOnly);
    expect(result.approvalCommit).toBe(approval);
  });

  it("collects a later draft→approved transition as an approval point", () => {
    const root = seeded();
    const approval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts"], { tasks: "<T-001><Title>Reworked</Title></T-001>" }) }, "docs: reopen");
    const reapproval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { tasks: "<T-001><Title>Reworked</Title></T-001>" }) }, "docs: re-approve");

    const result = history(root);
    expect(result.approvalCommit).toBe(approval);
    expect(result.approvalPoints).toEqual([approval, reapproval]);
    expect(result.mutations).toEqual([]);
    expect(result.reapprovalAdded).toEqual([]);
  });

  it("adds re-approval entries to the approved scope but not entries an earlier widening commit added", () => {
    const root = seeded();
    const approval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    const widening = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts"]) }, "docs: widen");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "cancelled", ["src/a.ts"]) }, "docs: cancel");
    const reapproval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts", "src/c.ts"]) }, "docs: re-approve");

    const result = history(root);
    expect(result.approvalPoints).toEqual([approval, reapproval]);
    expect(result.wideningCommits).toEqual([{ commit: widening, added: ["src/b.ts"] }]);
    expect(result.reapprovalAdded).toEqual([{ commit: reapproval, added: ["src/c.ts"] }]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts", "src/c.ts"], globs: [] });
    expect(result.finalScope).toEqual({ files: ["src/a.ts", "src/b.ts", "src/c.ts"], globs: [] });
  });

  it("records reapprovalAdded for a re-approval that adds entries", () => {
    const root = seeded();
    commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts"]) }, "docs: reopen");
    const reapproval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/lib/**"]) }, "docs: re-approve");

    const result = history(root);
    expect(result.reapprovalAdded).toEqual([{ commit: reapproval, added: ["src/lib/**"] }]);
    expect(result.wideningCommits).toEqual([]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts"], globs: ["src/lib/**"] });
  });

  it("counts entries added during a draft period as reapprovalAdded, not as a widening", () => {
    const root = seeded();
    commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts", "src/b.ts"]) }, "docs: reopen and add b");
    const reapproval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts"]) }, "docs: re-approve");

    const result = history(root);
    expect(result.wideningCommits).toEqual([]);
    expect(result.reapprovalAdded).toEqual([{ commit: reapproval, added: ["src/b.ts"] }]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts", "src/b.ts"], globs: [] });
  });

  it("keeps a widening restored by a re-approval out of the approved scope", () => {
    const root = seeded();
    commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    const widening = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/c.ts"]) }, "docs: widen");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "cancelled", ["src/a.ts", "src/c.ts"]) }, "docs: cancel");
    const reapproval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/c.ts"]) }, "docs: restore");

    const result = history(root);
    expect(result.approvalPoints).toHaveLength(2);
    expect(result.approvalPoints[1]).toBe(reapproval);
    expect(result.wideningCommits).toEqual([{ commit: widening, added: ["src/c.ts"] }]);
    expect(result.reapprovalAdded).toEqual([]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts"], globs: [] });
  });

  it("records a widening commit with its added entries", () => {
    const root = seeded();
    commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    const widening = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["./src/a.ts", "src/b.ts", "src/x/**"]) }, "docs: widen");
    commit(root, { "src/b.ts": "b\n" }, "feat: write b");
    commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: narrow");

    const result = history(root);
    expect(result.wideningCommits).toEqual([{ commit: widening, added: ["src/b.ts", "src/x/**"] }]);
    expect(result.mutations).toEqual([]);
    expect(result.approvedScope).toEqual({ files: ["src/a.ts"], globs: [] });
    expect(result.finalScope).toEqual({ files: ["src/a.ts"], globs: [] });
  });

  it("records TargetAssertions and DurableScope edits as mutations and a task edit as an amendment", () => {
    const root = seeded();
    commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    const target = "<MustVerify><Module>M-OTHER</Module></MustVerify>";
    const tasks = "<T-001><Title>Changed task</Title></T-001>";
    const durable = "<GraphAnchors><M-OTHER /></GraphAnchors>";
    const targetEdit = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { target }) }, "docs: edit target");
    const taskEdit = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { target, tasks }) }, "docs: edit tasks");
    const durableEdit = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { target, tasks, durable }) }, "docs: edit durable");

    const result = history(root);
    expect(result.mutations).toEqual([
      { commit: targetEdit, sections: ["TargetAssertions"] },
      { commit: durableEdit, sections: ["DurableScope"] },
    ]);
    expect(result.amendments).toEqual([{ commit: taskEdit, sections: ["ImplementationPlan"] }]);
    expect(result.approvalPoints).toHaveLength(1);
  });

  it("treats an unparseable approved version as a mutation", () => {
    const root = seeded();
    const approved = plan(ID, "approved", ["src/a.ts"]);
    const approval = commit(root, { [ACTIVE_PLAN]: approved }, "docs: approve");
    const broken = commit(root, { [ACTIVE_PLAN]: approved.replace("</ObservedWriteScope>", "") }, "docs: break plan");
    const restored = commit(root, { [ACTIVE_PLAN]: approved }, "docs: restore plan");

    const result = history(root);
    expect(result.versions[1]).toEqual({ commit: broken, status: "approved", scope: null, parsed: false });
    expect(result.mutations).toEqual([
      { commit: broken, sections: ["unparseable"] },
      { commit: restored, sections: ["unparseable"] },
    ]);
    expect(result.approvalPoints).toEqual([approval]);
  });

  it("follows the plan from active/ to archive/", () => {
    const root = seeded();
    const approval = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    const widening = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts"]) }, "docs: widen");
    const archived = commit(
      root,
      {
        [`${ACTIVE}/spec.xml`]: null,
        [ACTIVE_PLAN]: null,
        [`${ARCHIVE}/spec.xml`]: spec(ID, "applied"),
        [`${ARCHIVE}/plan.xml`]: plan(ID, "applied", ["src/a.ts", "src/b.ts"]),
      },
      "docs: archive",
    );

    const result = history(root);
    expect(result.firstCommit).toBe(approval);
    expect(result.approvalCommit).toBe(approval);
    expect(result.versions.map((version) => [version.commit, version.status])).toEqual([
      [approval, "approved"],
      [widening, "approved"],
      [archived, "applied"],
    ]);
    expect(result.wideningCommits).toEqual([{ commit: widening, added: ["src/b.ts"] }]);
    expect(result.mutations).toEqual([]);
    expect(result.finalScope).toEqual({ files: ["src/a.ts", "src/b.ts"], globs: [] });
  });

  it("skips a shallow repository", () => {
    const origin = seeded();
    commit(origin, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");
    commit(origin, { "src/a.ts": "a\n" }, "feat: write a");
    const parent = mkdtempSync(path.join(os.tmpdir(), "grace-shallow-"));
    fixtureGit(parent, ["clone", "--quiet", "--depth", "1", pathToFileURL(origin).href, "clone"]);
    const clone = path.join(parent, "clone");

    expect(readPlanHistory(clone, ID)).toEqual({ skipped: "shallow" });
  });

  it("returns not-git outside a repository", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-not-git-"));
    expect(readPlanHistory(root, ID)).toEqual({ skipped: "not-git" });
  });
});

const OTHER = "C-OTHER";
const NO_TRAILERS = { requireChangeTrailers: false };

function owned(subject: string, id = ID): string {
  return `${subject}\n\nChange: ${id}`;
}

function short(hash: string): string {
  return hash.slice(0, 7);
}

/** A seeded repository whose plan is committed approved with scope, under an owned commit; extra files ride along. */
function approvedRepo(scope: string[], extra: Record<string, string> = {}): { root: string; approval: string } {
  const root = createRepo();
  commit(root, { "README.md": "fixture\n", ...extra }, "chore: seed");
  const approval = commit(
    root,
    { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", scope) },
    owned("docs: approve"),
  );
  return { root, approval };
}

function widen(root: string, scope: string[], files: Record<string, string> = {}): string {
  return commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", scope), ...files }, owned("docs: widen"));
}

function check(root: string, options: CommittedScopeOptions = NO_TRAILERS) {
  return checkCommittedScope(root, ID, options);
}

function codes(issues: Grace4Issue[]): string[] {
  return issues.map((issue) => `${issue.severity}:${issue.code}:${issue.file}`);
}

describe("checkCommittedScope", () => {
  describe("classification", () => {
    it("ignores bundle and other .grace paths", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      commit(
        root,
        { [`${ACTIVE}/design-context.xml`]: "<x />\n", ".grace/graph/index.xml": "<g />\n", "src/a.ts": "a\n" },
        owned("feat: write a"),
      );

      const { issues, report } = check(root);
      expect(issues).toEqual([]);
      expect(report.approved).toEqual(["src/a.ts"]);
      expect(report.errors).toEqual([]);
      expect(report.ownedCommits).toBe(2);
    });

    it("errors on an owned write before approval", () => {
      const root = seeded();
      const draft = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts"]) }, owned("docs: draft"));
      const early = commit(root, { "src/a.ts": "a\n" }, owned("feat: write a early"));
      const approval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, owned("docs: approve"));

      const { issues, report } = check(root);
      expect(report.firstCommit).toBe(draft);
      expect(report.approvalCommit).toBe(approval);
      expect(report.errors).toEqual([{ file: "src/a.ts", code: "scope.written-before-approval", commit: short(early) }]);
      expect(codes(issues)).toEqual(["error:scope.written-before-approval:src/a.ts"]);
      expect(report.approved).toEqual([]);
    });

    it("accepts a file in the approved scope", () => {
      const root = seeded();
      const approval = commit(
        root,
        { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/lib/**"]), "src/a.ts": "a\n" },
        owned("docs: approve and write a"),
      );
      commit(root, { "src/lib/x/y.ts": "y\n" }, owned("feat: write y"));

      const { issues, report } = check(root);
      expect(issues).toEqual([]);
      expect(report.approvalCommit).toBe(approval);
      expect(report.approvalPoints).toEqual([short(approval)]);
      expect(report.approved).toEqual(["src/a.ts", "src/lib/x/y.ts"]);
      expect(report.widenedNear).toEqual([]);
      expect(report.widenedFar).toEqual([]);
    });

    it("accepts a widening commit before the write and labels it near by directory", () => {
      const { root } = approvedRepo(["src/a.ts", "lib/core/*.ts"]);
      const widening = widen(root, ["src/a.ts", "lib/core/*.ts", "src/b.ts", "lib/core/sub/z.ts"]);
      commit(root, { "src/b.ts": "b\n", "lib/core/sub/z.ts": "z\n" }, owned("feat: write b and z"));

      const { issues, report } = check(root);
      expect(issues).toEqual([]);
      expect(report.wideningCommits).toEqual([{ commit: short(widening), added: ["lib/core/sub/z.ts", "src/b.ts"] }]);
      expect(report.widenedNear).toEqual(["lib/core/sub/z.ts", "src/b.ts"]);
      expect(report.widenedFar).toEqual([]);
    });

    it("labels near by nearest-manifest package", () => {
      const { root } = approvedRepo(["packages/a/src/x.ts", "dotnet/App/Program.cs"], {
        "packages/a/package.json": "{}\n",
        "packages/a/sub/package.json": "{}\n",
        "dotnet/App/App.csproj": "<Project />\n",
      });
      widen(root, ["packages/a/src/x.ts", "dotnet/App/Program.cs", "packages/a/test/x.test.ts", "packages/a/sub/y.ts", "dotnet/App/Models/M.cs"]);
      commit(root, { "packages/a/test/x.test.ts": "t\n", "packages/a/sub/y.ts": "y\n", "dotnet/App/Models/M.cs": "m\n" }, owned("feat: write"));

      const { issues, report } = check(root);
      expect(report.widenedNear).toEqual(["dotnet/App/Models/M.cs", "packages/a/test/x.test.ts"]);
      expect(report.widenedFar).toEqual(["packages/a/sub/y.ts"]);
      expect(codes(issues)).toEqual(["warning:scope.widened-far:packages/a/sub/y.ts"]);
    });

    it("labels far across packages and raises scope.widened-far", () => {
      const { root } = approvedRepo(["src/a.ts", "packages/a/src/x.ts"], {
        "package.json": "{}\n",
        "packages/a/package.json": "{}\n",
        "packages/b/package.json": "{}\n",
      });
      const widening = widen(root, ["src/a.ts", "packages/a/src/x.ts", "packages/b/src/y.ts", "tools/t.ts"]);
      commit(root, { "packages/b/src/y.ts": "y\n", "tools/t.ts": "t\n" }, owned("feat: write"));

      const { issues, report } = check(root);
      expect(report.widenedNear).toEqual([]);
      expect(report.widenedFar).toEqual(["packages/b/src/y.ts", "tools/t.ts"]);
      expect(codes(issues)).toEqual(["warning:scope.widened-far:packages/b/src/y.ts", "warning:scope.widened-far:tools/t.ts"]);
      expect(issues[0]!.message).toContain(short(widening));
      expect(report.errors).toEqual([]);
    });

    it("treats each ESP-IDF component as its own package", () => {
      const { root } = approvedRepo(["components/foo/foo.c"], {
        "CMakeLists.txt": "project(x)\n",
        "components/foo/CMakeLists.txt": "idf_component_register()\n",
        "components/foo/idf_component.yml": "version: 1.0.0\n",
        "components/bar/CMakeLists.txt": "idf_component_register()\n",
      });
      widen(root, ["components/foo/foo.c", "components/foo/include/foo.h", "components/bar/bar.c", "sdkconfig.defaults"]);
      commit(root, { "components/foo/include/foo.h": "h\n", "components/bar/bar.c": "b\n", "sdkconfig.defaults": "s\n" }, owned("feat: write"));

      const { report } = check(root);
      expect(report.widenedNear).toEqual(["components/foo/include/foo.h"]);
      expect(report.widenedFar).toEqual(["components/bar/bar.c", "sdkconfig.defaults"]);
    });

    it("ignores an empty Glob prefix for the directory rule", () => {
      const { root } = approvedRepo(["**/*.md", "src/a.ts"]);
      widen(root, ["**/*.md", "src/a.ts", "docs/guide.txt"]);
      commit(root, { "docs/guide.txt": "g\n", "docs/notes.md": "n\n" }, owned("feat: write"));

      const { report } = check(root);
      expect(report.approved).toEqual(["docs/notes.md"]);
      expect(report.widenedNear).toEqual([]);
      expect(report.widenedFar).toEqual(["docs/guide.txt"]);
    });

    it("errors with scope.widening-with-code", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const widening = widen(root, ["src/a.ts", "src/b.ts"], { "src/a.ts": "a\n" });
      commit(root, { "src/b.ts": "b\n" }, owned("feat: write b"));

      const { issues, report } = check(root);
      expect(report.approved).toEqual(["src/a.ts"]);
      expect(report.errors).toEqual([{ file: "src/b.ts", code: "scope.widening-with-code", commit: short(widening) }]);
      expect(codes(issues)).toEqual(["error:scope.widening-with-code:src/b.ts"]);
      expect(report.widenedNear).toEqual([]);
    });

    it("errors with scope.written-before-widening for the same commit and for a later widening", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const same = widen(root, ["src/a.ts", "src/b.ts"], { "src/b.ts": "b\n" });
      const early = commit(root, { "src/c.ts": "c\n" }, owned("feat: write c"));
      const later = widen(root, ["src/a.ts", "src/b.ts", "src/c.ts"]);

      const { issues, report } = check(root);
      expect(report.errors).toEqual([
        { file: "src/b.ts", code: "scope.written-before-widening", commit: short(same) },
        { file: "src/c.ts", code: "scope.written-before-widening", commit: short(early) },
      ]);
      expect(codes(issues)).toEqual(["error:scope.written-before-widening:src/b.ts", "error:scope.written-before-widening:src/c.ts"]);
      expect(issues[1]!.message).toContain(short(later));
    });

    it("errors with scope.committed-outside", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const write = commit(root, { "src/z.ts": "z\n" }, owned("feat: write z"));

      const { issues, report } = check(root);
      expect(report.errors).toEqual([{ file: "src/z.ts", code: "scope.committed-outside", commit: short(write) }]);
      expect(codes(issues)).toEqual(["error:scope.committed-outside:src/z.ts"]);
    });

    it("lists both paths of a rename from outside scope", () => {
      const { root } = approvedRepo(["src/new.ts"], { "lib/old.ts": "same contents\n" });
      const rename = commit(root, { "lib/old.ts": null, "src/new.ts": "same contents\n" }, owned("refactor: move"));

      const { report } = check(root);
      expect(report.approved).toEqual(["src/new.ts"]);
      expect(report.errors).toEqual([{ file: "lib/old.ts", code: "scope.committed-outside", commit: short(rename) }]);
    });

    it("raises scope.approved-plan-mutated for each mutation", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const target = "<MustVerify><Module>M-OTHER</Module></MustVerify>";
      const first = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { target }) }, owned("docs: edit target"));
      const durable = "<GraphAnchors><M-OTHER /></GraphAnchors>";
      const second = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { target, durable }) }, owned("docs: edit durable"));

      const { issues, report } = check(root);
      expect(report.mutations).toEqual([
        { commit: short(first), sections: ["TargetAssertions"] },
        { commit: short(second), sections: ["DurableScope"] },
      ]);
      expect(codes(issues)).toEqual([`error:scope.approved-plan-mutated:${ACTIVE_PLAN}`, `error:scope.approved-plan-mutated:${ACTIVE_PLAN}`]);
      expect(issues[0]!.message).toContain(short(first));
      expect(issues[1]!.message).toContain("DurableScope");
    });

    it("classifies an ImplementationPlan-only or IntentSummary-only edit as scope.approved-plan-amended", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const tasks = "<T-001><Title>Amended task</Title></T-001>";
      const intent = "Apply the amended fixture change.";
      const taskEdit = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { tasks }) }, owned("docs: amend tasks"));
      const intentEdit = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { tasks, intent }) }, owned("docs: amend intent"));
      const bothEdit = commit(
        root,
        { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts"], { tasks: "<T-002><Title>Second</Title></T-002>", intent: "Again." }) },
        owned("docs: widen and amend both"),
      );
      commit(root, { "src/b.ts": "b\n" }, owned("feat: write b"));

      const { issues, report } = check(root);
      expect(report.mutations).toEqual([]);
      expect(report.amendments).toEqual([
        { commit: short(taskEdit), sections: ["ImplementationPlan"] },
        { commit: short(intentEdit), sections: ["IntentSummary"] },
        { commit: short(bothEdit), sections: ["IntentSummary", "ImplementationPlan"] },
      ]);
      expect(report.wideningCommits).toEqual([{ commit: short(bothEdit), added: ["src/b.ts"] }]);
      expect(report.widenedNear).toEqual(["src/b.ts"]);
      expect(codes(issues)).toEqual([
        `warning:scope.approved-plan-amended:${ACTIVE_PLAN}`,
        `warning:scope.approved-plan-amended:${ACTIVE_PLAN}`,
        `warning:scope.approved-plan-amended:${ACTIVE_PLAN}`,
      ]);
      expect(issues[0]!.message).toContain(short(taskEdit));
      expect(issues[0]!.message).toContain("ImplementationPlan");
      expect(issues[1]!.message).toContain("IntentSummary");
    });

    it("keeps BaselineAssertions, TargetAssertions, DurableScope, root, wrapper and unparseable differences as scope.approved-plan-mutated", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const baseline = "<MustExist><Value>M-OTHER</Value></MustExist>";
      const target = "<MustVerify><Module>M-OTHER</Module></MustVerify>";
      const durable = "<GraphAnchors><M-OTHER /></GraphAnchors>";
      const gates = plan(ID, "approved", ["src/a.ts"], { baseline, target, durable });
      const rooted = gates.replace(`status="approved">`, `status="approved" note="edited">`);
      const wrapped = rooted.replace(`<${ID}>`, `<${ID} note="edited">`);
      const unknown = wrapped.replace("<ImplementationPlan>", "<Notes>Extra.</Notes>\n    <ImplementationPlan>");
      const edits = [
        commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { baseline }) }, owned("docs: edit baseline")),
        commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { baseline, target }) }, owned("docs: edit target")),
        commit(root, { [ACTIVE_PLAN]: gates }, owned("docs: edit durable")),
        commit(root, { [ACTIVE_PLAN]: rooted }, owned("docs: edit root")),
        commit(root, { [ACTIVE_PLAN]: wrapped }, owned("docs: edit wrapper")),
        commit(root, { [ACTIVE_PLAN]: unknown }, owned("docs: add unknown section")),
        commit(root, { [ACTIVE_PLAN]: unknown.replace("</ObservedWriteScope>", "") }, owned("docs: break plan")),
      ];

      const { issues, report } = check(root);
      expect(report.amendments).toEqual([]);
      expect(report.mutations).toEqual(
        [["BaselineAssertions"], ["TargetAssertions"], ["DurableScope"], ["root"], ["wrapper"], ["Notes"], ["unparseable"]]
          .map((sections, index) => ({ commit: short(edits[index]!), sections })),
      );
      expect(codes(issues)).toEqual(edits.map(() => `error:scope.approved-plan-mutated:${ACTIVE_PLAN}`));
    });

    it("a commit changing both a task and TargetAssertions raises only the mutation", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const edit = commit(
        root,
        { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"], { tasks: "<T-001><Title>Changed</Title></T-001>", target: "<MustVerify><Module>M-OTHER</Module></MustVerify>" }) },
        owned("docs: edit task and target"),
      );

      const { issues, report } = check(root);
      expect(report.mutations).toEqual([{ commit: short(edit), sections: ["TargetAssertions", "ImplementationPlan"] }]);
      expect(report.amendments).toEqual([]);
      expect(codes(issues)).toEqual([`error:scope.approved-plan-mutated:${ACTIVE_PLAN}`]);
      expect(issues[0]!.message).toContain("TargetAssertions, ImplementationPlan");
    });

    it("lists files matching committedScopeExempt under exempt and raises no issue for them", () => {
      const { root } = approvedRepo(["src/a.ts", ".beads/**"]);
      commit(root, { "src/a.ts": "a\n", ".beads/issues.jsonl": "1\n", "notes/draft.md": "d\n" }, owned("feat: write a with bookkeeping"));
      commit(root, { ".beads/issues.jsonl": "2\n", ".beads/sub/state.json": "{}\n" }, owned("chore: bookkeeping"));
      const untagged = commit(root, { ".beads/issues.jsonl": "3\n" }, "chore: untagged bookkeeping");
      const exempt = [".beads/**", "notes/*.md"];

      const { issues, report } = check(root, { requireChangeTrailers: false, exempt });
      expect(report.exempt).toEqual([".beads/issues.jsonl", ".beads/sub/state.json", "notes/draft.md"]);
      expect(report.approved).toEqual(["src/a.ts"]);
      expect(report.errors).toEqual([]);
      expect(report.untaggedInScope).toEqual([]);
      expect(report.untaggedOther).toEqual({ count: 1, commits: [short(untagged)] });
      expect(issues).toEqual([]);

      const unexempted = check(root);
      expect(unexempted.report.exempt).toEqual([]);
      expect(codes(unexempted.issues)).toEqual([
        "error:scope.committed-outside:notes/draft.md",
        "warning:scope.untagged-commit:.beads/issues.jsonl",
      ]);
    });

    it("warns with scope.reapproval-widened", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      commit(root, { [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts"]) }, owned("docs: reopen"));
      const reapproval = commit(root, { [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts", "src/b.ts"]) }, owned("docs: re-approve"));
      commit(root, { "src/b.ts": "b\n" }, owned("feat: write b"));

      const { issues, report } = check(root);
      expect(report.reapprovalAdded).toEqual([{ commit: short(reapproval), added: ["src/b.ts"] }]);
      expect(codes(issues)).toEqual([`warning:scope.reapproval-widened:${ACTIVE_PLAN}`]);
      expect(issues[0]!.message).toContain("src/b.ts");
      expect(report.approved).toEqual(["src/b.ts"]);
    });
  });

  describe("ownership and trailers", () => {
    it("owns commits by final-paragraph Change trailers, including comma values and two lines", () => {
      const { root } = approvedRepo(["src/a.ts", "src/b.ts", "src/c.ts"], { [`.grace/changes/active/${OTHER}/spec.xml`]: spec(OTHER, "draft") });
      commit(root, { "src/a.ts": "a\n" }, `feat: a\n\nChange: ${OTHER}, ${ID}`);
      commit(root, { "src/b.ts": "b\n" }, `feat: b\n\nBody text.\n\nChange: ${OTHER}\nChange: ${ID}\nCo-Authored-By: Someone <s@example.test>`);
      commit(root, { "src/c.ts": "c\n" }, `feat: c\n\nchange: ${ID}`);

      const { issues, report } = check(root);
      expect(report.ownedCommits).toBe(4);
      expect(report.approved).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
      expect(report.untaggedInScope).toEqual([]);
      expect(issues).toEqual([]);
    });

    it("does not own a Change line in the body or separated from Co-Authored-By by a blank line", () => {
      const { root } = approvedRepo(["src/a.ts", "src/b.ts"]);
      const body = commit(root, { "src/a.ts": "a\n" }, `feat: a\n\nChange: ${ID}\n\nExplains the change in prose.`);
      const separated = commit(root, { "src/b.ts": "b\n" }, `feat: b\n\nChange: ${ID}\n\nCo-Authored-By: Someone <s@example.test>`);

      const { issues, report } = check(root);
      expect(report.ownedCommits).toBe(1);
      expect(report.approved).toEqual([]);
      expect(report.untaggedInScope).toEqual([short(body), short(separated)]);
      expect(codes(issues)).toEqual(["warning:scope.untagged-commit:src/a.ts", "warning:scope.untagged-commit:src/b.ts"]);
    });

    it("treats a trailer naming no active bundle as untagged", () => {
      const { root } = approvedRepo(["src/a.ts"], {
        [`.grace/changes/active/${OTHER}/spec.xml`]: spec(OTHER, "draft"),
        ".grace/changes/archive/C-OLD/spec.xml": spec("C-OLD", "applied"),
      });
      const archived = commit(root, { "src/a.ts": "1\n" }, owned("feat: archived id", "C-OLD"));
      const missing = commit(root, { "src/a.ts": "2\n" }, owned("feat: missing id", "C-GONE"));
      commit(root, { "src/a.ts": "3\n" }, owned("feat: other active id", OTHER));

      const { report } = check(root);
      expect(report.ownedCommits).toBe(1);
      expect(report.untaggedInScope).toEqual([short(archived), short(missing)]);
      expect(report.untaggedOther).toEqual({ count: 0, commits: [] });
    });

    it("treats a merge commit's first-parent diff as untagged", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const mainline = fixtureGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      fixtureGit(root, ["checkout", "--quiet", "-b", "side"]);
      commit(root, { "src/a.ts": "a\n" }, owned("feat: write a on side"));
      fixtureGit(root, ["checkout", "--quiet", mainline]);
      commit(root, { "docs/note.md": "n\n" }, "docs: mainline note");
      fixtureGit(root, ["merge", "--quiet", "--no-ff", "side", "-m", owned("Merge branch side")]);
      const merge = fixtureGit(root, ["rev-parse", "HEAD"]);

      const { report } = check(root);
      expect(report.ownedCommits).toBe(2);
      expect(report.approved).toEqual(["src/a.ts"]);
      expect(report.untaggedInScope).toEqual([short(merge)]);
      expect(report.untaggedOther.count).toBe(1);
    });

    it("warns scope.untagged-commit only for untagged commits touching the final scope; lists the rest in untaggedOther", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      const inScope: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        inScope.push(commit(root, { "src/a.ts": `${index}\n` }, `fix: untagged ${index}`));
      }
      const other = [
        commit(root, { "docs/one.md": "1\n" }, "docs: one"),
        commit(root, { "docs/two.md": "2\n", "src/a.ts": "owned\n" }, owned("feat: owned")),
        commit(root, { "docs/three.md": "3\n" }, "docs: three"),
      ];
      commit(root, { ".grace/graph/index.xml": "<g />\n" }, "chore: grace only");

      const { issues, report } = check(root);
      expect(report.untaggedInScope).toEqual(inScope.map(short));
      expect(report.untaggedOther).toEqual({ count: 2, commits: [short(other[0]!), short(other[2]!)] });
      const untagged = issues.filter((issue) => issue.code === "scope.untagged-commit");
      expect(untagged).toHaveLength(5);
      expect(untagged.every((issue) => issue.severity === "warning" && issue.file === "src/a.ts")).toBe(true);
      expect(untagged[0]!.message).toContain(short(inScope[0]!));
      expect(untagged[0]!.message).toContain("6");
    });

    it("raises scope.no-owned-commits as error when required, warning otherwise; never for <None />", () => {
      const root = seeded();
      commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, "docs: approve");

      expect(codes(check(root, { requireChangeTrailers: true }).issues)).toEqual([`error:scope.no-owned-commits:${ACTIVE_PLAN}`]);
      expect(codes(check(root, { requireChangeTrailers: false }).issues)).toEqual([`warning:scope.no-owned-commits:${ACTIVE_PLAN}`]);
      expect(check(root).report.ownedCommits).toBe(0);

      const none = seeded();
      commit(none, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", []) }, "docs: approve");
      expect(check(none, { requireChangeTrailers: true }).issues).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("raises scope.approval-uncommitted", () => {
      const root = seeded();
      const draft = commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "draft", ["src/a.ts"]) }, owned("docs: draft"));
      commit(root, { "src/z.ts": "z\n" }, owned("feat: write z"));

      const { issues, report } = check(root, { requireChangeTrailers: true });
      expect(codes(issues)).toEqual([`error:scope.approval-uncommitted:${ACTIVE_PLAN}`]);
      expect(report.firstCommit).toBe(draft);
      expect(report.approvalCommit).toBeNull();
      expect(report.errors).toEqual([]);
      expect(report.ownedCommits).toBe(0);
    });

    it("reports a project outside git as skipped", () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "grace-not-git-"));
      const { issues, report } = check(root);
      expect(codes(issues)).toEqual([`warning:scope.committed-check-skipped:${ACTIVE_PLAN}`]);
      expect(issues[0]!.message).toContain("not a git worktree");
      expect(report.skipped).toBe("not-git");
    });

    it("reports a shallow clone as skipped", () => {
      const { root: origin } = approvedRepo(["src/a.ts"]);
      commit(origin, { "src/a.ts": "a\n" }, owned("feat: write a"));
      const parent = mkdtempSync(path.join(os.tmpdir(), "grace-shallow-"));
      fixtureGit(parent, ["clone", "--quiet", "--depth", "1", pathToFileURL(origin).href, "clone"]);

      const { issues, report } = check(path.join(parent, "clone"));
      expect(codes(issues)).toEqual([`warning:scope.committed-check-skipped:${ACTIVE_PLAN}`]);
      expect(issues[0]!.message).toContain("shallow");
      expect(report.skipped).toBe("shallow");
    });

    it("checks a change whose bundle is archived at HEAD", () => {
      const { root } = approvedRepo(["src/a.ts"]);
      commit(root, { "src/a.ts": "a\n" }, owned("feat: write a"));
      commit(
        root,
        {
          [`${ACTIVE}/spec.xml`]: null,
          [ACTIVE_PLAN]: null,
          [`${ARCHIVE}/spec.xml`]: spec(ID, "applied"),
          [`${ARCHIVE}/plan.xml`]: plan(ID, "applied", ["src/a.ts"]),
        },
        owned("chore: archive"),
      );

      const { issues, report } = check(root);
      expect(issues).toEqual([]);
      expect(report.ownedCommits).toBe(3);
      expect(report.approved).toEqual(["src/a.ts"]);
    });

    describe.if(process.platform === "win32")("on win32", () => {
      it("matches committed paths case-insensitively on win32", () => {
        const { root } = approvedRepo(["src/foo.ts"]);
        widen(root, ["src/foo.ts", "src/bar.ts"]);
        commit(root, { "Src/Foo.ts": "f\n", "Src/Bar.ts": "b\n" }, owned("feat: write"));

        const { issues, report } = check(root);
        expect(issues).toEqual([]);
        expect(report.approved).toEqual(["Src/Foo.ts"]);
        expect(report.widenedNear).toEqual(["Src/Bar.ts"]);
      });
    });

    it("classifies non-ASCII and spaced paths", () => {
      const { root } = approvedRepo(["src/über file.ts"]);
      const write = commit(root, { "src/über file.ts": "u\n", "docs/ünïcode name.md": "n\n" }, owned("feat: write"));

      const { report } = check(root);
      expect(report.approved).toEqual(["src/über file.ts"]);
      expect(report.errors).toEqual([{ file: "docs/ünïcode name.md", code: "scope.committed-outside", commit: short(write) }]);
    });

    it("ownershipFallback treats commits naming the id as owned", () => {
      const root = seeded();
      commit(root, { [`${ACTIVE}/spec.xml`]: spec(ID, "approved"), [ACTIVE_PLAN]: plan(ID, "approved", ["src/a.ts"]) }, `docs: approve ${ID}`);
      commit(root, { "src/a.ts": "a\n" }, `feat: write a\n\nPart of ${ID}.`);
      commit(root, { "src/z.ts": "z\n" }, `feat: write z for ${ID}-EXTRA`);

      expect(check(root).report.ownedCommits).toBe(0);
      const { report } = check(root, { requireChangeTrailers: false, ownershipFallback: "message-mentions-id" });
      expect(report.ownedCommits).toBe(2);
      expect(report.approved).toEqual(["src/a.ts"]);
      expect(report.errors).toEqual([]);
      expect(report.untaggedOther.count).toBe(1);
    });
  });
});
