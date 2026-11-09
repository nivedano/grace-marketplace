import type { LintIssue } from "./types";

type LintIssueGuide = {
  code: string;
  title: string;
  explanation: string;
  remediation: string[];
};

/**
 * Committed-scope classification uses each file's earliest owned write, so a new commit never clears these issues;
 * the remediation never suggests reverting and writing again or restoring sections.
 */
const COMMITTED_HISTORY_REMEDIATION =
  "Stop and report the issue to the user: it is fixed in history, because the check classifies each file by its earliest owned write, so no new commit clears it. The user chooses between rewriting unpublished history and superseding the bundle.";

const EXACT_GUIDES: Record<string, Omit<LintIssueGuide, "code">> = {
  "config.invalid-json": {
    title: "Invalid Lint Config JSON",
    explanation: "The repository-level .grace-lint.json file could not be parsed as JSON.",
    remediation: ["Fix the JSON syntax in .grace-lint.json.", "If the file is accidental, remove it."],
  },
  "config.invalid-shape": {
    title: "Invalid Lint Config Shape",
    explanation: ".grace-lint.json must be a JSON object.",
    remediation: ["Replace the file contents with a JSON object.", "Keep only supported keys like ignoredDirs."],
  },
  "config.unknown-key": {
    title: "Unknown Lint Config Key",
    explanation: ".grace-lint.json contains a key the CLI does not understand.",
    remediation: ["Remove unsupported keys from .grace-lint.json.", "Use only documented keys such as ignoredDirs and runLogRetention."],
  },
  "config.invalid-run-log-retention": {
    title: "Invalid Run Log Retention",
    explanation: "`runLogRetention` in .grace-lint.json sets how many non-passing --run-commands log directories to keep, so it must be a non-negative integer.",
    remediation: ["Set runLogRetention to a non-negative integer, for example 25.", "Remove the key to use the default of 10."],
  },
  "config.invalid-require-change-trailers": {
    title: "Invalid Require Change Trailers",
    explanation: "`requireChangeTrailers` in .grace-lint.json switches change-trailer requirements on or off, so it must be a boolean.",
    remediation: ["Set requireChangeTrailers to true or false.", "Remove the key to use the default of false."],
  },
  "config.invalid-committed-scope-exempt": {
    title: "Invalid Committed Scope Exempt",
    explanation: "`committedScopeExempt` in .grace-lint.json lists bookkeeping files that the committed-scope check reports but never classifies, so it must be an array of globs in the ObservedWriteScope glob grammar: project-relative literals, *, ? and a whole-segment **.",
    remediation: ["Write each entry as a project-relative glob such as .beads/**.", "Remove the key to exempt nothing."],
  },
  "analysis.adapter-failed": {
    title: "Language Adapter Failed",
    explanation: "The file-level export analysis adapter failed, so exact export/local parity could not be validated for this governed file.",
    remediation: ["Inspect the file for unusual syntax or unsupported language features.", "Simplify the export surface or improve the adapter if this language pattern should be supported."],
  },
  "analysis.runtime-missing": {
    title: "Language Runtime Missing",
    explanation: "The governed file uses a language adapter that requires its language runtime on PATH. GRACE fails closed instead of silently dropping export/local parity checks.",
    remediation: ["Install the runtime named in the issue message and ensure it is available on PATH.", "If the file should not be governed in this environment, exclude it explicitly rather than relying on incomplete analysis."],
  },
  "walk.unreadable-directory": {
    title: "Unreadable Directory Skipped",
    explanation: "A directory could not be listed while walking the project, so the files inside it were not checked. This usually means restrictive permissions or a leftover sandbox directory; it does not make the GRACE project itself invalid.",
    remediation: ["Restore read permission on the directory if it should be governed.", "If the directory is build output or a sandbox leftover, add it to ignoredDirs in .grace-lint.json or remove it."],
  },
  "scope.durable-overlap": {
    title: "Durable Scope Overlap",
    explanation: "Two or more active change scopes claim overlapping durable regions, which creates a data-contention risk if executed in parallel.",
    remediation: ["Review the overlapping durable scopes and decide whether they must be sequential or whether the overlap is acceptable.", "Treat durable overlap as a planning warning, not a blocker."],
  },
  "scope.observed-write-overlap": {
    title: "Observed Write Overlap",
    explanation: "Two or more active change scopes write to overlapping regions, which can cause unsafe concurrent execution.",
    remediation: ["Do not run overlapping observed writes in parallel-safe mode.", "Sequence the changes or split scopes to eliminate the overlap."],
  },
  "scope.committed-outside": {
    title: "Committed Write Outside Scope",
    explanation: "A commit owned by the change wrote a file outside the final ObservedWriteScope of its plan, or inside it but never admitted by the approval, a re-approval or a widening commit.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, widen ObservedWriteScope in a commit that touches only .grace/ before the first write of a file outside it."],
  },
  "scope.widening-with-code": {
    title: "Widening Committed With Code",
    explanation: "A file was admitted to ObservedWriteScope by a widening commit that also wrote outside .grace/. The admission must be reviewable before the file is written.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, commit a plan.xml widening on its own, touching nothing outside .grace/, and write the admitted files in a later commit."],
  },
  "scope.written-before-widening": {
    title: "Written Before Widening",
    explanation: "A file was written in the widening commit that admitted it to ObservedWriteScope, before that commit, or before the re-approval that admitted it, so the write was not covered by the scope at the time.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, commit the widening first, on its own, and write the file afterwards."],
  },
  "scope.written-before-approval": {
    title: "Written Before Approval",
    explanation: "A commit owned by the change wrote a file before its plan was approved.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, commit the approved plan.xml in or before the first commit that writes outside .grace/."],
  },
  "scope.approved-plan-mutated": {
    title: "Approved Plan Mutated",
    explanation: "An approved plan.xml changed in a gate section without a re-approval: BaselineAssertions, TargetAssertions, DurableScope, the root or C-* wrapper, or any section other than ObservedWriteScope, ImplementationPlan and IntentSummary. An unparseable approved version counts as well.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, change BaselineAssertions, TargetAssertions or DurableScope only through a new C-* bundle, and mark the old bundle superseded."],
  },
  "scope.approved-plan-amended": {
    title: "Approved Plan Amended",
    explanation: "An approved plan.xml changed only in ImplementationPlan tasks or IntentSummary, without a re-approval. Such an amendment needs the user's agreement and is investigated at review.",
    remediation: ["Confirm the user agreed to the amendment and that its commit body records that agreement.", "Commit an amendment on its own, touching nothing outside .grace/."],
  },
  "scope.approval-uncommitted": {
    title: "Approval Not Committed",
    explanation: "No commit has the plan as approved, so the committed-scope check has no approval base to compare against.",
    remediation: ["Commit the approved plan.xml in or before the first commit that writes outside .grace/.", "Run the final check again after the approval commit exists."],
  },
  "scope.no-owned-commits": {
    title: "No Commits Owned By The Change",
    explanation: "The ObservedWriteScope is not <None />, yet no commit in the change's window carries its Change trailer, so no committed write can be attributed. It is an error when requireChangeTrailers is true in .grace-lint.json.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, end every commit with its Change: C-* trailer; set requireChangeTrailers in .grace-lint.json to make this an error."],
  },
  "scope.reapproval-changed-gates": {
    title: "Re-approval Changed Gates",
    explanation: "A re-approval of the plan changed BaselineAssertions, TargetAssertions, DurableScope or another gate section relative to the last approved version. Gate sections change through a superseding bundle, so the re-approval is investigated at review.",
    remediation: ["Confirm the user re-approved the changed gate sections and that the re-approval commit body records it.", "In later changes, change gate sections only through a new C-* bundle, and mark the old bundle superseded."],
  },
  "scope.reapproval-widened": {
    title: "Re-approval Widened Scope",
    explanation: "A re-approval of the plan added entries to ObservedWriteScope. The additions were approved together with other plan changes rather than as a separate widening.",
    remediation: ["Confirm the added scope entries are intended.", "Prefer a separate widening commit that touches nothing outside .grace/."],
  },
  "scope.widened-far": {
    title: "Widened Scope Far From Approval",
    explanation: "A file admitted by a widening lies far from the scope approved earlier, rather than next to a file or package it already covered.",
    remediation: ["Confirm the file belongs to this change.", "If it does not, remove it from ObservedWriteScope and move the work to its own change."],
  },
  "scope.untagged-commit": {
    title: "Untagged Commit In Scope",
    explanation: "A commit with no effective Change trailer touched files in the final ObservedWriteScope of this change, so it cannot be attributed to any change.",
    remediation: [COMMITTED_HISTORY_REMEDIATION, "In later changes, end every commit of a change with its Change: C-* trailer; requireChangeTrailers in .grace-lint.json enforces trailers."],
  },
  "scope.committed-check-skipped": {
    title: "Committed-Scope Check Skipped",
    explanation: "The committed-scope check could not read the history: the project has no .git at or above its root, or the repository is a shallow clone.",
    remediation: ["Run the final check in a full git checkout.", "Fetch the full history before running the final check in CI."],
  },
  "scope.committed-check-failed": {
    title: "Committed-Scope Check Failed",
    explanation: "A git command the committed-scope check needs failed, so the check could not run. The message names the command and carries git's stderr, for example a dubious-ownership refusal or a missing object.",
    remediation: ["Fix the git error named in the message, for example by adding the repository to safe.directory or fetching the missing objects.", "Run the final check again."],
  },
  "change.superseded-missing-replacement": {
    title: "Superseded Change Missing Replacement Reference",
    explanation: "A GraceChangeSpec or GraceChangePlan with status='superseded' should name the replacement C-* anchor via a <Replacement> or <ReplacementChange> child tag.",
    remediation: ["Add a <Replacement>C-REPLACEMENT-ID</Replacement> child to the superseded wrapper.", "Or add a direct <C-REPLACEMENT-ID /> child tag as the replacement reference."],
  },
  "assertion.command-subsumed": {
    title: "Subsumed Assertion Command",
    explanation: "Two MustPassCommand entries in the same assertion section run overlapping work: they share the same command head, and one command's path arguments are a component-wise prefix of the other's (or the wider command names no path at all and therefore covers the whole suite). The narrower command is re-run for nothing, which inflates gate wall-clock time without adding evidence. A bare token counts as a path argument only when it contains a separator or exists under the project root, so `bun test src` covers `bun test src/grace4` but never `bun test srcfoo`.",
    remediation: ["Delete the narrower command and keep the whole-suite one, or narrow the wider command so the two cover disjoint paths.", "If the slow whole-suite command is dominated by substrate startup, move it to an acceptance tier instead of the gate."],
  },
  "assertion.invalid-command-budget": {
    title: "Invalid Assertion Command Budget",
    explanation: "A MustPassCommand/Command declares a budgetSeconds attribute that is not a non-negative integer number of seconds. The grammar mirrors --command-timeout exactly, including 0 meaning 'no timeout for this command'.",
    remediation: ["Write budgetSeconds as a whole number of seconds, for example budgetSeconds=\"900\".", "Use budgetSeconds=\"0\" only when the command must never be killed on time, and omit the attribute to fall back to --command-timeout."],
  },
  "assertion.phase-incompatible-command": {
    title: "Phase-Incompatible Assertion Command",
    explanation: "A target command assertion invokes current-mode lifecycle lint. Current mode evaluates active approved baselines, so it is a pre-implementation check and cannot serve as target or final evidence after writes begin.",
    remediation: ["Keep MustPassCommand entries as leaf project evidence such as tests, typecheck, build, format, or package checks.", "Run selected target or final GRACE lint as the outer execution gate instead of nesting it inside the plan."],
  },
  "verification.scenario-duplicate-id": {
    title: "Duplicate Scenario Id",
    explanation: "The same SC-* id appears on two <Scenario> elements. Because the entry is part of the id, every scenario id must be unique across the project.",
    remediation: ["Give the later scenario the next free SC-<entry>-NNN id of its entry.", "Update any test that references the renumbered id."],
  },
  "verification.scenario-invalid-id": {
    title: "Invalid Scenario Id",
    explanation: "A <Scenario> id element is malformed, a <Scenario> carries a second id element, or the id's entry part does not match the enclosing V-M-* entry. An entry rename therefore surfaces at once.",
    remediation: ["Use one empty, attribute-free SC-<entry>-NNN element per scenario, where <entry> is the enclosing V-M-* id without V-M- and NNN is three digits.", "After renaming an entry, renumber its scenario ids and the tests that reference them."],
  },
  "verification.scenario-dangling-reference": {
    title: "Dangling Scenario Reference",
    explanation: "A scanned file contains an SC-* token whose entry part names an existing V-M-* entry, but that entry has no scenario with that id. A token whose entry part matches no entry is ignored.",
    remediation: ["Restore the scenario the token names, or point the token at the scenario the test actually proves.", "Remove the token if the scenario was deleted on purpose."],
  },
};

