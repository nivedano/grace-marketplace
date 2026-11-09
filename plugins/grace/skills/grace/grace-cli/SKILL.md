---
name: grace-cli
description: Operate the GRACE 4 CLI for .grace linting, status, module navigation, verification navigation, change archiving, and file-local semantic markup.
---

<skill>
<installation_contract>Invoke the installed stable `grace` binary directly. If it is missing, install it with `bun add -g @osovv/grace-cli`. Do not default to `bunx`, `npx`, or the `rc` dist-tag.</installation_contract>

<commands>
- Active-baseline preflight before observed writes: `grace lint --path PROJECT --assertions current`
- Selected baseline: `grace lint --path PROJECT --change C-ID --assertions baseline` (add `--run-commands` when the baseline declares `MustPassCommand`)
- Draft baseline before the audit: `grace lint --path PROJECT --change C-ID --assertions baseline --draft` (add `--run-commands` when the baseline declares `MustPassCommand`)
- Selected target: `grace lint --path PROJECT --change C-ID --assertions target --run-commands`
- Final execution gate: `grace lint --path PROJECT --change C-ID --assertions final --run-commands`
- Parallel preflight: `grace lint --path PROJECT --parallel-preflight`
- Status: `grace status --path PROJECT --with modules --json`
- Navigation: `grace module find|show`, `grace verification find|show`, and `grace file show`.
- Archive an applied bundle: `grace archive --path PROJECT --change C-ID`
</commands>

<archive_contract>
`grace archive` verifies every precondition before it writes one byte, so a refusal is never a partial archive. It requires the most recent run recorded for the change in `final` assertion mode to have status `passed`; a plan declaring no `MustPassCommand` records no run and cannot be archived until the gate records one. When `meta.json` records a `head`, the run must have started at the current HEAD with `dirty` false, and the worktree must hold no tracked or untracked change outside the bundle; commit all work before the final gate. A run with no recorded `head` (outside git, or `meta.json` before schema 1.1.0) matches run identity only, and the command warns that it cannot confirm the evidence describes the current tree. It refuses when the git index holds staged files outside the bundle, runs the committed-scope check and refuses on its error-severity issues (warnings never refuse; the report is `committedScope` in its text and JSON output), flips the root `status` attribute of `spec.xml` and `plan.xml` from `approved` to `applied` with a targeted textual edit that never reformats the XML, then moves the bundle to `.grace/changes/archive/C-ID` with `git mv` (staged, never committed) or a filesystem rename when git does not track it; because the committed-scope check refuses a bundle with no committed approval, the filesystem rename happens only outside a git worktree or in a shallow clone. A failed move rolls the status flip back in the worktree and resets the bundle index entries to HEAD, so a refusal can never leave `applied` staged at the active path.
</archive_contract>

<command_run_contract>
`--run-commands` executes each declared `MustPassCommand` value once per lint, fail-fast, with a default 600s per-command timeout (`--command-timeout SECONDS` overrides, `0` disables). Plan, progress, and per-command result lines go to stderr; the lint report and JSON go to stdout, so piping stdout stays safe. Agents and pipes get compact output by default; interactive terminals see live streamed command output. Force modes with `--verbose` (live) or `--quiet` (compact); they are mutually exclusive, and `--format json` is always compact. Full combined output of every command is stored per run under `~/.cache/grace/run-commands/<project>/runs/<run>/` (respecting `XDG_CACHE_HOME`) with a machine-readable `meta.json`; failing commands print a bounded output tail plus the absolute log path. `meta.json` records the VCS identity the run executed against (`head`, `branch`, `dirty`, all null outside a git repository) plus the writing `pid`; it is written at run start with status `running` and rewritten on completion, and a `running` record whose process is gone is reclassified as `killed` on a later run. Pruning keeps the newest passing run of every change indefinitely, so the evidence an archived change cites stays on disk; the retention count applies only to non-passing runs — failed, timed out, interrupted, superseded by a newer pass of the same change, unbound to a change, or missing a readable `meta.json`. The count defaults to 10, is set project-wide by `runLogRetention` in `.grace-lint.json`, and is overridden per run by `--keepRuns N`. `--keepRuns 0` keeps no non-passing runs at all, which deletes the current run as soon as it fails and leaves its printed log path dangling. Interrupted runs (SIGINT/SIGTERM) kill the whole command process group, record `interrupted` status in meta.json, and exit 130.</command_run_contract>

