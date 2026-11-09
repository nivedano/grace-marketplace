import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const ARCHIVE_SENTENCE = "runs the committed-scope check and refuses on its error-severity issues";

const REVIEWER_SENTENCE = "Read `committedScope` from the final `grace lint` output or the `grace archive` output";

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

describe("archive committed-scope skill contracts", () => {
  for (const root of ["skills/grace", "plugins/grace/skills/grace"]) {
    it(`grace-cli states that grace archive runs the committed-scope check (${root})`, () => {
      const archive = slice(read(`${root}/grace-cli/SKILL.md`), "<archive_contract>", "</archive_contract>");
      expect(archive).toContain(ARCHIVE_SENTENCE);
      expect(archive).toContain("`committedScope`");
      expect(archive).toContain("warnings never refuse");
      expect(archive).toContain("the filesystem rename happens only outside a git worktree or in a shallow clone");
    });

    it(`grace-reviewer reads the report from lint or archive output (${root})`, () => {
      const review = slice(read(`${root}/grace-reviewer/SKILL.md`), "<scope_widening_review>", "</scope_widening_review>");
      expect(review).toContain(REVIEWER_SENTENCE);
      const lines = review.split("\n");
      const none = lines.find((line) => line.startsWith("- State that there were none"));
      expect(none).toContain("`ownedCommits` is above 0, `skipped` is unset");
      const nothing = lines.find((line) => line.startsWith("- State that nothing was classified"));
      expect(nothing).toContain("`ownedCommits` is 0 or `skipped` is set");
      expect(nothing).toContain("`scope.no-owned-commits`");
      expect(nothing).toContain("`scope.committed-check-skipped`");
    });
  }

  it("keeps the packaged mirrors byte-identical to the canonical files", () => {
    for (const skill of ["grace-cli", "grace-reviewer", "grace-execute"]) {
      expect(read(`plugins/grace/skills/grace/${skill}/SKILL.md`)).toBe(read(`skills/grace/${skill}/SKILL.md`));
    }
  });

  it("keeps the archive step in grace-execute while the amended scope rule stays whole", () => {
    const rules = slice(read("skills/grace/grace-execute/SKILL.md"), "<execution_rules>", "</execution_rules>");
    const items = rules.split(/\n(?=\d+\. )/).filter((item) => /^\d+\. /.test(item));
    const archiveIndex = items.findIndex((item) => item.includes("Only then archive the complete bundle with `grace archive --path PROJECT --change C-ID`, which sets spec and plan to `applied`."));
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(items[archiveIndex + 1]).toMatch(/^\d+\. Never edit approved assertions or `DurableScope` in place/);
  });
});
