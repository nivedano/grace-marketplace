import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { lintGraceProject } from "../grace-lint";
import { archiveChange, formatArchiveText, locateRootStartTag, rewriteRootStatusAttribute } from "./archive";
import { commit, createRepo, fixtureGit, plan, spec } from "./git-fixture";
import { projectSlug } from "./run-log-store";
import { writeChangeBundleFixture, writeMinimalGrace4Project } from "./test-fixtures";

const CHANGE_ID = "C-ARCHIVE";

function createProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grace-archive-"));
  writeMinimalGrace4Project(root);
  writeChangeBundleFixture(root, { changeId: CHANGE_ID, location: "active", specStatus: "approved", planStatus: "approved" });
  return root;
}

function createLogRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "grace-archive-logs-"));
}

function writeRun(logRoot: string, root: string, runId: string, meta: Record<string, unknown>) {
  const runDir = path.join(logRoot, projectSlug(root), "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return runDir;
}

function writePassingFinalRun(logRoot: string, root: string, runId = "2026-01-01T10-00-00_C-ARCHIVE") {
  return writeRun(logRoot, root, runId, {
    schemaVersion: "1.0.0",
    tool: "grace-lint",
    changeId: CHANGE_ID,
    assertionMode: "final",
    projectRoot: root,
    slug: projectSlug(root),
    startedAt: "2026-01-01T10:00:00.000Z",
    finishedAt: "2026-01-01T10:01:00.000Z",
    status: "passed",
    commands: [],
  });
}

function runGit(root: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout) };
}

