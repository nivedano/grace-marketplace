import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { collectProjectStatus, formatStatusText } from "./grace-status";
import { GraceCommandError } from "./query/errors";

function createProject() {
  return mkdtempSync(path.join(os.tmpdir(), "grace-status-"));
}

function writeProjectFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeMinimalGrace4Project(root: string) {
  writeProjectFile(root, ".grace/context/requirements.xml", `<GraceRequirements graceVersion="4.0"><Summary>Required.</Summary></GraceRequirements>`);
  writeProjectFile(root, ".grace/context/technology.xml", `<GraceTechnology graceVersion="4.0"><Runtime>Bun</Runtime></GraceTechnology>`);
  writeProjectFile(root, ".grace/context/principles.xml", `<GracePrinciples graceVersion="4.0"><Principle>Safe.</Principle></GracePrinciples>`);
  writeProjectFile(root, ".grace/context/deployment.xml", `<GraceDeployment graceVersion="4.0"><Applicability>applicable</Applicability></GraceDeployment>`);
  writeProjectFile(root, ".grace/context/ux-guidelines.xml", `<GraceUXGuidelines graceVersion="4.0"><Applicability>applicable</Applicability></GraceUXGuidelines>`);
  writeProjectFile(
    root,
    ".grace/graph/index.xml",
    `<GraceGraphIndex graceVersion="4.0"><GraphDocuments><GD-MAIN><Path>graph/main.xml</Path><Owns><M-EXAMPLE /></Owns></GD-MAIN></GraphDocuments></GraceGraphIndex>`,
  );
  writeProjectFile(
    root,
    ".grace/graph/main.xml",
    `<GraceGraphDocument graceVersion="4.0"><GD-MAIN><M-EXAMPLE><Summary>Example module.</Summary><Path>src/example.ts</Path></M-EXAMPLE></GD-MAIN></GraceGraphDocument>`,
  );
  writeProjectFile(
    root,
    ".grace/verification/index.xml",
    `<GraceVerificationIndex graceVersion="4.0"><VerificationDocuments><VD-MAIN><Path>verification/main.xml</Path><Owns><V-M-EXAMPLE /></Owns></VD-MAIN></VerificationDocuments></GraceVerificationIndex>`,
  );
  writeProjectFile(
    root,
    ".grace/verification/main.xml",
    `<GraceVerificationDocument graceVersion="4.0"><VD-MAIN><V-M-EXAMPLE><Command>bun test src/example.test.ts</Command><Scenario>example works</Scenario><Marker>[Example][run][BLOCK_RUN]</Marker></V-M-EXAMPLE></VD-MAIN></GraceVerificationDocument>`,
  );
  mkdirSync(path.join(root, ".grace", "changes", "active"), { recursive: true });
  mkdirSync(path.join(root, ".grace", "changes", "archive"), { recursive: true });
  writeProjectFile(
    root,
    "src/example.ts",
    `// START_MODULE_CONTRACT
//   PURPOSE: Example runtime.
//   SCOPE: Small fixture.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
// START_MODULE_MAP
//   run - Execute the example runtime.
// END_MODULE_MAP
export function run() {
  console.info("[Example][run][BLOCK_RUN] run");
  // START_BLOCK_RUN
  return "ok";
  // END_BLOCK_RUN
}
`,
  );
  writeProjectFile(root, "src/example.test.ts", `import { expect, test } from "bun:test";\ntest("example", () => expect(1).toBe(1));\n`);
}

function writeChange(root: string, changeId: string, options: { location?: "active" | "archive"; specStatus: string; planStatus: string; file?: string; baselineAssertion?: string }) {
  const location = options.location ?? "active";
  const bundle = `.grace/changes/${location}/${changeId}`;
  writeProjectFile(root, `${bundle}/spec.xml`, `<GraceChangeSpec graceVersion="4.0" status="${options.specStatus}"><${changeId}><Summary>Change.</Summary><Goals><Goal>Apply the change.</Goal></Goals><Constraints><Constraint>Preserve project validity.</Constraint></Constraints><NonGoals><NonGoal>Unrelated work.</NonGoal></NonGoals><AcceptanceCriteria><Criterion>The change is verified.</Criterion></AcceptanceCriteria><AffectedAreas><M-EXAMPLE /></AffectedAreas><VerificationIntent><ExpectedCommand>bun test</ExpectedCommand><ExpectedEvidence>Passing tests.</ExpectedEvidence></VerificationIntent></${changeId}></GraceChangeSpec>`);
  writeProjectFile(
    root,
    `${bundle}/plan.xml`,
    `<GraceChangePlan graceVersion="4.0" status="${options.planStatus}"><${changeId}><IntentSummary>Apply the change.</IntentSummary><BaselineAssertions>${options.baselineAssertion ?? "<MustExist><Value>M-EXAMPLE</Value></MustExist>"}</BaselineAssertions><TargetAssertions><MustVerify><Module>M-EXAMPLE</Module></MustVerify></TargetAssertions><DurableScope><GraphAnchors><M-EXAMPLE /></GraphAnchors></DurableScope><ObservedWriteScope><File>${options.file ?? "src/example.ts"}</File></ObservedWriteScope><ImplementationPlan><T-001><Title>Apply change</Title><DependsOn></DependsOn><AcceptanceCriteria><Criterion>The change is complete.</Criterion></AcceptanceCriteria><Verification><Command>bun test</Command></Verification></T-001></ImplementationPlan></${changeId}></GraceChangePlan>`,
  );
}

