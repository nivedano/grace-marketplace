import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("GRACE wire-contract skill contracts", () => {
  it("documents the wire-contract convention", () => {
    const verification = read("skills/grace/grace-verification/SKILL.md");

    const open = verification.indexOf("<wire_contracts>");
    const close = verification.indexOf("</wire_contracts>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(verification.slice(close + "</wire_contracts>".length).trim()).toBe("</skill>");

    const block = verification.slice(open, close);
    for (const term of ["source.json", "sha256", "<Command>", "MustPassCommand", "unmodified copy", "generated JSON"]) {
      expect(block).toContain(term);
    }
  });

  it("reviews wire boundaries", () => {
    const reviewer = read("skills/grace/grace-reviewer/SKILL.md");
    const checklist = reviewer.slice(
      reviewer.indexOf("<review_checklist>"),
      reviewer.indexOf("</review_checklist>"),
    );
    const items = checklist.split("\n").filter((line) => line.startsWith("- "));

    expect(items.length).toBeGreaterThanOrEqual(5);
    const fifth = items[4]!;
    expect(fifth).toContain("wire boundary");
    expect(fifth).toContain("contract");
    expect(fifth).toContain("provenance");
    expect(fifth).toContain("consumer");
    expect(fifth).toContain("scenario");
  });
});