function initGitProject(root: string) {
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.email", "archive@example.com"]);
  runGit(root, ["config", "user.name", "Archive Test"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-m", "chore: fixture"]);
}

function archivedBundle(root: string) {
  return path.join(root, ".grace", "changes", "archive", CHANGE_ID);
}

function activeBundle(root: string) {
  return path.join(root, ".grace", "changes", "active", CHANGE_ID);
}

describe("grace archive", () => {
  it("flips both statuses and moves the bundle when a passing final run exists", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);
    const originalSpec = readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8");

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(result.to).toBe(`.grace/changes/archive/${CHANGE_ID}`);
    expect(result.moveMode).toBe("filesystem");
    expect(existsSync(activeBundle(root))).toBe(false);
    const archivedSpec = readFileSync(path.join(archivedBundle(root), "spec.xml"), "utf8");
    const archivedPlan = readFileSync(path.join(archivedBundle(root), "plan.xml"), "utf8");
    expect(archivedSpec).toBe(originalSpec.replace('status="approved"', 'status="applied"'));
    expect(archivedPlan).toContain('<GraceChangePlan graceVersion="4.0" status="applied">');
    expect(result.statusFlips).toHaveLength(2);
    expect(result.evidence.headVerified).toBe(false);
    expect(result.warnings.join(" ")).toContain("records no VCS head");
  });

  it("stages the rename and the flipped content in a git worktree without committing", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(result.moveMode).toBe("git");
    expect(result.staged).toBe(true);
    const staged = runGit(root, ["diff", "--cached", "--name-only"]).stdout;
    expect(staged).toContain(`.grace/changes/archive/${CHANGE_ID}/spec.xml`);
    expect(runGit(root, ["show", `:.grace/changes/archive/${CHANGE_ID}/spec.xml`]).stdout).toContain('status="applied"');
    expect(runGit(root, ["show", `:.grace/changes/archive/${CHANGE_ID}/plan.xml`]).stdout).toContain('status="applied"');
    expect(runGit(root, ["log", "--oneline"]).stdout.trim().split("\n")).toHaveLength(1);
  });

  it("refuses when no final run evidence exists and leaves the bundle untouched", async () => {
    const root = createProject();
    const logRoot = createLogRoot();

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/No final run evidence/);
    expect(existsSync(activeBundle(root))).toBe(true);
    expect(readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8")).toContain('status="approved"');
  });

  it("refuses when the most recent final run failed", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root, "2026-01-01T10-00-00_C-ARCHIVE");
    writeRun(logRoot, root, "2026-01-02T10-00-00_C-ARCHIVE", {
      changeId: CHANGE_ID,
      assertionMode: "final",
      startedAt: "2026-01-02T10:00:00.000Z",
      finishedAt: "2026-01-02T10:01:00.000Z",
      status: "failed",
    });

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/recorded status "failed"/);
  });

  it("ignores runs recorded for another change or another assertion mode", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writeRun(logRoot, root, "2026-01-01T09-00-00_C-ARCHIVE", { changeId: CHANGE_ID, assertionMode: "target", status: "passed", startedAt: "2026-01-01T09:00:00.000Z" });
    writeRun(logRoot, root, "2026-01-01T09-30-00_C-OTHER", { changeId: "C-OTHER", assertionMode: "final", status: "passed", startedAt: "2026-01-01T09:30:00.000Z" });

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/No final run evidence/);
  });

  it("refuses when the index holds staged files outside the bundle", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);
    writeFileSync(path.join(root, "unrelated.txt"), "staged edit\n");
    runGit(root, ["add", "--", "unrelated.txt"]);

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/staged file\(s\) outside/);
    expect(existsSync(activeBundle(root))).toBe(true);
    expect(readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8")).toContain('status="approved"');
  });

  it("refuses a bundle whose statuses are not approved", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);
    writeChangeBundleFixture(root, { changeId: CHANGE_ID, location: "active", specStatus: "approved", planStatus: "draft" });

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/has status "draft"/);
  });

  it("refuses when the archived destination already exists", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);
    writeChangeBundleFixture(root, { changeId: CHANGE_ID, location: "archive", specStatus: "applied", planStatus: "applied" });

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/already exists/);
  });

  it("rejects an unknown change id and a malformed change id before touching the filesystem", async () => {
    const root = createProject();
    const logRoot = createLogRoot();

    await expect(archiveChange(root, { changeId: "not-an-anchor", logRoot })).rejects.toThrow(/Invalid change id/);
    await expect(archiveChange(root, { changeId: "C-MISSING", logRoot })).rejects.toThrow(/No active change bundle/);
  });

  it("rolls the status flip back when the move fails", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);
    // A plain file at the archive parent makes both mkdir and rename fail.
    const archiveParent = path.join(root, ".grace", "changes", "archive");
    rmSync(archiveParent, { recursive: true, force: true });
    writeFileSync(archiveParent, "not a directory\n");

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/Archive move failed/);
    expect(readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8")).toContain('status="approved"');
    expect(readFileSync(path.join(activeBundle(root), "plan.xml"), "utf8")).toContain('status="approved"');
  });

  it("verifies a recorded head when the run recorded a clean tree", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    const head = runGit(root, ["rev-parse", "HEAD"]).stdout.trim();
    writeRun(logRoot, root, "2026-01-03T10-00-00_C-ARCHIVE", {
      changeId: CHANGE_ID,
      assertionMode: "final",
      status: "passed",
      startedAt: "2026-01-03T10:00:00.000Z",
      finishedAt: "2026-01-03T10:01:00.000Z",
      head,
      dirty: false,
    });

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });
    expect(result.evidence.headVerified).toBe(true);
    expect(result.evidence.recordedHead).toBe(head);
    expect(result.warnings.join(" ")).not.toContain("records no VCS head");
  });

  it("refuses a run that records a head but not whether the tree was clean", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    writeRun(logRoot, root, "2026-01-03T10-00-00_C-ARCHIVE", {
      changeId: CHANGE_ID,
      assertionMode: "final",
      status: "passed",
      startedAt: "2026-01-03T10:00:00.000Z",
      finishedAt: "2026-01-03T10:01:00.000Z",
      head: runGit(root, ["rev-parse", "HEAD"]).stdout.trim(),
    });

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/did not record whether the tree was clean/);
    expect(readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8")).toContain('status="approved"');
  });

  function writeCleanRunAtHead(logRoot: string, root: string) {
    writeRun(logRoot, root, "2026-01-03T10-00-00_C-ARCHIVE", {
      changeId: CHANGE_ID,
      assertionMode: "final",
      status: "passed",
      startedAt: "2026-01-03T10:00:00.000Z",
      finishedAt: "2026-01-03T10:01:00.000Z",
      head: runGit(root, ["rev-parse", "HEAD"]).stdout.trim(),
      dirty: false,
    });
  }

  it("refuses an unstaged edit to a tracked file outside the bundle made after a clean final run", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    writeCleanRunAtHead(logRoot, root);
    const tracked = runGit(root, ["ls-files", "--", ".grace/context"]).stdout.split("\n").filter(Boolean)[0]!;
    writeFileSync(path.join(root, tracked), `${readFileSync(path.join(root, tracked), "utf8")}<!-- edited after the gate -->\n`);

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/changed outside the .* bundle since the final run/);
    expect(existsSync(activeBundle(root))).toBe(true);
  });

  it("refuses an untracked file outside the bundle created after a clean final run", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    writeCleanRunAtHead(logRoot, root);
    writeFileSync(path.join(root, "after-the-gate.txt"), "late\n");

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/changed outside the .* bundle since the final run/);
    expect(existsSync(activeBundle(root))).toBe(true);
  });
});

