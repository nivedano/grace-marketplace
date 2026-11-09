import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

import { readPlanHistory, type PlanHistory } from "./committed-scope";
import { commit, createRepo, fixtureGit, plan, spec } from "./git-fixture";

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

  it("records TargetAssertions, task and DurableScope edits between approved versions as mutations", () => {
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
      { commit: taskEdit, sections: ["ImplementationPlan"] },
      { commit: durableEdit, sections: ["DurableScope"] },
    ]);
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