<lifecycle_command_contract>`current` evaluates active approved baselines and is not end-state evidence. Keep `MustPassCommand` entries as leaf project checks; do not nest `grace lint`, `grace status`, or another GRACE lifecycle command inside plan assertions. Run selected target/final lint externally.</lifecycle_command_contract>

<draft_baseline_contract>
`--draft` applies only with `--assertions baseline`; with `current`, `target` or `final` it is an `invalid-arguments` error. It also selects a bundle whose identity-matched `plan.xml` is `draft` beside a `draft` or `approved` `spec.xml`, and evaluates `BaselineAssertions` as for an approved plan, `--run-commands` included; on an approved pair it changes nothing. Without `--draft`, a draft `plan.xml` is `assertion.change-not-approved`, as is a missing bundle or `plan.xml` with or without it. The JSON result carries `selectedPlanStatus` (`approved` or `draft`), the text report prints `Selected plan: draft` for a draft, and the run log's `meta.json` records `selectedPlanStatus` from schema 1.2.0. Never use a draft-baseline run as the execution baseline; `grace archive` accepts only a passed `final` run.
</draft_baseline_contract>

<failure_contract>
Lint, status, and navigation commands validate before returning records. JSON argument/runtime failures are one `{ "schemaVersion": "1.0.0", "ok": false, "error": { ... } }` object on stdout. Text failures are one concise actionable line with a nonzero exit code and no stack trace.
</failure_contract>

