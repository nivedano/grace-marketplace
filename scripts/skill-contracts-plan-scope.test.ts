import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("grace-plan observed scope derivation contract", () => {
  it("requires deriving observed scope from related files", () => {
    const plan = read("skills/grace/grace-plan/SKILL.md");

    expect(plan).toContain("<observed_scope_derivation>");
    expect(plan).toContain("</observed_scope_derivation>");
    for (const category of ["tests", "test doubles", "re-export", "wire"]) {
      expect(plan).toContain(category);
    }
    expect(plan).toContain("one-line reason");

    const phaseRulesEnd = plan.indexOf("</command_phase_rules>");
    const blockStart = plan.indexOf("<observed_scope_derivation>");
    const blockEnd = plan.indexOf("</observed_scope_derivation>");
    const validationStart = plan.indexOf("<validation>");
    expect(phaseRulesEnd).toBeGreaterThan(-1);
    expect(blockStart).toBeGreaterThan(phaseRulesEnd);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(validationStart).toBeGreaterThan(blockEnd);
  });

  it("keeps the packaged grace-plan skill identical to the canonical copy", () => {
    expect(read("plugins/grace/skills/grace/grace-plan/SKILL.md")).toBe(read("skills/grace/grace-plan/SKILL.md"));
  });
});
