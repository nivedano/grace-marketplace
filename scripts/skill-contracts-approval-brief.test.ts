import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const BRIEF_DIR = "skills/grace/grace-brief";
const BRIEF_FILES = [
  `${BRIEF_DIR}/SKILL.md`,
  `${BRIEF_DIR}/agents/openai.yaml`,
  `${BRIEF_DIR}/references/auditor-role.md`,
  `${BRIEF_DIR}/references/brief-template.md`,
];

const PAIR_OPTION = "\"approve <C-ID>: spec and plan\"";
const PLAN_OPTION = "\"approve <C-ID>: plan\"";
/** Re-approval rules stated once and copied verbatim into SKILL.md and auditor-role.md. */
const SHARED_REAPPROVAL_SENTENCES = [
  "Read the last approved `plan.xml` from git at the newest commit in which `plan.xml` has `status=\"approved\"`.",
  "Put every change of `BaselineAssertions`, `TargetAssertions` or `DurableScope` in section C.",
  "Without a last approved `plan.xml`, audit the pair in full.",
];
const RETURN_PRECHECK ="git log --format=%h --grep='^Change: <C-ID>$' <approval-commit>..HEAD -- . ':(exclude).grace'";

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/** The text of the first `<tag>` … `</tag>` block; fails when either marker is missing. */
function block(text: string, tag: string): string {
  const open = text.indexOf(`<${tag}>`);
  expect(open).toBeGreaterThanOrEqual(0);
  const close = text.indexOf(`</${tag}>`, open);
  expect(close).toBeGreaterThan(open);
  return text.slice(open, close + tag.length + 3);
}

/** The text from a `## heading` line to the next `## ` heading or the end; fails when the heading is missing. */
function section(text: string, heading: string): string {
  const open = text.indexOf(`\n## ${heading}\n`);
  expect(open).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", open + heading.length + 4);
  return next === -1 ? text.slice(open) : text.slice(open, next);
}

function expectAll(text: string, terms: string[]): void {
  for (const term of terms) {
    expect(text).toContain(term);
  }
}

describe("grace-brief registration", () => {
  it("ships the skill files and mirrors them byte-for-byte", () => {
    for (const file of BRIEF_FILES) {
      expect(existsSync(path.join(repoRoot, file))).toBe(true);
      const packaged = path.join(repoRoot, "plugins/grace", file);
      expect(existsSync(packaged)).toBe(true);
      expect(readFileSync(packaged).equals(readFileSync(path.join(repoRoot, file)))).toBe(true);
    }
  });

  it("publishes grace-brief right after grace-plan and requires it", () => {
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { name: string; skills: string[] }[];
    };
    const skills = marketplace.plugins.find((plugin) => plugin.name === "grace")!.skills;
    expect(skills.indexOf("./skills/grace/grace-brief")).toBe(skills.indexOf("./skills/grace/grace-plan") + 1);

    const validator = read("scripts/validate-marketplace.ts");
    const required = validator.slice(
      validator.indexOf("const REQUIRED_GRACE4_SKILLS"),
      validator.indexOf("]);", validator.indexOf("const REQUIRED_GRACE4_SKILLS")),
    );
    expect(required).toContain("\"grace-brief\"");
  });

  it("names the skill in its frontmatter, its agent card and the README skill table", () => {
    const skill = read(`${BRIEF_DIR}/SKILL.md`);
    expect(skill.startsWith("---\nname: grace-brief\n")).toBe(true);
    expect(skill).toContain(
      "description: Audit a draft GRACE 4 spec-and-plan pair through an independent subagent, present the owner a one-screen brief, and record the owner's approval.",
    );
    expect(read(`${BRIEF_DIR}/agents/openai.yaml`)).toContain("display_name: \"GRACE Brief\"");

    const readme = read("README.md");
    const planRow = readme.indexOf("| `grace-plan` |");
    const briefRow = readme.indexOf("| `grace-brief` |");
    expect(briefRow).toBeGreaterThan(planRow);
    expect(readme.indexOf("| `grace-execute` |")).toBeGreaterThan(briefRow);
  });
});

