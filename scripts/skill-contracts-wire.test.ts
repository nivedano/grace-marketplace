import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const WIRE_CHANGE_FORMULA = [
  "A producer change to a wire boundary updates the contract artifact and the scenarios that name it, and names each consumer.",
  "A consumer change updates its copy, the copy's `<artifact>.source.json` with the producer `commit`, and the scenarios that name them.",
];

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

    const wireIndex = items.findIndex((item) => item.includes("wire boundary"));
    expect(wireIndex).toBeGreaterThan(0);
    expect(items[wireIndex - 1]!.startsWith("- Active change specs/plans")).toBe(true);
    const wire = items[wireIndex]!;
    for (const sentence of WIRE_CHANGE_FORMULA) {
      expect(wire).toContain(sentence);
    }
    expect(wire).toContain("has its own consumer change");
  });

  it("states the producer and consumer change rule with one formula in both skills", () => {
    const verification = read("skills/grace/grace-verification/SKILL.md");
    const block = verification.slice(verification.indexOf("<wire_contracts>"), verification.indexOf("</wire_contracts>"));
    for (const sentence of WIRE_CHANGE_FORMULA) {
      expect(block).toContain(sentence);
    }
    expect(block).toContain("list every repository it affects in `AffectedAreas`");
  });

  it("keeps copies byte-stable and binds each check to its side", () => {
    const verification = read("skills/grace/grace-verification/SKILL.md");
    const block = verification.slice(verification.indexOf("<wire_contracts>"), verification.indexOf("</wire_contracts>"));
    expect(block).toContain("Mark the copy `-text` in `.gitattributes`");
    for (const field of ["`repository` (", "`path` (", "`commit` (", "`sha256` ("]) {
      expect(block).toContain(field);
    }
    expect(block).toContain("the producer's generation or check of its constants under a `<Command>` of the producer's `V-M-*` entry");
    expect(block).toContain("the consumer's conformance test under a `<Command>` of the consumer's `V-M-*` entry");
    expect(block).toContain("In each consumer change, compare the copy with the producer's file at the recorded `commit`");
  });

  it("keeps the packaged skills identical to the canonical copies", () => {
    for (const skill of ["grace-verification", "grace-reviewer"]) {
      expect(read(`plugins/grace/skills/grace/${skill}/SKILL.md`)).toBe(read(`skills/grace/${skill}/SKILL.md`));
    }
  });
});
