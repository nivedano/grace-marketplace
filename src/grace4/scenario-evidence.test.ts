import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { collectCodeFiles } from "../project-utils";
import { resolveGrace4Paths } from "./project";
import { buildGraphProjection, buildVerificationProjection } from "./projections";
import { collectScenarioEvidence } from "./scenario-evidence";
import { writeMinimalGrace4Project } from "./test-fixtures";

function createProject() {
  return mkdtempSync(path.join(os.tmpdir(), "grace4-scenario-evidence-"));
}

function writeProjectFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

/** Replaces the minimal fixture's V-M-EXAMPLE body; `extraEntries` adds sibling V-M-* entries and their modules. */
function writeVerification(root: string, body: string, extraEntries: Record<string, string> = {}) {
  const extraIds = Object.keys(extraEntries);
  writeProjectFile(
    root,
    ".grace/graph/index.xml",
    `<GraceGraphIndex graceVersion="4.0"><GraphDocuments><GD-MAIN><Path>graph/main.xml</Path><Owns><M-EXAMPLE />${extraIds.map((id) => `<${id.slice(2)} />`).join("")}</Owns></GD-MAIN></GraphDocuments></GraceGraphIndex>`,
  );
  writeProjectFile(
    root,
    ".grace/graph/main.xml",
    `<GraceGraphDocument graceVersion="4.0"><GD-MAIN><M-EXAMPLE><Summary>Example module.</Summary><Path>src/example.ts</Path></M-EXAMPLE>${extraIds.map((id) => `<${id.slice(2)}><Summary>Extra.</Summary></${id.slice(2)}>`).join("")}</GD-MAIN></GraceGraphDocument>`,
  );
  writeProjectFile(
    root,
    ".grace/verification/index.xml",
    `<GraceVerificationIndex graceVersion="4.0"><VerificationDocuments><VD-MAIN><Path>verification/main.xml</Path><Owns><V-M-EXAMPLE />${extraIds.map((id) => `<${id} />`).join("")}</Owns></VD-MAIN></VerificationDocuments></GraceVerificationIndex>`,
  );
  writeProjectFile(
    root,
    ".grace/verification/main.xml",
    `<GraceVerificationDocument graceVersion="4.0"><VD-MAIN><V-M-EXAMPLE><Command>bun test src/example.test.ts</Command>${body}<Marker>[Example][run][BLOCK_RUN]</Marker></V-M-EXAMPLE>${extraIds.map((id) => `<${id}><Command>bun test</Command>${extraEntries[id]}</${id}>`).join("")}</VD-MAIN></GraceVerificationDocument>`,
  );
}

function scan(root: string, files = collectCodeFiles(root, [".grace"])) {
  const paths = resolveGrace4Paths(root);
  const verification = buildVerificationProjection(paths, buildGraphProjection(paths));
  expect(verification.issues).toHaveLength(0);
  return collectScenarioEvidence(root, verification, files);
}

function stateOf(result: ReturnType<typeof collectScenarioEvidence>, id: string) {
  return result.report.entries.flatMap((entry) => entry.scenarios).find((scenario) => scenario.id === id)?.state;
}

function codesOf(result: ReturnType<typeof collectScenarioEvidence>) {
  return result.issues.map((issue) => issue.code).sort();
}

