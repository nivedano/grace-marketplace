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
`--run-commands` executes each declared `MustPassCommand` value once per lint, fail-fast, with a default 600s per-command timeout (`--command-timeout SECONDS` overrides, `0` disables). Plan, progress, and per-command result lines go to stderr; the lint report and JSON go to stdout, so piping stdout stays safe. Agents and pipes get compact output by default; interactive terminals see live streamed command output. Force modes with `--verbose` (live) or `--quiet` (compact); they are mutually exclusive, and `--format json` is always compact. Full combined output of every command is stored per run under `~/.cache/grace/run-commands/<project>/runs/<run>/` (respecting `XDG_CACHE_HOME`) with a machine-readable `meta.json`; failing commands print a bounded output tail plus the absolute log path. Interrupted runs (SIGINT/SIGTERM) kill the whole command process group, record `interrupted` status in meta.json, and exit 130.

Two opt-in modifiers change only what a gate attempts. `--only-failed RUN` re-runs just the commands a previous run did not pass, where `RUN` is a run directory name, an absolute run directory path, or `last`; a command counts as passed only when it ran to completion with exit code zero, so skipped and timed-out commands are re-run. The resumed gate always writes a new run directory, carries each already-passing command into it with its earlier log and a `resumedFrom` pointer to the resolved run directory (present in `meta.json` and in the `--format json` command evidence, so carried results are never mistaken for fresh ones), and refuses outright — without creating a run directory — when the referenced run is missing, unreadable, or recorded a different project, change, assertion mode, or declared command list. That command-list check is the fallback identity guard: `meta.json` does not yet record the checked-out tree, so a resume is only as safe as the fact that the same commands are declared in the same order. Re-verify with a full `--run-commands` gate before treating a resumed green as final evidence. `--continue-on-failure` attempts every declared command in one pass instead of skipping the remainder, so one run collects every failure; the summary still names the first failure as the reason the run is red.
</command_run_contract>

<lifecycle_command_contract>`current` evaluates active approved baselines and is not end-state evidence. Keep `MustPassCommand` entries as leaf project checks; do not nest `grace lint`, `grace status`, or another GRACE lifecycle command inside plan assertions. Run selected target/final lint externally.</lifecycle_command_contract>

<failure_contract>
Lint, status, and navigation commands validate before returning records. JSON argument/runtime failures are one `{ "schemaVersion": "1.0.0", "ok": false, "error": { ... } }` object on stdout. Text failures are one concise actionable line with a nonzero exit code and no stack trace.
</failure_contract>

<runtime_contract>
TypeScript/JavaScript analysis is bundled. Python and Dart governed files require their runtimes on PATH; missing runtimes fail closed with actionable `analysis.runtime-missing` diagnostics instead of silently dropping parity checks.
</runtime_contract>

<migration_boundary>GRACE 4 commands do not dual-validate legacy GRACE 3 docs. Use `grace-migrate`.</migration_boundary>
</skill>
