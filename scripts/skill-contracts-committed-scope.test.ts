import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const WIDENING_FORMULA =
  "Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`.";

const AMENDMENT_FORMULA =
  "Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them.";

const SKILL_FILES = [
  "skills/grace/grace-execute/SKILL.md",
  "skills/grace/grace-plan/SKILL.md",
  "skills/grace/grace-reviewer/SKILL.md",
  "skills/grace/grace-cli/SKILL.md",
  "skills/grace/grace-explainer/references/contract-driven-dev.md",
];

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/** Text from the first start marker to the first end marker after it; fails when either is missing. */
function slice(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to + end.length);
}

describe("committed-scope skill contracts", () => {
  it("states the ObservedWriteScope exception wherever plans are immutable", () => {
    const execute = read("skills/grace/grace-execute/SKILL.md");
    const plan = read("skills/grace/grace-plan/SKILL.md");
    const explainer = read("skills/grace/grace-explainer/references/contract-driven-dev.md");

    const preflight = slice(execute, "<preflight>", "</preflight>");
    const modeSelection = slice(execute, "<mode_selection>", "</mode_selection>");
    const rule8 = slice(execute, "\n8. ", "</execution_rules>");
    const immutability = slice(plan, "<approved_plan_immutability>", "</approved_plan_immutability>");
    const explainerParagraph = slice(explainer, "Approved plans are immutable", "\n\n");

    for (const statement of [preflight, modeSelection, rule8, immutability, explainerParagraph]) {
      expect(statement).toContain(WIDENING_FORMULA);
    }

    expect(preflight).toContain("Approved plans are immutable.");
    expect(modeSelection).toContain("Workers never mutate approved plans");
    expect(rule8).toContain("Never edit approved assertions");

    const refreshList = immutability.split("\n").find((line) => line.startsWith("- Do not refresh"));
    expect(refreshList).toBeDefined();
    expect(refreshList).not.toContain("ObservedWriteScope");
    expect(refreshList).toContain("DurableScope");
    expect(immutability).toContain("grace-execute");
    expect(immutability).toContain("Create a new `C-*` bundle");
    expect(immutability).toContain("mark the old bundle superseded");
    expect(plan).toContain("Create a new `C-*` bundle");
    expect(plan).toContain("mark the old bundle superseded");
  });

  it("defines scope widening and commit trailers in grace-execute", () => {
    const execute = read("skills/grace/grace-execute/SKILL.md");

    const afterModes = execute.indexOf("</mode_selection>");
    const widening = execute.indexOf("<scope_widening>");
    const wideningEnd = execute.indexOf("</scope_widening>");
    const contract = execute.indexOf("<commit_contract>");
    const contractEnd = execute.indexOf("</commit_contract>");
    const recovery = execute.indexOf("<recovery_decision_table>");
    expect(afterModes).toBeGreaterThan(0);
    expect(widening).toBeGreaterThan(afterModes);
    expect(wideningEnd).toBeGreaterThan(widening);
    expect(contract).toBeGreaterThan(wideningEnd);
    expect(contractEnd).toBeGreaterThan(contract);
    expect(recovery).toBeGreaterThan(contractEnd);

    const wideningBlock = slice(execute, "<scope_widening>", "</scope_widening>");
    expect(wideningBlock).toContain("touches only `.grace/`");
    expect(wideningBlock).toContain("ObservedWriteScope");
    expect(wideningBlock).toContain("DurableScope");
    expect(wideningBlock).toContain("superseding bundle");

    const commitBlock = slice(execute, "<commit_contract>", "</commit_contract>");
    expect(commitBlock).toContain("`Change: <C-ID>`");
    expect(commitBlock).toContain("same final paragraph as `Co-Authored-By`");
    expect(commitBlock).toContain("grace status");
    expect(commitBlock).toContain(
      "Commit the approved `plan.xml` in or before the first commit that writes outside `.grace/`.",
    );
    expect(commitBlock).toContain("stop and report unexplained files");
    expect(commitBlock).not.toContain("resolve unexplained files");
    expect(wideningBlock).toContain("only after that commit");

    expect(execute).not.toContain("scope_discipline");
  });

  it("reviews far widenings and re-approval additions", () => {
    const reviewer = read("skills/grace/grace-reviewer/SKILL.md");

    expect(reviewer.indexOf("<skill>\n<scope_widening_review>")).toBeGreaterThan(0);
    const block = slice(reviewer, "<scope_widening_review>", "</scope_widening_review>");
    expect(block).toContain("committedScope");
    expect(block).toContain("far");
    expect(block).toContain("ObservedWriteScope");
    expect(block).toContain("archive commit body");
    expect(block).not.toContain("archive record");
    expect(block).not.toContain("verdict");
    expect(reviewer.indexOf("<scope_widening_review>")).toBeLessThan(reviewer.indexOf("<review_checklist>"));
  });

  it("documents the committed-scope codes and config", () => {
    const cli = read("skills/grace/grace-cli/SKILL.md");

    expect(cli.indexOf("</failure_contract>\n\n<committed_scope_contract>")).toBeGreaterThan(0);
    const block = slice(cli, "<committed_scope_contract>", "</committed_scope_contract>");
    expect(block).toContain("committedScope");
    expect(block).toContain("requireChangeTrailers");
    expect(block).toContain("approved-scope-widening-pending");
    expect(block).toContain(WIDENING_FORMULA);
    expect(block).toContain("Write the admitted files only after that commit.");
    expect(block).toContain("committed as `approved`");
    expect(block).toContain("scope.written-before-approval");
    expect(block).toContain("first commit that contains `spec.xml` or `plan.xml`");
    expect(block).toContain("without an effective `Change` trailer");
    expect(block).toContain("merge commit");
    expect(block).not.toContain("since the plan's first commit");
    for (const code of [
      "scope.committed-outside",
      "scope.widening-with-code",
      "scope.written-before-widening",
      "scope.written-before-approval",
      "scope.approved-plan-mutated",
      "scope.approval-uncommitted",
      "scope.no-owned-commits",
      "scope.reapproval-widened",
      "scope.widened-far",
      "scope.untagged-commit",
      "scope.committed-check-skipped",
      "scope.approved-plan-amended",
    ]) {
      expect(block).toContain(code);
    }
    expect(block.match(/scope\.[a-z-]+/g)?.filter((code, index, all) => all.indexOf(code) === index)).toHaveLength(12);
  });

  it("states the amendment formula wherever the widening formula appears", () => {
    const execute = read("skills/grace/grace-execute/SKILL.md");
    const plan = read("skills/grace/grace-plan/SKILL.md");
    const cli = read("skills/grace/grace-cli/SKILL.md");
    const explainer = read("skills/grace/grace-explainer/references/contract-driven-dev.md");

    const statements = [
      slice(execute, "<preflight>", "</preflight>"),
      slice(execute, "<mode_selection>", "</mode_selection>"),
      slice(execute, "<scope_widening>", "</scope_widening>"),
      slice(execute, "\n8. ", "</execution_rules>"),
      slice(plan, "<approved_plan_immutability>", "</approved_plan_immutability>"),
      slice(cli, "<committed_scope_contract>", "</committed_scope_contract>"),
      slice(explainer, "Approved plans are immutable", "\n\n"),
    ];
    for (const statement of statements) {
      expect(statement).toContain(WIDENING_FORMULA);
      expect(statement).toContain(AMENDMENT_FORMULA);
      const gap = statement.indexOf(AMENDMENT_FORMULA) - (statement.indexOf(WIDENING_FORMULA) + WIDENING_FORMULA.length);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(120);
    }

    const wideningBlock = statements[2]!;
    const supersede = wideningBlock.split("\n").find((line) => line.includes("superseding bundle"));
    expect(supersede).toContain("`BaselineAssertions`, `TargetAssertions` and `DurableScope`");
    expect(supersede).not.toContain("tasks");

    const immutability = statements[4]!;
    const refreshList = immutability.split("\n").find((line) => line.startsWith("- Do not refresh"));
    expect(refreshList).toContain("DurableScope");
    expect(refreshList).not.toContain("ObservedWriteScope");
    expect(refreshList).not.toContain("tasks");
    expect(immutability).toContain("Create a new `C-*` bundle");
    expect(immutability).toContain("mark the old bundle superseded");

    const rule8 = statements[3]!;
    expect(rule8).toContain("Never edit approved assertions");
    expect(rule8).not.toContain("or tasks in place");
  });

  it("reviews amendments", () => {
    const reviewer = read("skills/grace/grace-reviewer/SKILL.md");
    const block = slice(reviewer, "<scope_widening_review>", "</scope_widening_review>");
    const line = block.split("\n").find((entry) => entry.includes("`amendments`"));
    expect(line).toBeDefined();
    expect(line).toContain("archive commit body");
    expect(line).toContain("finding");
    expect(line).toContain("who asked, who agreed, why the plan changed");
  });

  it("documents the twelfth code, the amendment state and committedScopeExempt", () => {
    const cli = read("skills/grace/grace-cli/SKILL.md");
    const block = slice(cli, "<committed_scope_contract>", "</committed_scope_contract>");
    const warnings = block.slice(block.indexOf("Warnings:"));
    expect(warnings).toContain("- `scope.approved-plan-amended`");
    expect(warnings).toContain("`ImplementationPlan`");
    expect(warnings).toContain("`IntentSummary`");
    expect(block).toContain("`scope.approved-plan-mutated`: an approved plan changed outside `ObservedWriteScope`");
    expect(block).toContain("`BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope`");
    expect(block).toContain("approved-plan-amendment-pending");
    expect(block).toContain(
      "Commit the amendment on its own, touching nothing outside .grace/, with the user's agreement in its body.",
    );
    expect(block).toContain("approved-scope-widening-pending");
    expect(block).toContain("approved-contract-drift");
    expect(block).toContain("committedScopeExempt");
    expect(block).toContain("`ObservedWriteScope` glob grammar");
    expect(block).toContain("`exempt`");
    expect(block).toContain("config.invalid-committed-scope-exempt");
  });

  it("keeps the packaged mirrors identical and free of private tooling names", () => {
    for (const file of SKILL_FILES) {
      const canonical = read(file);
      expect(read(file.replace("skills/grace/", "plugins/grace/skills/grace/"))).toBe(canonical);
      for (const forbidden of ["sysops", "graceopt"]) {
        expect(canonical.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});
