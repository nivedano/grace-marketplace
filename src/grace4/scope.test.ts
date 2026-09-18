import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { resolveGrace4Paths } from "./project";
import {
  collectActiveChangeScopes,
  detectScopeOverlaps,
  detectUnsafeConcurrentExecution,
  durableOverlaps,
  observedWriteScopeContains,
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

  it("parses an optional review scope and keeps it out of parallel-safety blocking", () => {
    const root = createProject();
    writeProjectFile(root, ".grace/changes/active/C-REVIEW/spec.xml", `<GraceChangeSpec graceVersion="4.0" status="approved"><C-REVIEW /></GraceChangeSpec>`);
    writeProjectFile(
      root,
      ".grace/changes/active/C-REVIEW/plan.xml",
      `<GraceChangePlan graceVersion="4.0" status="approved"><C-REVIEW><DurableScope><GraphAnchors><M-ONE /></GraphAnchors></DurableScope><ObservedWriteScope><File>src/one.ts</File></ObservedWriteScope><ReviewScope><Glob>design-rules/**</Glob><File>docs/invariants.md</File></ReviewScope></C-REVIEW></GraceChangePlan>`,
    );
    writeProjectFile(root, ".grace/changes/active/C-OTHER/spec.xml", `<GraceChangeSpec graceVersion="4.0" status="approved"><C-OTHER /></GraceChangeSpec>`);
    writeProjectFile(
      root,
      ".grace/changes/active/C-OTHER/plan.xml",
      `<GraceChangePlan graceVersion="4.0" status="approved"><C-OTHER><DurableScope><GraphAnchors><M-TWO /></GraphAnchors></DurableScope><ObservedWriteScope><File>src/two.ts</File></ObservedWriteScope><ReviewScope><Glob>design-rules/**</Glob></ReviewScope></C-OTHER></GraceChangePlan>`,
    );

    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    const review = scopes.find((scope) => scope.changeId === "C-REVIEW")!;

    expect(review.issues).toHaveLength(0);
    expect(review.reviewWrites.globs).toEqual(["design-rules/**"]);
    expect(review.reviewWrites.files).toEqual(["docs/invariants.md"]);
    expect(review.observedWrites.files).toEqual(["src/one.ts"]);
    expect(observedWriteScopeContains(review.reviewWrites, "design-rules/R-001.md")).toBe(true);
    expect(observedWriteScopeContains(review.observedWrites, "design-rules/R-001.md")).toBe(false);
    // A shared review corpus is the expected case, so it never blocks parallel execution.
    expect(detectUnsafeConcurrentExecution(scopes)).toEqual([]);
  });

  it("omits review writes entirely when a plan declares no review scope", () => {
    const root = createProject();
    writeChange(root, "C-PLAIN", { graphAnchor: "M-PLAIN", file: "src/plain.ts" });

    const scope = collectActiveChangeScopes(resolveGrace4Paths(root))[0]!;
    expect(scope.issues).toHaveLength(0);
    expect(scope.reviewWrites).toEqual({ files: [], globs: [] });
    expect(observedWriteScopeContains(scope.reviewWrites, "design-rules/R-001.md")).toBe(false);
  });

  it("reports an empty or malformed review scope as a plan error", () => {
    const root = createProject();
    writeProjectFile(root, ".grace/changes/active/C-EMPTY/spec.xml", `<GraceChangeSpec graceVersion="4.0" status="approved"><C-EMPTY /></GraceChangeSpec>`);
    writeProjectFile(
      root,
      ".grace/changes/active/C-EMPTY/plan.xml",
      `<GraceChangePlan graceVersion="4.0" status="approved"><C-EMPTY><DurableScope><GraphAnchors><M-ONE /></GraphAnchors></DurableScope><ObservedWriteScope><File>src/one.ts</File></ObservedWriteScope><ReviewScope /></C-EMPTY></GraceChangePlan>`,
    );
    writeProjectFile(root, ".grace/changes/active/C-BAD/spec.xml", `<GraceChangeSpec graceVersion="4.0" status="approved"><C-BAD /></GraceChangeSpec>`);
    writeProjectFile(
      root,
      ".grace/changes/active/C-BAD/plan.xml",
      `<GraceChangePlan graceVersion="4.0" status="approved"><C-BAD><DurableScope><GraphAnchors><M-ONE /></GraphAnchors></DurableScope><ObservedWriteScope><File>src/one.ts</File></ObservedWriteScope><ReviewScope><Reviewer>anyone</Reviewer></ReviewScope></C-BAD></GraceChangePlan>`,
    );

    const scopes = collectActiveChangeScopes(resolveGrace4Paths(root));
    const empty = scopes.find((scope) => scope.changeId === "C-EMPTY")!;
    const bad = scopes.find((scope) => scope.changeId === "C-BAD")!;

    expect(empty.issues.map((entry) => entry.code)).toContain("scope.empty-review-scope");
    expect(bad.issues.map((entry) => entry.code)).toContain("scope.invalid-review-shape");
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
