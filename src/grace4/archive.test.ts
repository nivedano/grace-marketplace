import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { archiveChange, locateRootStartTag, rewriteRootStatusAttribute } from "./archive";
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

  it("refuses an empty record file and accepts a non-empty one", async () => {
    const root = createProject();
    const logRoot = createLogRoot();
    writePassingFinalRun(logRoot, root);
    const zeroBytes = path.join(root, "zero-record.md");
    const whitespaceOnly = path.join(root, "blank-record.md");
    const record = path.join(root, "record.md");
    writeFileSync(zeroBytes, "");
    writeFileSync(whitespaceOnly, "   \n\t\n");
    writeFileSync(record, "Reviewed: no findings.\n");

    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot, recordFile: zeroBytes })).rejects.toThrow(/Record file is empty/);
    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot, recordFile: whitespaceOnly })).rejects.toThrow(/Record file is empty/);
    await expect(archiveChange(root, { changeId: CHANGE_ID, logRoot, recordFile: path.join(root, "missing.md") })).rejects.toThrow(/Record file not found/);
    expect(existsSync(activeBundle(root))).toBe(true);

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot, recordFile: record });
    expect(result.recordFile).toBe(record);
    expect(existsSync(path.join(archivedBundle(root), "spec.xml"))).toBe(true);
    expect(existsSync(path.join(archivedBundle(root), "record.md"))).toBe(false);
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

  it("verifies a recorded head once lint records VCS identity", async () => {
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
    });

    const result = await archiveChange(root, { changeId: CHANGE_ID, logRoot });
    expect(result.evidence.headVerified).toBe(true);
    expect(result.evidence.recordedHead).toBe(head);
    expect(result.warnings.join(" ")).not.toContain("records no VCS head");
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