describe("scenario evidence", () => {
  it("counts executable, manualOnly, unproven and legacy", () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeVerification(
      root,
      `<Scenario><SC-EXAMPLE-001 />Proven by a test.</Scenario><Scenario><SC-EXAMPLE-002 />Read off the bench.<ManualEvidence>Bench check.</ManualEvidence></Scenario><Scenario><SC-EXAMPLE-003 />Nothing proves it.</Scenario><Scenario>Legacy scenario.<ManualEvidence>Owner check.</ManualEvidence></Scenario>`,
    );
    writeProjectFile(root, "src/example.test.ts", `test("SC-EXAMPLE-001 proves it", () => {});\n`);

    const result = scan(root);

    expect(result.issues).toEqual([]);
    expect(result.report.totals).toEqual({ scenarios: 4, executable: 1, manualOnly: 1, unproven: 1, legacy: 1 });
    expect(result.report.entries).toEqual([
      {
        id: "V-M-EXAMPLE",
        scenarios: [
          { id: "SC-EXAMPLE-001", text: "Proven by a test.", manualEvidence: null, state: "executable" },
          { id: "SC-EXAMPLE-002", text: "Read off the bench.", manualEvidence: "Bench check.", state: "manualOnly" },
          { id: "SC-EXAMPLE-003", text: "Nothing proves it.", manualEvidence: null, state: "unproven" },
          { id: null, text: "Legacy scenario. ManualEvidence Owner check.", manualEvidence: "Owner check.", state: "legacy" },
        ],
      },
    ]);
  });

  it("scans files without GRACE markers", () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeVerification(root, `<Scenario><SC-EXAMPLE-001 />Boot works.</Scenario>`);
    writeProjectFile(root, "tests/boot_test.py", `def test_boot():\n    """SC-EXAMPLE-001."""\n`);

    expect(stateOf(scan(root), "SC-EXAMPLE-001")).toBe("executable");
  });

  it("scans <TestFiles> of any extension", () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeProjectFile(root, "bench/boot-check.md", "- [x] SC-EXAMPLE-001 confirmed on the bench\n");
    writeVerification(root, `<TestFiles><File>bench/boot-check.md</File></TestFiles><Scenario><SC-EXAMPLE-001 />Boot works.</Scenario><Scenario><SC-EXAMPLE-002 />Not listed.</Scenario>`);

    const result = scan(root);
    expect(collectCodeFiles(root, [".grace"]).some((file) => file.endsWith("boot-check.md"))).toBe(false);
    expect(stateOf(result, "SC-EXAMPLE-001")).toBe("executable");
    expect(stateOf(result, "SC-EXAMPLE-002")).toBe("unproven");
  });

  it("skips dot-segment paths", () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeProjectFile(root, ".tmp/scratch.ts", "// SC-EXAMPLE-001\n");
    writeProjectFile(root, "src/.scratch/boot.test.ts", "// SC-EXAMPLE-002\n");
    writeVerification(
      root,
      `<TestFiles><File>src/.scratch/boot.test.ts</File></TestFiles><Scenario><SC-EXAMPLE-001 />Scratch only.</Scenario><Scenario><SC-EXAMPLE-002 />Hidden test only.</Scenario>`,
    );

    const files = [...collectCodeFiles(root, [".grace"]), path.join(root, ".tmp", "scratch.ts"), path.join(root, "src", ".scratch", "boot.test.ts")];
    const result = scan(root, files);
    expect(stateOf(result, "SC-EXAMPLE-001")).toBe("unproven");
    expect(stateOf(result, "SC-EXAMPLE-002")).toBe("unproven");
    expect(result.issues).toEqual([]);
  });

  it("raises duplicate-id, invalid-id (malformed, second id, entry mismatch) and dangling-reference only for an existing entry", () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeVerification(
      root,
      [
        `<Scenario><SC-EXAMPLE-001 />First.</Scenario>`,
        `<Scenario><SC-EXAMPLE-001 />Duplicate.</Scenario>`,
        `<Scenario><SC-EXAMPLE-02 />Malformed number.</Scenario>`,
        `<Scenario><SC-EXAMPLE-007>not empty</SC-EXAMPLE-007>Malformed content.</Scenario>`,
        `<Scenario><SC-EXAMPLE-004 /><SC-EXAMPLE-005 />Second id.</Scenario>`,
        `<Scenario><SC-OTHER-006 />Wrong entry.</Scenario>`,
      ].join(""),
      { "V-M-OTHER": `<Scenario><SC-OTHER-001 />Other works.</Scenario>` },
    );
    writeProjectFile(
      root,
      "src/example.test.ts",
      [
        "// SC-EXAMPLE-001 and SC-OTHER-001 exist.",
        "// SC-EXAMPLE-009 names V-M-EXAMPLE, which has no such scenario.",
        "// SC-NOPE-001 names no entry; SC-EXAMPLE-002-003 names V-M-EXAMPLE-002, which does not exist.",
        "// SC-EXAMPLE-009 again on another line.",
        "",
      ].join("\n"),
    );

    const result = scan(root);

    expect(codesOf(result)).toEqual([
      "verification.scenario-dangling-reference",
      "verification.scenario-duplicate-id",
      "verification.scenario-invalid-id",
      "verification.scenario-invalid-id",
      "verification.scenario-invalid-id",
      "verification.scenario-invalid-id",
    ]);
    expect(result.issues.every((issue) => issue.severity === "error")).toBe(true);
    const messages = result.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("SC-EXAMPLE-001");
    expect(messages).toContain("<SC-EXAMPLE-02>");
    expect(messages).toContain("<SC-EXAMPLE-007>");
    expect(messages).toContain("<SC-EXAMPLE-005>");
    expect(messages).toContain("SC-OTHER-006");
    const dangling = result.issues.find((issue) => issue.code === "verification.scenario-dangling-reference");
    expect(dangling?.message).toContain("SC-EXAMPLE-009");
    expect(dangling?.file).toBe(path.join(root, "src", "example.test.ts"));
    expect(dangling?.line).toBe(2);
    expect(messages).not.toContain("SC-NOPE-001");
    expect(messages).not.toContain("SC-EXAMPLE-002-003");
  });

  it("checks a dangling reference against the entry its token names, not the whole project", () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    // SC-OTHER-006 exists, but on V-M-EXAMPLE; V-M-OTHER itself has no such scenario.
    writeVerification(root, `<Scenario><SC-OTHER-006 />Wrong entry.</Scenario>`, { "V-M-OTHER": `<Scenario><SC-OTHER-001 />Other works.</Scenario>` });
    writeProjectFile(root, "src/example.test.ts", "// SC-OTHER-006\n");

    const dangling = scan(root).issues.filter((issue) => issue.code === "verification.scenario-dangling-reference");
    expect(dangling.map((issue) => issue.message)).toEqual(["SC-OTHER-006 names V-M-OTHER, which has no scenario with that id."]);
  });
});