describe("grace archive on real final gate runs", () => {
  const passingCommand = `${process.execPath} gate-ok.js`;

  function createGatedProject() {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-archive-gate-"));
    writeMinimalGrace4Project(root);
    writeFileSync(path.join(root, "gate-ok.js"), `console.log("gate-ok");\n`);
    writeChangeBundleFixture(root, {
      changeId: CHANGE_ID,
      location: "active",
      specStatus: "approved",
      planStatus: "approved",
      planTargetAssertions: `<MustPassCommand><Command>${passingCommand}</Command></MustPassCommand>`,
    });
    initGitProject(root);
    return root;
  }

  async function runFinalGate(root: string, logRoot: string) {
    await lintGraceProject(root, { assertionMode: "final", changeId: CHANGE_ID, runCommands: true, commandLogRoot: logRoot, commandProgress: () => {} });
  }

  it("archives on a final run lint recorded against the clean current HEAD", async () => {
    const root = createGatedProject();
    const logRoot = createLogRoot();
    await runFinalGate(root, logRoot);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(result.evidence.headVerified).toBe(true);
    expect(result.evidence.recordedHead).toBe(runGit(root, ["rev-parse", "HEAD"]).stdout.trim());
    expect(result.warnings).toEqual([]);
  });

  it("refuses a final run lint recorded against uncommitted changes", async () => {
    const root = createGatedProject();
    const logRoot = createLogRoot();
    writeFileSync(path.join(root, "uncommitted.txt"), "work in progress\n");
    await runFinalGate(root, logRoot);

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/ran against uncommitted changes/);
    expect(readFileSync(path.join(activeBundle(root), "plan.xml"), "utf8")).toContain('status="approved"');
  });

  it("refuses when a recorded head does not match the current HEAD", async () => {
    const root = createProject();
    initGitProject(root);
    const logRoot = createLogRoot();
    writeRun(logRoot, root, "2026-01-03T10-00-00_C-ARCHIVE", {
      changeId: CHANGE_ID,
      assertionMode: "final",
      status: "passed",
      startedAt: "2026-01-03T10:00:00.000Z",
      finishedAt: "2026-01-03T10:01:00.000Z",
      head: "0000000000000000000000000000000000000000",
    });

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot })).rejects.toThrow(/not the current HEAD/);
  });
});

describe("root status attribute rewriting", () => {
  it("edits only the root element status attribute", () => {
    const text = `<?xml version="1.0"?>\n<!-- status="decoy" -->\n<GraceChangeSpec graceVersion="4.0" status="approved"><C-X status="approved"><Note a=">">x</Note></C-X></GraceChangeSpec>\n`;
    const flipped = rewriteRootStatusAttribute(text, "spec.xml", "GraceChangeSpec", "approved", "applied");
    expect(flipped).toBe(text.replace('graceVersion="4.0" status="approved"', 'graceVersion="4.0" status="applied"'));
    expect(flipped).toContain('<C-X status="approved">');
  });

  it("skips declarations, comments, and doctypes when locating the root", () => {
    const text = `<?xml version="1.0"?><!DOCTYPE x><!-- <Fake status="x"> --><GraceChangePlan status='approved'></GraceChangePlan>`;
    expect(locateRootStartTag(text)?.tagName).toBe("GraceChangePlan");
    expect(rewriteRootStatusAttribute(text, "plan.xml", "GraceChangePlan", "approved", "applied")).toContain("status='applied'");
  });

  it("refuses a root element with the wrong tag or a missing status attribute", () => {
    expect(() => rewriteRootStatusAttribute(`<Other status="approved"/>`, "spec.xml", "GraceChangeSpec", "approved", "applied")).toThrow(/root element is <Other>/);
    expect(() => rewriteRootStatusAttribute(`<GraceChangeSpec/>`, "spec.xml", "GraceChangeSpec", "approved", "applied")).toThrow(/carries 0 status attributes/);
  });
});