function writeSpecOnly(root: string, changeId: string, status: "draft" | "approved") {
  writeProjectFile(
    root,
    `.grace/changes/active/${changeId}/spec.xml`,
    `<GraceChangeSpec graceVersion="4.0" status="${status}"><${changeId}><Summary>Spec only.</Summary><Goals><Goal>Plan later.</Goal></Goals><Constraints><Constraint>Preserve validity.</Constraint></Constraints><NonGoals><NonGoal>Unrelated work.</NonGoal></NonGoals><AcceptanceCriteria><Criterion>The spec is tracked.</Criterion></AcceptanceCriteria><AffectedAreas><M-EXAMPLE /></AffectedAreas><VerificationIntent><ExpectedCommand>bun test</ExpectedCommand></VerificationIntent></${changeId}></GraceChangeSpec>`,
  );
}

function runGit(root: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
}

describe("grace status", () => {
  it("summarizes durable GRACE 4 health and next action", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);

    const summaryOnly = await collectProjectStatus(root);
    const result = await collectProjectStatus(root, { includeModules: true });

    expect(summaryOnly.summary.readyModules).toBe(1);
    expect(summaryOnly.summary.attentionModules).toBe(0);
    expect(summaryOnly.summary.blockedModules).toBe(0);
    expect(summaryOnly.modules).toBeUndefined();
    expect(result.projectKind).toBe("grace4");
    expect(result.summary.contextArtifacts).toBe(5);
    expect(result.summary.graphModules).toBe(1);
    expect(result.summary.verificationEntries).toBe(1);
    expect(result.summary.readyModules).toBe(1);
    expect(result.modules).toHaveLength(1);
    expect(result.nextAction).toContain("$grace-spec");
    expect(result.observedDrift.available).toBe(false);
  });

  it("lists active and archived change bundles with statuses in JSON shape", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-ACTIVE", { specStatus: "approved", planStatus: "approved" });
    writeChange(root, "C-ARCHIVED", { location: "archive", specStatus: "applied", planStatus: "applied" });

    const result = await collectProjectStatus(root);

    expect(result.summary.activeChanges).toBe(1);
    expect(result.summary.archivedChanges).toBe(1);
    expect(result.changes.find((change) => change.changeId === "C-ACTIVE")?.planStatus).toBe("approved");
    expect(result.changes.find((change) => change.changeId === "C-ARCHIVED")?.specStatus).toBe("applied");
    expect(result.nextAction).toContain("grace-execute");
  });

  it("surfaces overlapping approved changes as derived state, not XML status", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-ONE", { specStatus: "approved", planStatus: "approved", file: "src/example.ts" });
    writeChange(root, "C-TWO", { specStatus: "approved", planStatus: "approved", file: "src/example.ts" });

    const result = await collectProjectStatus(root);
    const text = formatStatusText(result);

    expect(result.derivedStates).toContain("scope-overlap");
    expect(result.changes.every((change) => change.specStatus === "approved" && change.planStatus === "approved")).toBe(true);
    expect(text).toContain("scope-overlap");
  });

  it("reports invalid active/archive statuses from lint diagnostics", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-BAD-ACTIVE", { specStatus: "applied", planStatus: "applied" });

    const result = await collectProjectStatus(root);

    expect(result.changes.find((change) => change.changeId === "C-BAD-ACTIVE")?.derivedStates).toContain("invalid-active-status");
    expect(result.integrity.topIssues.some((issue) => issue.includes("change.invalid-active-status"))).toBe(true);
    expect(result.nextAction).toContain("grace lint");
  });

  it("recommends review or replan when the spec is approved but the plan is still draft", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-NEEDS-PLAN", { specStatus: "approved", planStatus: "draft" });

    const result = await collectProjectStatus(root);

    expect(result.changes.find((change) => change.changeId === "C-NEEDS-PLAN")?.derivedStates).toContain("needs-plan-approval");
    expect(result.nextAction).toContain("GraceChangePlan");
  });

  it("marks approved changes with failed baseline assertions as stale plans", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-STALE", {
      specStatus: "approved",
      planStatus: "approved",
      baselineAssertion: "<MustExist><Value>M-MISSING</Value></MustExist>",
    });

    const result = await collectProjectStatus(root);
    expect(result.changes.find((change) => change.changeId === "C-STALE")?.derivedStates).toContain("stale-plan");
    expect(result.changes.find((change) => change.changeId === "C-STALE")?.derivedStates).not.toContain("ready-to-execute");
    expect(result.derivedStates).toContain("stale-plan");
    expect(result.nextAction).toContain("Supersede and replan");
  });

  it("never marks an integrity-invalid approved plan ready to execute", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-INVALID", { specStatus: "approved", planStatus: "approved" });
    const planFile = ".grace/changes/active/C-INVALID/plan.xml";
    writeProjectFile(
      root,
      planFile,
      `<GraceChangePlan graceVersion="4.0" status="approved"><C-INVALID><IntentSummary>Invalid.</IntentSummary><BaselineAssertions><MustExist><Value>M-EXAMPLE</Value></MustExist></BaselineAssertions><TargetAssertions><MustVerify><Module>M-EXAMPLE</Module></MustVerify></TargetAssertions><DurableScope><GraphAnchors><M-EXAMPLE /></GraphAnchors></DurableScope><ObservedWriteScope><File>src/example.ts</File></ObservedWriteScope><ImplementationPlan><T-001><Title>Invalid task</Title><DependsOn></DependsOn><AcceptanceCriteria><Criterion>Never ready.</Criterion></AcceptanceCriteria><Verification /></T-001></ImplementationPlan></C-INVALID></GraceChangePlan>`,
    );

    const change = (await collectProjectStatus(root)).changes.find((entry) => entry.changeId === "C-INVALID")!;
    expect(change.derivedStates).toContain("integrity-issues");
    expect(change.derivedStates).not.toContain("ready-to-execute");
  });

  it("never marks text-only assertion and scope contracts ready to execute", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-TEXT", { specStatus: "approved", planStatus: "approved" });
    writeProjectFile(
      root,
      ".grace/changes/active/C-TEXT/plan.xml",
      `<GraceChangePlan graceVersion="4.0" status="approved"><C-TEXT><IntentSummary>Invalid text contracts.</IntentSummary><BaselineAssertions>assume state</BaselineAssertions><TargetAssertions>expect state</TargetAssertions><DurableScope>graph changes</DurableScope><ObservedWriteScope>source changes</ObservedWriteScope><ImplementationPlan><T-001><Title>Invalid task</Title><DependsOn></DependsOn><AcceptanceCriteria><Criterion>Never ready.</Criterion></AcceptanceCriteria><Verification><Command>true</Command></Verification></T-001></ImplementationPlan></C-TEXT></GraceChangePlan>`,
    );

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-TEXT")!;
    expect(result.integrity.errors).toBeGreaterThan(0);
    expect(change.derivedStates).toContain("integrity-issues");
    expect(change.derivedStates).not.toContain("ready-to-execute");
  });

  it("treats approved spec-only bundles as needing planning and draft spec-only bundles as normal drafts", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeSpecOnly(root, "C-APPROVED-SPEC", "approved");
    writeSpecOnly(root, "C-DRAFT-SPEC", "draft");

    const result = await collectProjectStatus(root);
    const approved = result.changes.find((change) => change.changeId === "C-APPROVED-SPEC")!;
    const draft = result.changes.find((change) => change.changeId === "C-DRAFT-SPEC")!;
    expect(approved.derivedStates).toContain("needs-plan");
    expect(approved.derivedStates).not.toContain("integrity-issues");
    expect(draft.derivedStates).toContain("draft-spec");
    expect(draft.derivedStates).not.toContain("integrity-issues");
  });

  it("distinguishes observed writes explained by approved scopes from unexplained git drift", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-DRIFT", { specStatus: "approved", planStatus: "approved", file: "src/example.ts" });
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    writeProjectFile(root, "src/example.ts", "// planned change\n");
    writeProjectFile(root, "unplanned.txt", "unexpected\n");

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.available).toBe(true);
    expect(result.observedDrift.explainedFiles).toContain("src/example.ts");
    expect(result.observedDrift.unexplainedFiles).toContain("unplanned.txt");
    expect(result.derivedStates).toContain("explained-observed-drift");
    expect(result.derivedStates).toContain("unexplained-observed-drift");
  });

  it("keeps both source and destination paths for git rename drift", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeProjectFile(root, "src/old.ts", "old\n");
    writeChange(root, "C-RENAME", { specStatus: "approved", planStatus: "approved", file: "src/new.ts" });
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    runGit(root, ["mv", "src/old.ts", "src/new.ts"]);

    const drift = (await collectProjectStatus(root)).observedDrift;
    expect(drift.changedFiles).toContain("src/old.ts");
    expect(drift.changedFiles).toContain("src/new.ts");
    expect(drift.explainedFiles).toContain("src/new.ts");
    expect(drift.unexplainedFiles).toContain("src/old.ts");
  });

  it("attributes graph drift only to the exact declared document or owning anchor route", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeProjectFile(root, ".grace/graph/index.xml", `<GraceGraphIndex graceVersion="4.0"><GraphDocuments><GD-MAIN><Path>graph/main.xml</Path><Owns><M-EXAMPLE /></Owns></GD-MAIN><GD-OTHER><Path>graph/other.xml</Path><Owns><M-OTHER /></Owns></GD-OTHER></GraphDocuments></GraceGraphIndex>`);
    writeProjectFile(root, ".grace/graph/other.xml", `<GraceGraphDocument graceVersion="4.0"><GD-OTHER><M-OTHER><Summary>Other.</Summary></M-OTHER></GD-OTHER></GraceGraphDocument>`);
    writeProjectFile(root, ".grace/verification/index.xml", `<GraceVerificationIndex graceVersion="4.0"><VerificationDocuments><VD-MAIN><Path>verification/main.xml</Path><Owns><V-M-EXAMPLE /></Owns></VD-MAIN><VD-OTHER><Path>verification/other.xml</Path><Owns><V-M-OTHER /></Owns></VD-OTHER></VerificationDocuments></GraceVerificationIndex>`);
    writeProjectFile(root, ".grace/verification/other.xml", `<GraceVerificationDocument graceVersion="4.0"><VD-OTHER><V-M-OTHER><Scenario>Other works.</Scenario></V-M-OTHER></VD-OTHER></GraceVerificationDocument>`);
    writeChange(root, "C-ROUTED-DRIFT", { specStatus: "approved", planStatus: "approved" });
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    writeProjectFile(root, ".grace/graph/main.xml", `<GraceGraphDocument graceVersion="4.0"><GD-MAIN><M-EXAMPLE><Summary>Changed main.</Summary></M-EXAMPLE></GD-MAIN></GraceGraphDocument>`);
    writeProjectFile(root, ".grace/graph/other.xml", `<GraceGraphDocument graceVersion="4.0"><GD-OTHER><M-OTHER><Summary>Changed other.</Summary></M-OTHER></GD-OTHER></GraceGraphDocument>`);

    const drift = (await collectProjectStatus(root)).observedDrift;
    expect(drift.explainedFiles).toContain(".grace/graph/main.xml");
    expect(drift.unexplainedFiles).toContain(".grace/graph/other.xml");
  });

  it("attributes graph index drift to declared graph documents or anchors", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-INDEX-DRIFT", { specStatus: "approved", planStatus: "approved" });
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    const indexFile = path.join(root, ".grace/graph/index.xml");
    writeFileSync(indexFile, readFileSync(indexFile, "utf8").replace("<GraphDocuments>", "<GraphDocuments>\n"));

    const drift = (await collectProjectStatus(root)).observedDrift;
    expect(drift.explainedFiles).toContain(".grace/graph/index.xml");
    expect(drift.unexplainedFiles).not.toContain(".grace/graph/index.xml");
  });

  it("hard-stops approved contract drift instead of reporting the bundle ready", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-IMMUTABLE", { specStatus: "approved", planStatus: "approved" });
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    const planFile = path.join(root, ".grace/changes/active/C-IMMUTABLE/plan.xml");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("<BaselineAssertions><MustExist><Value>M-EXAMPLE</Value></MustExist>", "<BaselineAssertions><MustExist><Value>src/example.ts</Value></MustExist>"));

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-IMMUTABLE")!;
    expect(result.observedDrift.unexplainedFiles).toContain(".grace/changes/active/C-IMMUTABLE/plan.xml");
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("ready-to-execute");
    expect(result.nextAction).toContain("Hard stop");
  });

  function initCommittedProject(changeId: string) {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, changeId, { specStatus: "approved", planStatus: "approved" });
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    return { root, planFile: path.join(root, `.grace/changes/active/${changeId}/plan.xml`) };
  }

  it("reports a scope-only widening as approved-scope-widening-pending, not drift", async () => {
    const { root, planFile } = initCommittedProject("C-WIDEN");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("<File>src/example.ts</File>", "<File>src/example.ts</File><File>src/extra.ts</File>"));

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-WIDEN")!;
    expect(result.observedDrift.explainedFiles).toContain(".grace/changes/active/C-WIDEN/plan.xml");
    expect(result.observedDrift.unexplainedFiles).not.toContain(".grace/changes/active/C-WIDEN/plan.xml");
    expect(result.derivedStates).toContain("approved-scope-widening-pending");
    expect(change.derivedStates).toContain("approved-scope-widening-pending");
    expect(result.derivedStates).not.toContain("approved-contract-drift");
    expect(result.derivedStates).not.toContain("unexplained-observed-drift");
    expect(result.nextAction).toBe("Commit the widening on its own, touching nothing outside .grace/, before writing the newly admitted files.");
  });

  it("keeps a narrowed scope as a hard stop", async () => {
    const { root, planFile } = initCommittedProject("C-NARROW");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("<File>src/example.ts</File>", "<None />"));

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-NARROW")!;
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("approved-scope-widening-pending");
    expect(result.observedDrift.unexplainedFiles).toContain(".grace/changes/active/C-NARROW/plan.xml");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("keeps a widening that also edits a gate section as a hard stop", async () => {
    const { root, planFile } = initCommittedProject("C-MIXED");
    writeFileSync(
      planFile,
      readFileSync(planFile, "utf8")
        .replace("<File>src/example.ts</File>", "<File>src/example.ts</File><File>src/extra.ts</File>")
        .replace("<GraphAnchors><M-EXAMPLE /></GraphAnchors>", "<GraphAnchors><M-EXAMPLE /><M-OTHER /></GraphAnchors>"),
    );

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-MIXED")!;
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("approved-scope-widening-pending");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("reports a task-only edit of an approved plan as approved-plan-amendment-pending, explained", async () => {
    const { root, planFile } = initCommittedProject("C-AMEND");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("<Title>Apply change</Title>", "<Title>Apply the amended change</Title>"));

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-AMEND")!;
    expect(result.observedDrift.explainedFiles).toContain(".grace/changes/active/C-AMEND/plan.xml");
    expect(result.observedDrift.unexplainedFiles).not.toContain(".grace/changes/active/C-AMEND/plan.xml");
    expect(change.derivedStates).toContain("approved-plan-amendment-pending");
    expect(change.derivedStates).not.toContain("approved-scope-widening-pending");
    expect(change.derivedStates).not.toContain("ready-to-execute");
    expect(result.derivedStates).toContain("approved-plan-amendment-pending");
    expect(result.derivedStates).not.toContain("approved-contract-drift");
    expect(result.derivedStates).not.toContain("unexplained-observed-drift");
    expect(result.nextAction).toBe("Commit the amendment on its own, touching nothing outside .grace/, with the user's agreement in its body.");
  });

  it("reports an IntentSummary-only edit as approved-plan-amendment-pending", async () => {
    const { root, planFile } = initCommittedProject("C-INTENT");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("<IntentSummary>Apply the change.</IntentSummary>", "<IntentSummary>Apply the amended change.</IntentSummary>"));

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-INTENT")!;
    expect(change.derivedStates).toContain("approved-plan-amendment-pending");
    expect(result.nextAction).toBe("Commit the amendment on its own, touching nothing outside .grace/, with the user's agreement in its body.");
  });

  it("a TargetAssertions edit stays approved-contract-drift", async () => {
    const { root, planFile } = initCommittedProject("C-TARGET");
    writeFileSync(
      planFile,
      readFileSync(planFile, "utf8").replace(
        "<TargetAssertions><MustVerify><Module>M-EXAMPLE</Module></MustVerify></TargetAssertions>",
        "<TargetAssertions><MustVerify><Module>M-EXAMPLE</Module></MustVerify><MustExist><Value>M-EXAMPLE</Value></MustExist></TargetAssertions>",
      ),
    );

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-TARGET")!;
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("approved-plan-amendment-pending");
    expect(result.observedDrift.unexplainedFiles).toContain(".grace/changes/active/C-TARGET/plan.xml");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("gate sections nested inside IntentSummary stay approved-contract-drift", async () => {
    const { root, planFile } = initCommittedProject("C-NESTED");
    writeFileSync(
      planFile,
      readFileSync(planFile, "utf8").replace(
        "<IntentSummary>Apply the change.</IntentSummary>",
        "<IntentSummary>Apply the change.<DurableScope><GraphAnchors><M-OTHER /></GraphAnchors></DurableScope><TargetAssertions><MustPassCommand>bun test</MustPassCommand></TargetAssertions></IntentSummary>",
      ),
    );

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-NESTED")!;
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("approved-plan-amendment-pending");
    expect(result.observedDrift.unexplainedFiles).toContain(".grace/changes/active/C-NESTED/plan.xml");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("a widening plus a task edit is amendment-pending", async () => {
    const { root, planFile } = initCommittedProject("C-WIDEN-AMEND");
    writeFileSync(
      planFile,
      readFileSync(planFile, "utf8")
        .replace("<File>src/example.ts</File>", "<File>src/example.ts</File><File>src/extra.ts</File>")
        .replace("<Title>Apply change</Title>", "<Title>Apply the amended change</Title>"),
    );

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-WIDEN-AMEND")!;
    expect(result.observedDrift.explainedFiles).toContain(".grace/changes/active/C-WIDEN-AMEND/plan.xml");
    expect(change.derivedStates).toContain("approved-plan-amendment-pending");
    expect(change.derivedStates).not.toContain("approved-scope-widening-pending");
    expect(change.derivedStates).not.toContain("approved-contract-drift");
    expect(result.nextAction).toBe("Commit the amendment on its own, touching nothing outside .grace/, with the user's agreement in its body.");
  });

  it("a narrowed scope plus a task edit stays a hard stop", async () => {
    const { root, planFile } = initCommittedProject("C-NARROW-AMEND");
    writeFileSync(
      planFile,
      readFileSync(planFile, "utf8")
        .replace("<File>src/example.ts</File>", "<None />")
        .replace("<Title>Apply change</Title>", "<Title>Apply the amended change</Title>"),
    );

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-NARROW-AMEND")!;
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("approved-plan-amendment-pending");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("keeps a widening that also changes spec.xml as a hard stop", async () => {
    const { root, planFile } = initCommittedProject("C-SPEC");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("<File>src/example.ts</File>", "<File>src/example.ts</File><File>src/extra.ts</File>"));
    const specFile = path.join(root, ".grace/changes/active/C-SPEC/spec.xml");
    writeFileSync(specFile, readFileSync(specFile, "utf8").replace("<Summary>Change.</Summary>", "<Summary>Changed.</Summary>"));

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-SPEC")!;
    expect(change.derivedStates).toContain("approved-contract-drift");
    expect(change.derivedStates).not.toContain("approved-scope-widening-pending");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("does not confuse a newly created untracked approved bundle with post-approval contract drift", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test: baseline"]);
    writeChange(root, "C-NEW", { specStatus: "approved", planStatus: "approved" });

    const result = await collectProjectStatus(root);
    const change = result.changes.find((entry) => entry.changeId === "C-NEW")!;
    expect(result.observedDrift.explainedFiles).toContain(".grace/changes/active/C-NEW/plan.xml");
    expect(change.derivedStates).toContain("ready-to-execute");
    expect(change.derivedStates).not.toContain("approved-contract-drift");
  });

  it("reports invalid projections through integrity without crashing or producing healthy module counts", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeProjectFile(root, ".grace/graph/main.xml", `<GraceRequirements graceVersion="4.0"><GD-MAIN /></GraceRequirements>`);

    const result = await collectProjectStatus(root, { includeModules: true });
    expect(result.integrity.errors).toBeGreaterThan(0);
    expect(result.integrity.topIssues.some((entry) => entry.includes("artifact.unexpected-root-tag"))).toBe(true);
    expect(result.summary.readyModules).toBe(0);
    expect(result.moduleHealthLoadError).toContain("GRACE artifacts are invalid");
  });

  it("reports GRACE 3 projects as migration candidates without loading docs as healthy", async () => {
    const root = createProject();
    writeProjectFile(root, "docs/development-plan.xml", `<DevelopmentPlan />`);

    const result = await collectProjectStatus(root);

    expect(result.projectKind).toBe("grace3");
    expect(result.derivedStates).toContain("migration-candidate");
    expect(result.summary.graphModules).toBe(0);
    expect(result.nextAction).toContain("grace-migrate");
  });

  it("wires the status command through the CLI", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    const repoRoot = path.resolve(import.meta.dir, "..");

    const statusResult = Bun.spawnSync({
      cmd: [process.execPath, "./src/grace.ts", "status", "--path", root, "--json", "--fail-on", "never"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(statusResult.exitCode).toBe(0);
    const parsed = JSON.parse(Buffer.from(statusResult.stdout).toString("utf8"));
    expect(parsed.tool).toBe("grace-status");
    expect(parsed.summary.graphModules).toBe(1);
  });

  it("reports module-health-unavailable and defers execution when the artifact index fails to load", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-READY", { specStatus: "approved", planStatus: "approved" });

    const healthy = await collectProjectStatus(root, { includeModules: true });
    expect(healthy.moduleHealthLoadError).toBeUndefined();
    expect(healthy.nextAction).toContain("$grace-execute");

    const result = await collectProjectStatus(root, {
      includeModules: true,
      loadArtifactIndex: () => {
        throw new GraceCommandError("invalid-project", "GRACE artifacts are invalid; no navigation records were returned. Run `grace lint --path PROJECT` for details.", { issues: ["assertion.phase-incompatible-command"] });
      },
    });

    expect(result.moduleHealthLoadError).toContain("GRACE artifacts are invalid");
    expect(result.derivedStates).toContain("module-health-unavailable");
    expect(result.summary.readyModules).toBe(0);
    expect(result.modules).toBeUndefined();
    expect(result.nextAction).toContain("grace lint");
    expect(result.nextAction).not.toContain("$grace-execute");
  });

  it("returns structured JSON for invalid options and missing paths without stack traces", async () => {
    const repoRoot = path.resolve(import.meta.dir, "..");
    const invalid = Bun.spawnSync({
      cmd: [process.execPath, "./src/grace.ts", "status", "--json", "--fail-on", "unsupported"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(Buffer.from(invalid.stderr).toString("utf8")).toBe("");
    expect(JSON.parse(Buffer.from(invalid.stdout).toString("utf8"))).toEqual(expect.objectContaining({
      schemaVersion: "1.0.0",
      ok: false,
      error: expect.objectContaining({ code: "invalid-arguments" }),
    }));

    const missingRoot = path.join(os.tmpdir(), `grace-status-missing-${crypto.randomUUID()}`);
    const missing = Bun.spawnSync({
      cmd: [process.execPath, "./src/grace.ts", "status", "--path", missingRoot, "--json"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(0);
    expect(Buffer.from(missing.stderr).toString("utf8")).toBe("");
    expect(JSON.parse(Buffer.from(missing.stdout).toString("utf8")).projectKind).toBe("none");
  });

  it("prints the Scenario evidence section and caps unproven at 20", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    const unproven = Array.from({ length: 25 }, (_, index) => `<Scenario><SC-EXAMPLE-${String(index + 10).padStart(3, "0")} />Unproven ${index + 10}.</Scenario>`).join("");
    writeProjectFile(
      root,
      ".grace/verification/main.xml",
      `<GraceVerificationDocument graceVersion="4.0"><VD-MAIN><V-M-EXAMPLE><Command>bun test src/example.test.ts</Command><Scenario><SC-EXAMPLE-001 />Proven.</Scenario><Scenario><SC-EXAMPLE-002 />Bench.<ManualEvidence>Bench check.</ManualEvidence></Scenario><Scenario>example works</Scenario>${unproven}<Marker>[Example][run][BLOCK_RUN]</Marker></V-M-EXAMPLE></VD-MAIN></GraceVerificationDocument>`,
    );
    writeProjectFile(root, "tests/boot.test.ts", "// SC-EXAMPLE-001\n");

    const result = await collectProjectStatus(root);
    expect(result.integrity.errors).toBe(0);
    expect(result.scenarioEvidence?.totals).toEqual({ scenarios: 28, executable: 1, manualOnly: 1, unproven: 25, legacy: 1 });
    expect(result.scenarioEvidence?.entries.map((entry) => entry.id)).toEqual(["V-M-EXAMPLE"]);
    expect(result.scenarioEvidence?.entries[0]?.scenarios[1]).toEqual({ id: "SC-EXAMPLE-002", text: "Bench.", manualEvidence: "Bench check.", state: "manualOnly" });

    const text = formatStatusText(result);
    expect(text).toContain("Scenario Evidence\n- Scenarios: 28 (executable 1, manual only 1, unproven 25, legacy 1)");
    const unprovenLines = text.split("\n").filter((line) => line.startsWith("- unproven: "));
    expect(unprovenLines).toHaveLength(20);
    expect(unprovenLines[0]).toBe("- unproven: SC-EXAMPLE-010 (V-M-EXAMPLE) Unproven 10.");
    expect(text).toContain("- ... 5 more unproven");
    expect(text.indexOf("Scenario Evidence")).toBeLessThan(text.indexOf("Suggested Next Action"));
  });

  function initGit(root: string) {
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "grace@example.test"]);
    runGit(root, ["config", "user.name", "GRACE Test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    runGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
  }

  function commitAll(root: string, message: string) {
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", message]);
  }

  function writeDesignContext(root: string, changeId: string) {
    writeProjectFile(
      root,
      `.grace/changes/active/${changeId}/design-context.xml`,
      `<GraceChangeDesignContext graceVersion="4.0"><Change>${changeId}</Change><Rationale>Initial.</Rationale></GraceChangeDesignContext>`,
    );
  }

  function editFile(root: string, relativePath: string, from: string, to: string) {
    const file = path.join(root, relativePath);
    const before = readFileSync(file, "utf8");
    if (!before.includes(from)) throw new Error(`fixture edit missed: ${from}`);
    writeFileSync(file, before.replace(from, to));
  }

  it("derives awaiting-approval for a draft pair", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-PAIR", { specStatus: "draft", planStatus: "draft" });

    const result = await collectProjectStatus(root);
    const states = result.changes.find((change) => change.changeId === "C-PAIR")!.derivedStates;
    expect(states).toContain("awaiting-approval");
    expect(states).not.toContain("integrity-issues");
    expect(states).not.toContain("draft-spec");
    expect(states).not.toContain("needs-plan-approval");
    expect(states).not.toContain("ready-to-execute");
  });

  it("names the audit and the owner's approval as the next action of a draft pair", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-PAIR", { specStatus: "draft", planStatus: "draft" });

    const result = await collectProjectStatus(root);
    expect(result.nextAction).toContain("--assertions baseline");
    expect(result.nextAction).toContain("--change C-PAIR");
    expect(result.nextAction).toContain("--draft");
    expect(result.nextAction).toContain("$grace-brief");
    expect(result.nextAction).toContain("approval of spec and plan together");
  });

  it("names grace-plan as the next action of a draft spec", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeSpecOnly(root, "C-DRAFT", "draft");

    const result = await collectProjectStatus(root);
    expect(result.nextAction).toContain("$grace-plan");
  });

  it("names the audit in the needs-plan-approval next action and keeps GraceChangePlan", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-NEEDS-PLAN", { specStatus: "approved", planStatus: "draft" });

    const result = await collectProjectStatus(root);
    expect(result.nextAction).toContain("$grace-brief");
    expect(result.nextAction).toContain("GraceChangePlan");
  });

  it("names the owner's execution order in the ready-to-execute next action", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-READY", { specStatus: "approved", planStatus: "approved" });

    const result = await collectProjectStatus(root);
    expect(result.nextAction).toContain("execution order");
    expect(result.nextAction).toContain("$grace-execute");
  });

  it("explains uncommitted edits of a committed draft pair", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-DRAFTS", { specStatus: "draft", planStatus: "draft" });
    writeDesignContext(root, "C-DRAFTS");
    initGit(root);
    commitAll(root, "test: draft pair");
    const bundle = ".grace/changes/active/C-DRAFTS";
    editFile(root, `${bundle}/plan.xml`, "<IntentSummary>Apply the change.</IntentSummary>", "<IntentSummary>Apply the edited change.</IntentSummary>");
    editFile(root, `${bundle}/spec.xml`, "<Summary>Change.</Summary>", "<Summary>Edited change.</Summary>");
    editFile(root, `${bundle}/design-context.xml`, "Initial.", "Edited.");

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.changedFiles).toEqual([`${bundle}/design-context.xml`, `${bundle}/plan.xml`, `${bundle}/spec.xml`]);
    expect(result.observedDrift.unexplainedFiles).toEqual([]);
    expect(result.derivedStates).not.toContain("unexplained-observed-drift");
    expect(result.changes.find((change) => change.changeId === "C-DRAFTS")!.derivedStates).toContain("awaiting-approval");
    expect(result.nextAction).not.toContain("grace-refresh");
    expect(result.nextAction).toContain("$grace-brief");
  });

  it("explains uncommitted edits of a committed draft spec", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeSpecOnly(root, "C-DRAFT", "draft");
    initGit(root);
    commitAll(root, "test: draft spec");
    editFile(root, ".grace/changes/active/C-DRAFT/spec.xml", "<Summary>Spec only.</Summary>", "<Summary>Edited spec.</Summary>");

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.unexplainedFiles).toEqual([]);
    expect(result.nextAction).toContain("$grace-plan");
  });

  it("explains an untracked draft bundle", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    initGit(root);
    commitAll(root, "test: baseline");
    writeChange(root, "C-FRESH", { specStatus: "draft", planStatus: "draft" });
    writeDesignContext(root, "C-FRESH");

    const result = await collectProjectStatus(root);
    const bundle = ".grace/changes/active/C-FRESH";
    expect(result.observedDrift.explainedFiles).toEqual([`${bundle}/design-context.xml`, `${bundle}/plan.xml`, `${bundle}/spec.xml`]);
    expect(result.observedDrift.unexplainedFiles).toEqual([]);
    expect(result.nextAction).not.toContain("grace-refresh");
  });

  it("explains an untracked draft bundle in a repository without commits", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    initGit(root);
    writeChange(root, "C-FRESH", { specStatus: "draft", planStatus: "draft" });

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.explainedFiles).toContain(".grace/changes/active/C-FRESH/plan.xml");
    expect(result.observedDrift.explainedFiles).toContain(".grace/changes/active/C-FRESH/spec.xml");
  });

  it("does not explain an artifact approved in HEAD by the draft rule", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-APPROVED", { specStatus: "approved", planStatus: "approved" });
    initGit(root);
    commitAll(root, "test: approved pair");
    const bundle = ".grace/changes/active/C-APPROVED";
    editFile(root, `${bundle}/plan.xml`, "<MustExist><Value>M-EXAMPLE</Value></MustExist>", "<MustExist><Value>src/example.ts</Value></MustExist>");

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.unexplainedFiles).toContain(`${bundle}/plan.xml`);
    expect(result.changes.find((change) => change.changeId === "C-APPROVED")!.derivedStates).toContain("approved-contract-drift");
    expect(result.nextAction).toContain("Hard stop");
  });

  it("does not explain a plan returned to draft with content edits when HEAD approves it", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-RETURN", { specStatus: "approved", planStatus: "approved" });
    initGit(root);
    commitAll(root, "test: approved pair");
    const bundle = ".grace/changes/active/C-RETURN";
    editFile(root, `${bundle}/plan.xml`, 'status="approved"', 'status="draft"');
    editFile(root, `${bundle}/plan.xml`, "<MustExist><Value>M-EXAMPLE</Value></MustExist>", "<MustExist><Value>src/example.ts</Value></MustExist>");

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.unexplainedFiles).toContain(`${bundle}/plan.xml`);
  });

  it("does not explain a draft design-context while HEAD approves the plan", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-DC", { specStatus: "approved", planStatus: "approved" });
    writeDesignContext(root, "C-DC");
    initGit(root);
    commitAll(root, "test: approved pair");
    const bundle = ".grace/changes/active/C-DC";
    editFile(root, `${bundle}/spec.xml`, 'status="approved"', 'status="draft"');
    editFile(root, `${bundle}/plan.xml`, 'status="approved"', 'status="draft"');
    editFile(root, `${bundle}/design-context.xml`, "Initial.", "Edited.");

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.unexplainedFiles).toContain(`${bundle}/design-context.xml`);
    expect(result.observedDrift.unexplainedFiles).toContain(`${bundle}/spec.xml`);
    expect(result.observedDrift.unexplainedFiles).toContain(`${bundle}/plan.xml`);
  });

  it("derives awaiting-approval for a draft pair outside git", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeChange(root, "C-NOGIT", { specStatus: "draft", planStatus: "draft" });

    const result = await collectProjectStatus(root);
    expect(result.observedDrift.available).toBe(false);
    expect(result.changes.find((change) => change.changeId === "C-NOGIT")!.derivedStates).toContain("awaiting-approval");
  });
});