const PREFIX_GUIDES: Array<{ prefix: string; title: string; explanation: string; remediation: string[] }> = [
  {
    prefix: "project.",
    title: "GRACE 4 Project Detection Issue",
    explanation: "The CLI could not identify a valid GRACE 4 .grace project state, or it detected legacy GRACE 3 artifacts instead.",
    remediation: ["Run $grace-init for a new GRACE 4 project or $grace-migrate for legacy GRACE 3 projects.", "Do not rely on dual-mode docs/*.xml validation."],
  },
  {
    prefix: "artifact.",
    title: "GRACE 4 Artifact Grammar Issue",
    explanation: "A .grace XML artifact violates the GRACE 4 root, metadata, version, or semantic-anchor grammar.",
    remediation: ["Use approved GRACE 4 root tags with graceVersion=\"4.0\".", "Keep semantic anchors as XML tags, never attributes."],
  },
  {
    prefix: "change.",
    title: "GRACE 4 Change Lifecycle Issue",
    explanation: "A change spec or plan has an invalid status, wrapper shape, or active/archive location for the GRACE 4 lifecycle.",
    remediation: ["Keep draft and approved bundles under .grace/changes/active.", "Move applied, rejected, cancelled, or superseded bundles to archive with matching statuses."],
  },
  {
    prefix: "context.",
    title: "GRACE 4 Context Artifact Issue",
    explanation: "A required .grace/context artifact is missing, has the wrong root, or has invalid applicability metadata.",
    remediation: ["Create all five context artifacts from the GRACE 4 init template.", "If deployment or UX is not applicable, include a concrete reason."],
  },
  {
    prefix: "projection.",
    title: "GRACE 4 Projection Integrity Issue",
    explanation: "Graph or verification index routes do not match the logical projection built from .grace documents.",
    remediation: ["Synchronize GD-* and VD-* index ownership with document wrappers.", "Ensure every M-* has deterministic V-M-* coverage."],
  },
  {
    prefix: "assertion.",
    title: "GRACE 4 Assertion Failure",
    explanation: "A BaselineAssertions or TargetAssertions entry failed against current graph, verification, or filesystem state.",
    remediation: ["Reconcile the current state with the approved plan assertions.", "If the approved plan is stale, supersede and replan rather than editing it silently."],
  },
  {
    prefix: "scope.",
    title: "GRACE 4 Scope Conflict",
    explanation: "Active change scopes overlap in durable or observed write surfaces.",
    remediation: ["Treat durable overlap as a planning warning.", "Do not run overlapping observed writes in parallel-safe mode."],
  },
  {
    prefix: "xml.generic-",
    title: "Generic XML Tag Used Instead Of Unique GRACE Tag",
    explanation: "GRACE shared artifacts rely on unique ID-based XML tags such as M-*, Phase-*, and step-* so agents can reference them deterministically.",
    remediation: ["Replace the generic XML tag with the corresponding unique GRACE tag.", "Keep the unique tag and any verification-ref/module references synchronized across shared artifacts."],
  },
  {
    prefix: "markup.",
    title: "Semantic Markup Integrity Issue",
    explanation: "The governed file markup is incomplete, mismatched, or out of sync with the intended export or local symbol surface.",
    remediation: ["Repair the MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY, or semantic block markers in the file.", "Keep file-local markup aligned with the actual code surface and semantic block boundaries."],
  },
  {
    prefix: "graph.",
    title: "Knowledge Graph Drift",
    explanation: "The .grace/graph index references modules or entries that do not align with the current verification or filesystem state.",
    remediation: ["Synchronize GD-* index entries with the actual .grace/graph documents.", "Run $grace-refresh if the drift came from real code changes."],
  },
  {
    prefix: "plan.",
    title: "Change Plan Drift",
    explanation: "A GraceChangePlan is missing assertions, scopes, or verification refs needed for governed execution.",
    remediation: ["Update the GraceChangeSpec and GraceChangePlan so modules, assertions, and verification refs match the current .grace state.", "Use $grace-spec or $grace-plan when the architecture changed."],
  },
  {
    prefix: "analysis.",
    title: "Export Surface Analysis Warning",
    explanation: "The language adapter could not prove the exact export surface or detected a shape that weakens precise linting.",
    remediation: ["Prefer clearer export declarations or explicit ROLE/MAP_MODE overrides when necessary.", "Treat heuristic or wildcard-export warnings as cues to simplify or document the file surface."],
  },
  {
    prefix: "verification.",
    title: "Verification Document Drift",
    explanation: "The .grace/verification index or a verification document is malformed: the index lacks exactly one VerificationDocuments section, or a document lacks exactly one direct VD-* wrapper.",
    remediation: ["Keep one VerificationDocuments section in the verification index and one direct VD-* wrapper per verification document, matching its index route.", "Keep V-M-* entries directly under that wrapper."],
  },
];