describe("grace-brief procedure", () => {
  const skill = read(`${BRIEF_DIR}/SKILL.md`);

  it("writes the change id as `<C-ID>` everywhere", () => {
    expect(skill.replaceAll("<C-ID>", "")).not.toContain("C-ID");
  });

  it("runs the draft checks and commits the draft bundle before the audit", () => {
    expectAll(block(skill, "preflight"), [
      "`awaiting-approval`",
      "`needs-plan-approval`",
      "grace lint --path PROJECT --assertions current",
      "grace lint --path PROJECT --change <C-ID> --assertions baseline --draft",
      "add `--run-commands` when `BaselineAssertions` declares `MustPassCommand`",
      "touches only `.grace/`",
      "`Change: <C-ID>`",
    ]);
  });

  it("dispatches an independent auditor with the bundle path and project root only", () => {
    expectAll(block(skill, "audit_dispatch"), [
      "fresh subagent, never a fork of the authoring session",
      "only the bundle path and the project root",
      "`auditor` preset",
      "the role text of `references/auditor-role.md`",
      "\"self-audited\" in the brief and in the approval record",
    ]);
  });

  it("shows the owner nothing while section D is non-empty and states the brief budget", () => {
    const loop = block(skill, "brief_loop");
    expectAll(loop, [
      "section D is non-empty",
      "sections A to C",
      "60 lines",
      "Move to section C a section-D finding you cannot fix inside the bundle, such as a check-5 overlap with another active bundle's `plan.xml`.",
    ]);
  });

  it("asks the owner through the question tool and keeps approval the owner's", () => {
    expectAll(block(skill, "owner_decision"), [
      "question tool, one question per section-C item, your recommendation first",
      `${PAIR_OPTION} in state \`awaiting-approval\``,
      `${PLAN_OPTION} in state \`needs-plan-approval\``,
      "\"send back\"",
      "`OwnerDecisions`",
      "Only the owner approves.",
      "a free-text approval naming the change given after the brief is shown",
      `Count a free-text approval as the option of the bundle's state: ${PAIR_OPTION} in \`awaiting-approval\`, ${PLAN_OPTION} in \`needs-plan-approval\`.`,
      "Discard an approve selection made in a round whose answers change `spec.xml` or `plan.xml`; ask again after the fresh audit.",
      "Never set `status=\"approved\"` without that statement.",
    ]);
  });

  it("records the approval in a .grace-only commit before any code commit", () => {
    const commit = block(skill, "approval_commit");
    expect(commit).not.toContain("write the record there");
    expectAll(commit, [
      "touches only `.grace/`, before any commit that writes outside `.grace/`",
      "`approval-pending-commit`",
      "the theses as presented",
      "each owner decision with the owner's answer",
      "the contradictions found and how each was resolved",
      "the owner's approval statement, quoted",
      "an independent subagent or self-audited",
      "the draft bundle commit the audit read",
      "the `--assertions current` result",
      "the `--assertions baseline --change <C-ID> --draft` result",
      "the run-log path and the run's per-command result lines, quoted",
      "\"no commands\"",
      "the last approved commit compared against",
      "before the final trailer block that carries `Change: <C-ID>`",
      "Keep the approval record in the commit body. When `.grace/context` names a place for approval records inside `.grace/` outside the bundle, also write a copy there in the same approval commit.",
    ]);
  });

  it("keeps the approval apart from the execution order", () => {
    expectAll(block(skill, "execution_order"), [
      "the approval is not the execution order, even when both arrive in one message, unless the message says to execute",
      "separate explicit owner order",
      "`$grace-execute`",
      "`ready-to-execute`",
    ]);
  });

  it("returns an approved plan to draft only inside the re-approval window", () => {
    expectAll(block(skill, "return_to_draft"), [
      "owner's request or agreement",
      "Re-approve only before the first commit of the change that writes outside `.grace/`",
      "`scope.reapproval-after-write`",
      RETURN_PRECHECK,
      "in a commit of its own that changes only the root `status` attribute, touches only `.grace/`, ends with the `Change: <C-ID>` trailer, and names in its body who asked",
      "Make content edits in later commits.",
    ]);
  });

  it("scopes a re-approval audit to the change against the last approved plan", () => {
    expectAll(block(skill, "reapproval_audit"), [
      ...SHARED_REAPPROVAL_SENTENCES,
      "apart from its root `status`, dispatch no audit",
      "\"plan unchanged apart from its status; no audit ran\"",
      "applies checks 4 and 5 to `plan.xml` as it stands and limits the brief to the change against the last approved `plan.xml`",
      `${PLAN_OPTION} still approves \`plan.xml\` alone`,
    ]);
  });
});