<committed_scope_contract>
`--change C-ID --assertions final` also runs the committed-scope check and adds a `committedScope` section to the text and JSON report. The check classifies each commit from the bundle's first commit that contains `spec.xml` or `plan.xml` against the `ObservedWriteScope` of the approved plan. Other assertion modes skip it.
Errors:
- `scope.committed-outside`: a commit carrying the change's `Change` trailer wrote a file outside the final `ObservedWriteScope`, or in it but never admitted.
- `scope.widening-with-code`: a widening commit that admitted a file also wrote outside `.grace/`.
- `scope.written-before-widening`: a file was written in the widening commit that admitted it, before that commit, or before the re-approval that admitted it.
- `scope.written-before-approval`: a commit carrying the change's `Change` trailer wrote a file before the plan was approved.
- `scope.approved-plan-mutated`: an approved plan changed outside `ObservedWriteScope` without a re-approval, in a direct section other than `ImplementationPlan` or `IntentSummary`, in section order, or with `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` nested inside either of those sections.
- `scope.reapproval-after-write`: a re-approval followed the first commit carrying the change's `Change` trailer that wrote a file outside `.grace/` and outside `committedScopeExempt`.
- `scope.approval-uncommitted`: no commit has `plan.xml` committed as `approved`; commit the approved `plan.xml`. Writes committed before it are reported as `scope.written-before-approval`.
- `scope.no-owned-commits`: the scope is not `<None />` and no commit carries the `Change: <C-ID>` trailer; an error when `requireChangeTrailers` is `true`, otherwise a warning.
- `scope.committed-check-failed`: a git command the check needs failed, for example a dubious-ownership refusal; the message names the command and carries git's stderr.
Treat a committed-scope error other than `scope.approval-uncommitted` and `scope.committed-check-failed` as fixed in history, since no new commit clears it: stop and report it to the user, who chooses between rewriting unpublished history and superseding the bundle.
Warnings:
- `scope.approved-plan-amended`: an approved plan changed outside `ObservedWriteScope` only in `ImplementationPlan` or `IntentSummary`, with no `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` nested inside either version; the report lists each such commit under `amendments`.
- `scope.reapproval-widened`: a re-approval added `ObservedWriteScope` entries.
- `scope.reapproval-changed-gates`: a re-approval changed `BaselineAssertions`, `TargetAssertions`, `DurableScope` or another section outside `ObservedWriteScope`, `ImplementationPlan` and `IntentSummary` relative to the last approved version; the report lists each such commit under `reapprovalChangedGates`.
- `scope.widened-far`: an admitted file lies outside the directories and packages of the approved scope.
- `scope.untagged-commit`: a commit without an effective `Change` trailer touched a file in the final scope; a merge commit, or a trailer naming no active bundle, counts as untagged.
- `scope.committed-check-skipped`: no `.git` is found at or above the project root, or the clone is shallow.
Set `requireChangeTrailers` (boolean) in `.grace-lint.json`; it defaults to `false`.
Set `committedScopeExempt` (array of globs in the `ObservedWriteScope` glob grammar, for example `["tracker/**"]`) in `.grace-lint.json`; matching files are listed under `exempt` in the `committedScope` report and are never classified or counted as writes outside `.grace/`. An invalid value raises `config.invalid-committed-scope-exempt`.
`grace status` derives `approved-scope-widening-pending` for an uncommitted `ObservedWriteScope`-only widening of an approved plan, with the next action "Commit the widening on its own, touching nothing outside .grace/, before writing the newly admitted files.", and `approved-plan-amendment-pending` for an uncommitted amendment (optionally with a superset widening), with the next action "Commit the amendment on its own, touching nothing outside .grace/, with the user's agreement in its body." An edit to any other section of an approved `plan.xml`, a narrowed `ObservedWriteScope`, or any edit to `spec.xml` stays `approved-contract-drift` for a `spec.xml` approved in `HEAD`, a hard stop; only a status-only return to `draft` is `return-pending-commit`. Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`. Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them. Write the admitted files only after that commit.
</committed_scope_contract>

<status_contract>
`grace status` derives four per-change states for the approval:
- `awaiting-approval`: `spec.xml` and `plan.xml` are both `draft`; the next action is the draft baseline lint and `$grace-brief`, then the owner's approval of spec and plan together.
- `approval-pending-commit`: against `HEAD`, `plan.xml` changed from `draft` to `approved`, and `spec.xml` is `approved` in `HEAD` and unchanged or changed from `draft` to `approved` with it; the next action is to commit the approval, touching only `.grace/`, with its record. While it holds, the bundle's `ObservedWriteScope` explains no file outside the bundle directory.
- `return-pending-commit`: `plan.xml`, and `spec.xml` when it returns too, is `approved` in `HEAD`, `draft` in the working tree, and differs from `HEAD` only in the root `status` attribute; the next action is to commit the return on its own, touching only `.grace/`, naming who asked. A return that also changes content stays `approved-contract-drift`.
- `half-approval`: against `HEAD`, `spec.xml` changed from `draft` to `approved` while `plan.xml` is `draft`; an error that fails `--fail-on errors`, with the next action to approve spec and plan together, or neither: restore the spec to draft.
`approval-pending-commit`, `return-pending-commit` and `half-approval` compare against `HEAD`; without a `HEAD` none of them applies. `approval-pending-commit` and `return-pending-commit` remove `ready-to-execute`. The next action of `ready-to-execute` is to await the owner's explicit execution order, then run `$grace-execute`. A `spec.xml` or `plan.xml` that is `draft` in the working tree and `draft` or untracked in `HEAD` is explained by its bundle, and so is the bundle's `design-context.xml` while `plan.xml` is not `approved` in `HEAD`; none of them is unexplained drift.
</status_contract>

<runtime_contract>
TypeScript/JavaScript analysis is bundled. Python and Dart governed files require their runtimes on PATH; missing runtimes fail closed with actionable `analysis.runtime-missing` diagnostics instead of silently dropping parity checks.
</runtime_contract>

<scenario_evidence_contract>
`grace status` prints a `Scenario Evidence` section, carried in JSON as `scenarioEvidence` with a per-entry breakdown. Scanned files are the code-extension files outside ignored directories plus the files in every entry's `<TestFiles>`, minus any path with a segment starting with `.`. Totals: `scenarios` (all), `executable` (has an `SC-*` id referenced from a scanned file), `manualOnly` (has an id, no reference, and `<ManualEvidence>`), `unproven` (has an id, neither a reference nor `<ManualEvidence>`), `legacy` (no id). The text lists up to 20 `unproven` scenarios. `grace lint` raises errors `verification.scenario-duplicate-id` (one id on two scenarios), `verification.scenario-invalid-id` (malformed id, a second id element, or an entry part that differs from the enclosing `V-M-*`) and `verification.scenario-dangling-reference` (a scanned file holds an `SC-*` token naming an existing `V-M-*` entry that has no such scenario). A missing id or missing evidence is reported by `grace status` only, never by `grace lint`.
</scenario_evidence_contract>

<migration_boundary>GRACE 4 commands do not dual-validate legacy GRACE 3 docs. Use `grace-migrate`.</migration_boundary>
</skill>
