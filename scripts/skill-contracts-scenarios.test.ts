import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function blockBetween(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("GRACE scenario evidence skill contracts", () => {
  it("documents scenario ids and their accepted token form", () => {
    const skill = read("skills/grace/grace-verification/SKILL.md");

    const evidenceEnd = skill.indexOf("</evidence_contract>");
    const blockStart = skill.indexOf("<scenario_ids>");
    const blockEnd = skill.indexOf("</scenario_ids>");
    const gateStart = skill.indexOf("<gate_task_contract>");
    expect(evidenceEnd).toBeGreaterThan(-1);
    expect(blockStart).toBeGreaterThan(evidenceEnd);
    expect(skill.slice(evidenceEnd + "</evidence_contract>".length, blockStart).trim()).toBe("");
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(gateStart).toBeGreaterThan(blockEnd);

    const block = skill.slice(blockStart, blockEnd);
    for (const required of [
      "SC-<entry>-NNN",
      "V-M-",
      "<ManualEvidence>",
      "<TestFiles>",
      "<!--SC-FW-MAIN-002-->",
      "SC-FW-MAIN-002-boot",
      "`-`, `_` and `.`",
    ]) {
      expect(block).toContain(required);
    }
    expect(block).toContain("Leave");
  });

  it("reviews scenario evidence", () => {
    const skill = read("skills/grace/grace-reviewer/SKILL.md");
    const checklist = blockBetween(skill, "<review_checklist>", "</review_checklist>");
    const items = checklist.split("\n").filter((line) => line.startsWith("- "));

    const scenarioIndex = items.findIndex((item) => item.includes("SC-"));
    expect(scenarioIndex).toBeGreaterThan(0);
    expect(items[scenarioIndex - 1]!.startsWith("- `.grace/graph/index.xml` routes every graph anchor")).toBe(true);
    const scenario = items[scenarioIndex]!;
    expect(scenario).toContain("SC-<entry>-NNN");
    expect(scenario).toContain("`executable`");
    expect(scenario).toContain("`manualOnly`");
    expect(scenario).toContain("`grace status --json` `scenarioEvidence`");
    expect(scenario).toContain("<Command>");
  });

  it("documents the status section and three codes", () => {
    const skill = read("skills/grace/grace-cli/SKILL.md");

    const runtimeEnd = skill.indexOf("</runtime_contract>");
    const blockStart = skill.indexOf("<scenario_evidence_contract>");
    const blockEnd = skill.indexOf("</scenario_evidence_contract>");
    const migrationStart = skill.indexOf("<migration_boundary>");
    expect(runtimeEnd).toBeGreaterThan(-1);
    expect(blockStart).toBeGreaterThan(runtimeEnd);
    expect(skill.slice(runtimeEnd + "</runtime_contract>".length, blockStart).trim()).toBe("");
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(migrationStart).toBeGreaterThan(blockEnd);

    const block = skill.slice(blockStart, blockEnd);
    for (const required of [
      "Scenario Evidence",
      "scenarioEvidence",
      "`scenarios`",
      "`executable`",
      "`manualOnly`",
      "`unproven`",
      "`legacy`",
      "verification.scenario-duplicate-id",
      "verification.scenario-invalid-id",
      "verification.scenario-dangling-reference",
    ]) {
      expect(block).toContain(required);
    }
    expect(block).toContain("Scanned files are the code-extension files outside ignored directories plus the files in every entry's `<TestFiles>`");
    expect(block).not.toContain("resolve each by");
  });

  it("explainer documents the SC- id and ManualEvidence", () => {
    const doc = read("skills/grace/grace-explainer/references/verification-driven-dev.md");

    const fields = blockBetween(doc, "Each `V-M-*` entry may contain:", "## Module Verification Entry");
    const scenarioItem = fields.split("\n").find((line) => line.startsWith("- `<Scenario>`"));
    expect(scenarioItem).toBeDefined();
    expect(scenarioItem).toContain("SC-<entry>-NNN");
    expect(scenarioItem).toContain("<ManualEvidence>");

    const example = blockBetween(doc, "## Module Verification Entry", "## Log-Driven Development");
    expect(example).toMatch(/<Scenario><SC-CHATS-001 \/>/);
    const manual = example.split("\n").filter((line) => line.includes("<ManualEvidence>"));
    expect(manual).toHaveLength(1);
    expect(manual[0]).toContain("physical phone");
    expect(example.split("\n").find((line) => line.includes("<SC-CHATS-001 />"))).not.toContain("<ManualEvidence>");
  });

  it("keeps the packaged skills identical to the canonical copies", () => {
    for (const file of [
      "grace-verification/SKILL.md",
      "grace-reviewer/SKILL.md",
      "grace-cli/SKILL.md",
      "grace-explainer/references/verification-driven-dev.md",
    ]) {
      expect(read(`plugins/grace/skills/grace/${file}`)).toBe(read(`skills/grace/${file}`));
    }
  });
});
