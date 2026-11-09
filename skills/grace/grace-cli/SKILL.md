---
name: grace-cli
description: Operate the GRACE 4 CLI for .grace linting, status, module navigation, verification navigation, and file-local semantic markup.
---

<skill>
<installation_contract>Invoke the installed stable `grace` binary directly. If it is missing, install it with `bun add -g @osovv/grace-cli`. Do not default to `bunx`, `npx`, or the `rc` dist-tag.</installation_contract>

<commands>
- Active-baseline preflight before observed writes: `grace lint --path PROJECT --assertions current`
- Selected baseline: `grace lint --path PROJECT --change C-ID --assertions baseline` (add `--run-commands` when the baseline declares `MustPassCommand`)
- Selected target: `grace lint --path PROJECT --change C-ID --assertions target --run-commands`
- Final execution gate: `grace lint --path PROJECT --change C-ID --assertions final --run-commands`
- Parallel preflight: `grace lint --path PROJECT --parallel-preflight`
- Status: `grace status --path PROJECT --with modules --json`
- Navigation: `grace module find|show`, `grace verification find|show`, and `grace file show`.
</commands>

<command_run_contract>
`--run-commands` executes each declared `MustPassCommand` value once per lint, fail-fast, with a default 600s per-command timeout (`--command-timeout SECONDS` overrides, `0` disables). Plan, progress, and per-command result lines go to stderr; the lint report and JSON go to stdout, so piping stdout stays safe. Agents and pipes get compact output by default; interactive terminals see live streamed command output. Force modes with `--verbose` (live) or `--quiet` (compact); they are mutually exclusive, and `--format json` is always compact. Full combined output of every command is stored per run under `~/.cache/grace/run-commands/<project>/runs/<run>/` (respecting `XDG_CACHE_HOME`) with a machine-readable `meta.json`; failing commands print a bounded output tail plus the absolute log path. `meta.json` records the VCS identity the run executed against (`head`, `branch`, `dirty`, all null outside a git repository) plus the writing `pid`; it is written at run start with status `running` and rewritten on completion, and a `running` record whose process is gone is reclassified as `killed` on a later run. Pruning keeps the newest passing run of every change indefinitely, so the evidence an archived change cites stays on disk; the retention count applies only to non-passing runs — failed, timed out, interrupted, superseded by a newer pass of the same change, unbound to a change, or missing a readable `meta.json`. The count defaults to 10, is set project-wide by `runLogRetention` in `.grace-lint.json`, and is overridden per run by `--keepRuns N`. `--keepRuns 0` keeps no non-passing runs at all, which deletes the current run as soon as it fails and leaves its printed log path dangling. Interrupted runs (SIGINT/SIGTERM) kill the whole command process group, record `interrupted` status in meta.json, and exit 130.</command_run_contract>

<lifecycle_command_contract>`current` evaluates active approved baselines and is not end-state evidence. Keep `MustPassCommand` entries as leaf project checks; do not nest `grace lint`, `grace status`, or another GRACE lifecycle command inside plan assertions. Run selected target/final lint externally.</lifecycle_command_contract>

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
- `scope.approval-uncommitted`: no commit has `plan.xml` committed as `approved`; commit the approved `plan.xml`. Writes committed before it are reported as `scope.written-before-approval`.
- `scope.no-owned-commits`: the scope is not `<None />` and no commit carries the `Change: <C-ID>` trailer; an error when `requireChangeTrailers` is `true`, otherwise a warning.
- `scope.committed-check-failed`: a git command the check needs failed, for example a dubious-ownership refusal; the message names the command and carries git's stderr.
Treat a committed-scope error as fixed in history, since no new commit clears it: stop and report it to the user, who chooses between rewriting unpublished history and superseding the bundle.
Warnings:
- `scope.approved-plan-amended`: an approved plan changed outside `ObservedWriteScope` only in `ImplementationPlan` or `IntentSummary`, with no `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` nested inside either version; the report lists each such commit under `amendments`.
- `scope.reapproval-widened`: a re-approval added `ObservedWriteScope` entries.
- `scope.reapproval-changed-gates`: a re-approval changed `BaselineAssertions`, `TargetAssertions` or `DurableScope` relative to the last approved version; the report lists each such commit under `reapprovalChangedGates`.
- `scope.widened-far`: an admitted file lies outside the directories and packages of the approved scope.
- `scope.untagged-commit`: a commit without an effective `Change` trailer touched a file in the final scope; a merge commit, or a trailer naming no active bundle, counts as untagged.
- `scope.committed-check-skipped`: no `.git` is found at or above the project root, or the clone is shallow.
Set `requireChangeTrailers` (boolean) in `.grace-lint.json`; it defaults to `false`.
Set `committedScopeExempt` (array of globs in the `ObservedWriteScope` glob grammar, for example `["tracker/**"]`) in `.grace-lint.json`; matching files are listed under `exempt` in the `committedScope` report and are never classified or counted as writes outside `.grace/`. An invalid value raises `config.invalid-committed-scope-exempt`.
`grace status` derives `approved-scope-widening-pending` for an uncommitted `ObservedWriteScope`-only widening of an approved plan, with the next action "Commit the widening on its own, touching nothing outside .grace/, before writing the newly admitted files.", and `approved-plan-amendment-pending` for an uncommitted amendment (optionally with a superset widening), with the next action "Commit the amendment on its own, touching nothing outside .grace/, with the user's agreement in its body." An edit to any other section of an approved `plan.xml`, a narrowed `ObservedWriteScope`, or any edit to `spec.xml` stays `approved-contract-drift`, a hard stop. Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`. Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them. Write the admitted files only after that commit.
</committed_scope_contract>

<runtime_contract>
TypeScript/JavaScript analysis is bundled. Python and Dart governed files require their runtimes on PATH; missing runtimes fail closed with actionable `analysis.runtime-missing` diagnostics instead of silently dropping parity checks.
</runtime_contract>

<migration_boundary>GRACE 4 commands do not dual-validate legacy GRACE 3 docs. Use `grace-migrate`.</migration_boundary>
</skill>