describe("grace-brief auditor role", () => {
  const role = read(`${BRIEF_DIR}/references/auditor-role.md`);

  it("is read-only and works from the artifacts alone", () => {
    expectAll(role, [
      "Edit no file, set no status, commit nothing.",
      "the bundle path and the project root, nothing else",
      "no authoring conversation and no author's summary",
      "`.grace/context`",
      "the last approved `plan.xml`",
    ]);
  });

  it("holds checks 1 to 5 with the batch-1 clauses", () => {
    const checks = block(role, "checks");
    for (const number of ["1. ", "2. ", "3. ", "4. ", "5. "]) {
      expect(checks).toContain(`\n${number}`);
    }
    expectAll(checks, [
      "`OwnerDecisions`",
      "`<wire_contracts>` copy or its `.source.json`",
      "`AffectedAreas` holds `M-*` modules only",
      "`<observed_scope_derivation>`",
      "excluded by name in `IntentSummary`",
      "`SC-<entry>-NNN`",
      "a `V-M-*` entry named in `DurableScope`",
      "through its `<TestFiles>`",
      "`MustPassCommand`",
      "`grace lint --parallel-preflight` compares approved pairs only",
    ]);

    const check2 = checks.slice(checks.indexOf("\n2. "), checks.indexOf("\n3. "));
    expect(check2).not.toContain("exceeds `AffectedAreas`");
    expect(check2).toContain("a `DurableScope` or `ObservedWriteScope` path in an area a rule or behavioural contract forbids the change to touch");
  });

  it("routes owner items to section C and mechanical findings to section D", () => {
    expectAll(role, [
      "Route to section C each decision of check 1's first list, each finding of check 2, and each finding of checks 3 to 5 with two defensible readings.",
      "Turn check 1's second list into the `silent` theses of section A, not section-C items.",
      "Route every other finding of checks 3 to 5 to section D.",
    ]);
  });

  it("scopes a re-approval audit with the skill's own sentences", () => {
    expectAll(section(role, "Re-approval"), [
      ...SHARED_REAPPROVAL_SENTENCES,
      "apply checks 4 and 5 to `plan.xml` as it stands and limit the brief to the change against the last approved `plan.xml`",
      "sections changed, scope entries added or removed, tasks added, removed or rewritten, and gate sections changed",
    ]);
  });

  it("writes a bounded four-section brief whose section D never reaches the owner", () => {
    expectAll(section(role, "Brief"), [
      "Fit sections A to C in 60 lines or fewer.",
      "A. Theses.",
      "`recorded`",
      "`silent`",
      "B. Shape.",
      "counts",
      "orphans by name",
      "C. Owner decisions.",
      "the two readings",
      "D. For the author.",
      "it never reaches the owner",
    ]);
  });

  it("ships a layout for the brief and the approval record", () => {
    const template = read(`${BRIEF_DIR}/references/brief-template.md`);
    expectAll(template, [
      "A. Theses",
      "B. Shape",
      "C. Owner decisions",
      "D. For the author",
      "Approval record",
      `${PAIR_OPTION} | ${PLAN_OPTION}`,
      "--change <C-ID> --draft",
      "Change: <C-ID>",
    ]);
    expect(template.replaceAll("<C-ID>", "")).not.toContain("C-ID");
  });
});
