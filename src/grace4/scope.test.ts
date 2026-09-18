import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { resolveGrace4Paths } from "./project";
import {
  collectActiveChangeScopes,
  detectScopeOverlaps,
  detectUnsafeConcurrentExecution,
  detectUnsafeConcurrentTasks,
  durableOverlaps,
  parseScopeGlob,
  scopeGlobsOverlap,
  type DurableOwnershipIndex,
  type DurableScope,
} from "./scope";

function createProject() {
  const root = path.join(os.tmpdir(), `grace4-scope-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeProjectFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeChange(root: string, changeId: string, options: { graphAnchor: string; file: string; glob?: string; status?: string; contextArtifact?: string }) {
  const status = options.status ?? "approved";
  const bundle = `.grace/changes/active/${changeId}`;
  writeProjectFile(root, `${bundle}/spec.xml`, `<GraceChangeSpec graceVersion="4.0" status="${status}"><${changeId} /></GraceChangeSpec>`);
  writeProjectFile(
    root,
    `${bundle}/plan.xml`,
    `<GraceChangePlan graceVersion="4.0" status="${status}"><${changeId}><DurableScope><GraphAnchors><${options.graphAnchor} /></GraphAnchors>${options.contextArtifact ? `<ContextArtifact>${options.contextArtifact}</ContextArtifact>` : ""}</DurableScope><ObservedWriteScope><File>${options.file}</File>${options.glob ? `<Glob>${options.glob}</Glob>` : ""}</ObservedWriteScope></${changeId}></GraceChangePlan>`,
  );
}

describe("GRACE 4 scope detector", () => {
  it("collects active change scopes from approved and draft plans", () => {
    const root = createProject();
    writeChange(root, "C-ONE", { graphAnchor: "M-AUTH-SESSION", file: "src/auth.ts", contextArtifact: "requirements.xml" });
    writeChange(root, "C-TWO", { graphAnchor: "M-PROFILE", file: "src/profile.ts", status: "draft" });

    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    const one = scopes.find((scope) => scope.changeId === "C-ONE");

    expect(scopes.map((scope) => scope.changeId).sort()).toEqual(["C-ONE", "C-TWO"]);
    expect(one?.durable.contextArtifacts).toContain("requirements.xml");
    expect(one?.observedWrites.files).toContain("src/auth.ts");
  });

  it("reports durable overlap as warnings and observed write overlap as blockers", () => {
    const root = createProject();
    writeChange(root, "C-ONE", { graphAnchor: "M-AUTH-SESSION", file: "src/auth.ts", glob: "src/**/*.ts" });
    writeChange(root, "C-TWO", { graphAnchor: "M-AUTH-SESSION", file: "src/auth.ts", glob: "src/**/*.ts" });

    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    const durableIssues = detectScopeOverlaps(scopes);
    const concurrentIssues = detectUnsafeConcurrentExecution(scopes);

    expect(durableIssues[0]?.severity).toBe("warning");
    expect(durableIssues[0]?.code).toBe("scope.durable-overlap");
    expect(concurrentIssues.every((issue) => issue.severity === "error")).toBe(true);
    expect(concurrentIssues.map((issue) => issue.code)).toContain("scope.parallel-durable-overlap");
    expect(concurrentIssues.map((issue) => issue.code)).toContain("scope.observed-write-overlap");
  });

  it("expands durable document ownership to anchor conflicts", () => {
    const emptyScope = (): DurableScope => ({
      graphAnchors: [],
      verificationAnchors: [],
      contextArtifacts: [],
      graphDocuments: [],
      verificationDocuments: [],
    });
    const left = emptyScope();
    left.graphDocuments.push("GD-MAIN");
    const right = emptyScope();
    right.graphAnchors.push("M-AUTH-SESSION");
    const ownership: DurableOwnershipIndex = {
      graphDocuments: new Map([["GD-MAIN", new Set(["M-AUTH-SESSION"])]]),
      verificationDocuments: new Map(),
    };

    expect(durableOverlaps(left, right, ownership)).toEqual(["graph:GD-MAIN↔M-AUTH-SESSION"]);
  });

  it("does not overlap known documents with anchors owned by another known document", () => {
    const emptyScope = (): DurableScope => ({
      graphAnchors: [],
      verificationAnchors: [],
      contextArtifacts: [],
      graphDocuments: [],
      verificationDocuments: [],
    });
    const left = emptyScope();
    left.graphDocuments.push("GD-A");
    left.verificationDocuments.push("VD-A");
    const right = emptyScope();
    right.graphAnchors.push("M-B");
    right.verificationAnchors.push("V-M-B");
    const ownership: DurableOwnershipIndex = {
      graphDocuments: new Map([
        ["GD-A", new Set(["M-A"])],
        ["GD-B", new Set(["M-B"])],
      ]),
      verificationDocuments: new Map([
        ["VD-A", new Set(["V-M-A"])],
        ["VD-B", new Set(["V-M-B"])],
      ]),
    };

    expect(durableOverlaps(left, right, ownership)).toEqual([]);
  });

  it("conservatively blocks whole-document scope against new or rehomed anchors", () => {
    const emptyScope = (): DurableScope => ({
      graphAnchors: [],
      verificationAnchors: [],
      contextArtifacts: [],
      graphDocuments: [],
      verificationDocuments: [],
    });
    const left = emptyScope();
    left.graphDocuments.push("GD-NEW");
    const right = emptyScope();
    right.graphAnchors.push("M-NEW");

    expect(durableOverlaps(left, right)).toEqual(["graph:GD-NEW↔M-NEW"]);
  });

  it("rejects text-only scopes and accepts explicit None markers", () => {
    const root = createProject();
    writeProjectFile(root, ".grace/changes/active/C-TEXT/spec.xml", `<GraceChangeSpec graceVersion="4.0" status="approved"><C-TEXT /></GraceChangeSpec>`);
    writeProjectFile(root, ".grace/changes/active/C-TEXT/plan.xml", `<GraceChangePlan graceVersion="4.0" status="approved"><C-TEXT><DurableScope>graph changes</DurableScope><ObservedWriteScope>source changes</ObservedWriteScope></C-TEXT></GraceChangePlan>`);
    writeProjectFile(root, ".grace/changes/active/C-NONE/spec.xml", `<GraceChangeSpec graceVersion="4.0" status="approved"><C-NONE /></GraceChangeSpec>`);
    writeProjectFile(root, ".grace/changes/active/C-NONE/plan.xml", `<GraceChangePlan graceVersion="4.0" status="approved"><C-NONE><DurableScope><None /></DurableScope><ObservedWriteScope><None /></ObservedWriteScope></C-NONE></GraceChangePlan>`);

    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    const textScope = scopes.find((scope) => scope.changeId === "C-TEXT")!;
    const noneScope = scopes.find((scope) => scope.changeId === "C-NONE")!;
    expect(textScope.issues.map((entry) => entry.code)).toContain("scope.empty-durable-scope");
    expect(textScope.issues.map((entry) => entry.code)).toContain("scope.empty-observed-write-scope");
    expect(noneScope.issues).toHaveLength(0);
  });

  it("proves differing extension globs disjoint and auth-prefixed globs overlapping", () => {
    expect(scopeGlobsOverlap(parseScopeGlob("src/**/*.ts"), parseScopeGlob("src/**/*.md"), true)).toBe(false);
    expect(scopeGlobsOverlap(parseScopeGlob("src/**/*.ts"), parseScopeGlob("src/**/auth*.ts"), true)).toBe(true);
    expect(scopeGlobsOverlap(parseScopeGlob("src/**/nested/*.ts"), parseScopeGlob("src/*/nested/a?.ts"), true)).toBe(true);
  });

  it("rejects unsupported, absolute, traversal, and malformed glob syntax as plan errors", () => {
    const root = createProject();
    writeChange(root, "C-BAD-GLOB", { graphAnchor: "M-BAD", file: "src/example.ts", glob: "src/{one,two}/**" });
    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    expect(scopes[0]?.issues.map((issue) => issue.code)).toContain("scope.unsupported-glob");

    for (const invalid of ["/tmp/**", "../src/**", "C:\\src\\**", "src/**x/file.ts", "src/[ab].ts", "!src/**"]) {
      expect(() => parseScopeGlob(invalid), invalid).toThrow();
    }
  });

  it("normalizes backslashes and follows explicit case semantics", () => {
    const windowsStyle = parseScopeGlob("SRC\\**\\Auth*.TS");
    expect(windowsStyle.normalizedPattern).toBe("SRC/**/Auth*.TS");
    expect(scopeGlobsOverlap(windowsStyle, parseScopeGlob("src/**/auth-file.ts"), false)).toBe(true);
    expect(scopeGlobsOverlap(windowsStyle, parseScopeGlob("src/**/auth-file.ts"), true)).toBe(false);
  });

  (process.platform === "win32" ? it : it.skip)("uses Windows case-insensitive collision semantics on Windows", () => {
    expect(scopeGlobsOverlap(parseScopeGlob("SRC/**/Auth*.TS"), parseScopeGlob("src/**/auth-file.ts"), false)).toBe(true);
  });

  it("blocks file-to-glob and nested glob overlaps while allowing disjoint areas", () => {
    const root = createProject();
    writeChange(root, "C-FILE", { graphAnchor: "M-FILE", file: "src/auth/session.ts" });
    writeChange(root, "C-GLOB", { graphAnchor: "M-GLOB", file: "other.txt", glob: "src/**" });
    writeChange(root, "C-NESTED", { graphAnchor: "M-NESTED", file: "nested.txt", glob: "src/auth/**" });
    writeChange(root, "C-DISJOINT", { graphAnchor: "M-DISJOINT", file: "docs/readme.md", glob: "tests/**" });

    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    const issues = detectUnsafeConcurrentExecution(scopes);
    const messages = issues.map((entry) => entry.message);

    expect(messages.some((message) => message.includes("C-FILE") && message.includes("C-GLOB"))).toBe(true);
    expect(messages.some((message) => message.includes("C-GLOB") && message.includes("C-NESTED"))).toBe(true);
    expect(messages.some((message) => message.includes("C-DISJOINT"))).toBe(false);
  });
});

function writeTaskScopedChange(root: string, changeId: string, planScope: string, tasks: string) {
  const bundle = `.grace/changes/active/${changeId}`;
  writeProjectFile(root, `${bundle}/spec.xml`, `<GraceChangeSpec graceVersion="4.0" status="approved"><${changeId} /></GraceChangeSpec>`);
  writeProjectFile(
    root,
    `${bundle}/plan.xml`,
    `<GraceChangePlan graceVersion="4.0" status="approved"><${changeId}><DurableScope><None /></DurableScope><ObservedWriteScope>${planScope}</ObservedWriteScope><ImplementationPlan>${tasks}</ImplementationPlan></${changeId}></GraceChangePlan>`,
  );
}

function task(taskId: string, dependsOn: string, writeScope: string | null) {
  return `<${taskId}><Title>${taskId}</Title><DependsOn>${dependsOn}</DependsOn>`
    + (writeScope === null ? "" : `<WriteScope>${writeScope}</WriteScope>`)
    + `<AcceptanceCriteria><Criterion>Done.</Criterion></AcceptanceCriteria><Verification><Command>bun test</Command></Verification></${taskId}>`;
}

function selectChange(root: string, changeId: string) {
  const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
  const change = scopes.find((scope) => scope.changeId === changeId);
  if (!change) {
    throw new Error(`Missing change ${changeId}`);
  }
  return change;
}

describe("GRACE 4 per-task write scope", () => {
  it("rejects a task write scope entry outside the plan ObservedWriteScope", () => {
    const root = createProject();
    writeTaskScopedChange(
      root,
      "C-ESCAPE",
      `<File>src/lint/core.ts</File><Glob>src/grace4/**</Glob>`,
      task("T-001", "", `<File>src/grace4/scope.ts</File>`) + task("T-002", "", `<File>docs/outside.md</File><Glob>tests/**</Glob>`),
    );

    const change = selectChange(root, "C-ESCAPE");
    const escapes = change.issues.filter((entry) => entry.code === "scope.task-write-scope-escape");

    expect(escapes.map((entry) => entry.severity)).toEqual(["error", "error"]);
    expect(escapes.some((entry) => entry.message.includes("T-002/WriteScope entry docs/outside.md"))).toBe(true);
    expect(escapes.some((entry) => entry.message.includes("T-002/WriteScope glob tests/**"))).toBe(true);
    expect(change.issues.some((entry) => entry.message.includes("T-001"))).toBe(false);
  });

  it("accepts a task glob that repeats a plan glob verbatim", () => {
    const root = createProject();
    writeTaskScopedChange(root, "C-GLOB-ECHO", `<Glob>src/**/*.ts</Glob>`, task("T-001", "", `<Glob>src/**/*.ts</Glob>`));

    expect(selectChange(root, "C-GLOB-ECHO").issues).toEqual([]);
  });

  it("returns a verdict per independent task pair and blocks overlapping writes", () => {
    const root = createProject();
    writeTaskScopedChange(
      root,
      "C-PAIRS",
      `<Glob>src/**</Glob>`,
      task("T-001", "", `<File>src/one.ts</File>`)
        + task("T-002", "", `<File>src/two.ts</File>`)
        + task("T-003", "", `<File>src/two.ts</File>`)
        + task("T-004", "T-001, T-002", `<File>src/four.ts</File>`),
    );

    const preflight = detectUnsafeConcurrentTasks(selectChange(root, "C-PAIRS"));
    const verdict = (left: string, right: string) => preflight.pairs.find((pair) => pair.left === left && pair.right === right);

    expect(verdict("T-001", "T-002")?.verdict).toBe("disjoint");
    expect(verdict("T-002", "T-003")?.verdict).toBe("overlap");
    expect(verdict("T-002", "T-003")?.overlaps).toEqual(["src/two.ts"]);
    // T-004 depends on both, so those pairs are ordered and never compared.
    expect(verdict("T-001", "T-004")).toBeUndefined();
    expect(verdict("T-003", "T-004")?.verdict).toBe("disjoint");
    expect(preflight.issues.map((entry) => entry.code)).toEqual(["scope.parallel-task-write-overlap"]);
    expect(preflight.issues[0]?.severity).toBe("error");
  });

  it("leaves pairs unverdicted and issue-free when a task declares no write scope", () => {
    const root = createProject();
    writeTaskScopedChange(
      root,
      "C-UNDECLARED",
      `<File>src/one.ts</File>`,
      task("T-001", "", null) + task("T-002", "", null),
    );

    const preflight = detectUnsafeConcurrentTasks(selectChange(root, "C-UNDECLARED"));

    expect(preflight.pairs).toEqual([{ left: "T-001", right: "T-002", verdict: "undeclared", overlaps: [] }]);
    expect(preflight.issues).toEqual([]);
  });

  it("refuses to order a cyclic dependency graph instead of looping", () => {
    const root = createProject();
    writeTaskScopedChange(
      root,
      "C-CYCLE",
      `<Glob>src/**</Glob>`,
      task("T-001", "T-002", `<File>src/one.ts</File>`) + task("T-002", "T-001", `<File>src/one.ts</File>`),
    );

    const preflight = detectUnsafeConcurrentTasks(selectChange(root, "C-CYCLE"));

    expect(preflight.pairs).toEqual([]);
    expect(preflight.issues.map((entry) => entry.code)).toEqual(["scope.parallel-task-graph-unresolvable"]);
    expect(preflight.issues[0]?.message).toContain("T-001, T-002");
  });
});