describe("grace archive committed-scope integration", () => {
  const ACTIVE_PLAN = `.grace/changes/active/${CHANGE_ID}/plan.xml`;
  const ACTIVE_SPEC = `.grace/changes/active/${CHANGE_ID}/spec.xml`;

  function owned(subject: string) {
    return `${subject}\n\nChange: ${CHANGE_ID}`;
  }

  /** A git project seeded with a GRACE 4 skeleton; each case adds the change history. */
  function seededProject(extra: Record<string, string> = {}) {
    const root = createRepo();
    writeMinimalGrace4Project(root);
    commit(root, { "README.md": "fixture\n", ...extra }, "chore: seed");
    return root;
  }

  function approve(root: string, scope: string[]) {
    return commit(root, { [ACTIVE_SPEC]: spec(CHANGE_ID, "approved"), [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", scope) }, owned("docs: approve"));
  }

  function cleanRunAtHead(logRoot: string, root: string) {
    writeRun(logRoot, root, "2026-01-03T10-00-00_C-ARCHIVE", {
      changeId: CHANGE_ID,
      assertionMode: "final",
      status: "passed",
      startedAt: "2026-01-03T10:00:00.000Z",
      finishedAt: "2026-01-03T10:01:00.000Z",
      head: fixtureGit(root, ["rev-parse", "HEAD"]),
      dirty: false,
    });
  }

  const refusalCases: { code: string; file: string; build: (root: string) => void }[] = [
    {
      code: "scope.committed-outside",
      file: "src/stray.ts",
      build(root) {
        approve(root, ["src/a.ts"]);
        commit(root, { "src/stray.ts": "s\n" }, owned("feat: stray write"));
      },
    },
    {
      code: "scope.widening-with-code",
      file: "src/b.ts",
      build(root) {
        approve(root, ["src/a.ts"]);
        commit(root, { [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts", "src/b.ts"]), "src/a.ts": "a\n" }, owned("docs: widen with code"));
        commit(root, { "src/b.ts": "b\n" }, owned("feat: write b"));
      },
    },
    {
      code: "scope.written-before-widening",
      file: "src/b.ts",
      build(root) {
        approve(root, ["src/a.ts"]);
        commit(root, { "src/b.ts": "b\n" }, owned("feat: write b early"));
        commit(root, { [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts", "src/b.ts"]) }, owned("docs: widen late"));
      },
    },
    {
      code: "scope.written-before-approval",
      file: "src/a.ts",
      build(root) {
        commit(root, { [ACTIVE_SPEC]: spec(CHANGE_ID, "approved"), [ACTIVE_PLAN]: plan(CHANGE_ID, "draft", ["src/a.ts"]) }, owned("docs: draft"));
        commit(root, { "src/a.ts": "a\n" }, owned("feat: write a early"));
        commit(root, { [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts"]) }, owned("docs: approve"));
      },
    },
    {
      code: "scope.approved-plan-mutated",
      file: ACTIVE_PLAN,
      build(root) {
        approve(root, ["src/a.ts"]);
        commit(root, { [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts"], { target: "<MustVerify><Module>M-SECOND</Module></MustVerify>" }) }, owned("docs: edit gate"));
      },
    },
    {
      code: "scope.approval-uncommitted",
      file: ACTIVE_PLAN,
      build(root) {
        commit(root, { [ACTIVE_SPEC]: spec(CHANGE_ID, "approved"), [ACTIVE_PLAN]: plan(CHANGE_ID, "draft", ["src/a.ts"]) }, owned("docs: draft"));
        // Approved only in the working tree. The bundle is exempt from the clean-tree check, so the history check must catch it.
        writeFileSync(path.join(root, ...ACTIVE_PLAN.split("/")), plan(CHANGE_ID, "approved", ["src/a.ts"]));
      },
    },
    {
      code: "scope.no-owned-commits",
      file: ACTIVE_PLAN,
      build(root) {
        commit(root, { ".grace-lint.json": `{ "requireChangeTrailers": true }\n` }, "chore: require trailers");
        commit(root, { [ACTIVE_SPEC]: spec(CHANGE_ID, "approved"), [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts"]) }, "docs: approve without a trailer");
        commit(root, { "src/a.ts": "a\n" }, "feat: write a without a trailer");
      },
    },
  ];

  for (const refusal of refusalCases) {
    it(`refuses on ${refusal.code} before the first write`, async () => {
      const root = seededProject();
      refusal.build(root);
      const logRoot = createLogRoot();
      cleanRunAtHead(logRoot, root);
      const planBefore = readFileSync(path.join(activeBundle(root), "plan.xml"), "utf8");
      const specBefore = readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8");

      const error = await archiveChange(root, { changeId: CHANGE_ID, logRoot }).then(() => null, (thrown: unknown) => thrown as Error & { code?: string });

      expect(error).not.toBeNull();
      expect(error!.code).toBe("precondition-failed");
      expect(error!.message).toContain(refusal.code);
      expect(error!.message).toContain(refusal.file);
      expect(existsSync(archivedBundle(root))).toBe(false);
      expect(readFileSync(path.join(activeBundle(root), "plan.xml"), "utf8")).toBe(planBefore);
      expect(readFileSync(path.join(activeBundle(root), "spec.xml"), "utf8")).toBe(specBefore);
      expect(fixtureGit(root, ["diff", "--cached", "--name-only"])).toBe("");
    });
  }

  it("archives with warnings only and carries committedScope in JSON and text", async () => {
    const root = seededProject();
    approve(root, ["src/a.ts"]);
    commit(root, { [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts", "tools/t.ts"]) }, owned("docs: widen"));
    commit(root, { "src/a.ts": "a\n", "tools/t.ts": "t\n" }, owned("feat: write a and t"));
    commit(root, { [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts", "tools/t.ts"], { intent: "Reworded intent." }) }, owned("docs: amend intent"));
    const logRoot = createLogRoot();
    cleanRunAtHead(logRoot, root);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(existsSync(archivedBundle(root))).toBe(true);
    expect(result.committedScope.widenedFar).toEqual(["tools/t.ts"]);
    expect(result.committedScope.approved).toEqual(["src/a.ts"]);
    expect(result.committedScope.amendments).toHaveLength(1);
    expect(result.committedScope.errors).toEqual([]);

    const json = JSON.parse(JSON.stringify(result)) as { committedScope: { widenedFar: string[]; changeId: string } };
    expect(json.committedScope.changeId).toBe(CHANGE_ID);
    expect(json.committedScope.widenedFar).toEqual(["tools/t.ts"]);

    const text = formatArchiveText(result);
    expect(text).toContain("Committed scope");
    expect(text).toContain("tools/t.ts");
    expect(text).toMatch(/Next Action[\s\S]*far[\s\S]*amendments[\s\S]*re-approval additions[\s\S]*archive commit body/);
  });

  it("records a skipped committed-scope check outside git without refusing", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(result.committedScope.skipped).toBe("not-git");
    expect(formatArchiveText(result)).toContain("skipped");
  });

  it("does not refuse a missing owned commit when requireChangeTrailers is off", async () => {
    const root = seededProject();
    commit(root, { [ACTIVE_SPEC]: spec(CHANGE_ID, "approved"), [ACTIVE_PLAN]: plan(CHANGE_ID, "approved", ["src/a.ts"]) }, "docs: approve without a trailer");
    const logRoot = createLogRoot();
    cleanRunAtHead(logRoot, root);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(result.committedScope.ownedCommits).toBe(0);
  });

  it("passes the project's committedScopeExempt globs to the check", async () => {
    const root = seededProject({ ".grace-lint.json": `{ "committedScopeExempt": [".beads/**"] }\n` });
    approve(root, ["src/a.ts"]);
    commit(root, { ".beads/issues.jsonl": "1\n", "src/a.ts": "a\n" }, owned("feat: write a and bookkeeping"));
    const logRoot = createLogRoot();
    cleanRunAtHead(logRoot, root);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });

    expect(result.committedScope.exempt).toEqual([".beads/issues.jsonl"]);
    expect(result.committedScope.errors).toEqual([]);
  });
});