function toTitleFromCode(code: string) {
  return code
    .split(/[.-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getLintIssueGuide(code: string): LintIssueGuide {
  const exact = EXACT_GUIDES[code];
  if (exact) {
    return { code, ...exact };
  }

  const prefixGuide = PREFIX_GUIDES.find((guide) => code.startsWith(guide.prefix));
  if (prefixGuide) {
    return { code, ...prefixGuide };
  }

  return {
    code,
    title: toTitleFromCode(code),
    explanation: "This issue code does not yet have a dedicated explanation entry, but it still signals drift or missing governance metadata.",
    remediation: ["Inspect the issue message and the referenced file.", "Repair the smallest relevant GRACE artifact or governed file section before rerunning lint."],
  };
}

export function withLintIssueGuide(issue: LintIssue): LintIssue {
  const guide = getLintIssueGuide(issue.code);
  return {
    ...issue,
    title: guide.title,
    explanation: guide.explanation,
    remediation: guide.remediation,
  };
}

export function formatLintExplanation(code: string) {
  const guide = getLintIssueGuide(code);
  return [
    "GRACE Lint Issue Guide",
    "======================",
    `Code: ${guide.code}`,
    `Title: ${guide.title}`,
    "",
    "Explanation",
    guide.explanation,
    "",
    "Remediation",
    ...guide.remediation.map((item) => `- ${item}`),
  ].join("\n");
}
