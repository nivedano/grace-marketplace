import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { writeSegmentedGrace4Project } from "./grace4/test-fixtures";
import { lintGraceProject } from "./grace-lint";
import { getLintIssueGuide } from "./lint/catalog";

function createProject() {
  return mkdtempSync(path.join(os.tmpdir(), "grace-lint-"));
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


describe("scenario evidence lint", () => {
  it("an existing fixture project gets no new issues", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    // Tokens whose entry part names no V-M-* entry are ignored, so legacy projects stay clean.
    writeProjectFile(root, "src/notes.ts", "// SC-UNRELATED-001 and SC-EXAMPLE-002-003 name no entry.\n");
    const segmented = createProject();
    writeSegmentedGrace4Project(segmented);

    for (const project of [root, segmented]) {
      const result = await lintGraceProject(project);
      expect(result.issues.map((issue) => issue.code)).toEqual([]);
    }
  });

  it("reports scenario id codes through lint and documents them in the catalog", async () => {
    const root = createProject();
    writeMinimalGrace4Project(root);
    writeProjectFile(
      root,
      ".grace/verification/main.xml",
      `<GraceVerificationDocument graceVersion="4.0"><VD-MAIN><V-M-EXAMPLE><Command>bun test src/example.test.ts</Command><Scenario><SC-EXAMPLE-001 />example works</Scenario><Scenario><SC-EXAMPLE-001 /><SC-EXAMPLE-002 />twice</Scenario><Marker>[Example][run][BLOCK_RUN]</Marker></V-M-EXAMPLE></VD-MAIN></GraceVerificationDocument>`,
    );
    writeProjectFile(root, "src/example.test.ts", `import { expect, test } from "bun:test";\ntest("SC-EXAMPLE-009 example", () => expect(1).toBe(1));\n`);

    const codes = (await lintGraceProject(root)).issues.map((issue) => issue.code).sort();
    expect(codes).toEqual([
      "verification.scenario-dangling-reference",
      "verification.scenario-duplicate-id",
      "verification.scenario-invalid-id",
    ]);

    for (const code of ["verification.scenario-duplicate-id", "verification.scenario-invalid-id", "verification.scenario-dangling-reference"]) {
      expect(getLintIssueGuide(code).title).toContain("Scenario");
      expect(getLintIssueGuide(code).explanation).not.toContain("does not yet have a dedicated explanation");
    }
    expect(getLintIssueGuide("verification.other").title).toContain("Verification");
  });

  it("gives verification structural codes a guide about the index, documents and wrappers", () => {
    for (const code of ["verification.invalid-document-wrapper", "verification.index-invalid-documents-section"]) {
      const guide = getLintIssueGuide(code);
      expect(guide.title).toBe("Verification Document Drift");
      const text = [guide.explanation, ...guide.remediation].join(" ");
      expect(text).toContain("VD-*");
      expect(text).toContain("wrapper");
      expect(text).toContain("index");
    }
  });
});
