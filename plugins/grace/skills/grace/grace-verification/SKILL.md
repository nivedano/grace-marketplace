---
name: grace-verification
description: Design and maintain GRACE 4 verification entries, commands, scenarios, markers, and assertion evidence under .grace/verification.
---

<skill>
<purpose>
Strengthen deterministic verification for modules and changes. Verification state lives in `.grace/verification/index.xml` and routed verification documents. Each durable module should have deterministic `V-M-*` coverage unless an explicit exception is planned.
</purpose>

<workflow>
1. Read relevant `.grace/graph` anchors and current `V-M-*` entries.
2. Identify scenarios, commands, test files, required log markers, and trace assertions.
3. Ensure commands are deterministic and runnable from the project root or documented cwd.
4. Update or propose `.grace/verification` changes through the active change plan.
5. Run the commands and record fresh evidence in the response.
</workflow>
<cwd_contract>
When verification commands run from a workspace or package directory, add one direct `<Cwd>relative/project/path</Cwd>` child to the owning `V-M-*` entry. Keep declared `<TestFiles><File>...</File></TestFiles>` paths project-root-relative; the CLI uses `Cwd` only to compare them with cwd-relative command arguments.
</cwd_contract>
<evidence_contract>
Use `<Marker>` when module health must prove a runtime log or trace emission from linked implementation code. Use `<TraceAssertion>` for deterministic test or trace evidence that does not require runtime logging, such as pure functions, type-level modules, and core libraries. A non-empty marker or trace assertion satisfies the module-health evidence requirement; only authored markers require matching runtime emission and `BLOCK_*` evidence.
</evidence_contract>
<scenario_ids>
Give every `<Scenario>` that a change adds or edits one empty id element `<SC-<entry>-NNN />` as its first child. `<entry>` is the enclosing `V-M-*` id without the `V-M-` prefix; `NNN` is the next free three-digit number in that entry (`V-M-FW-MAIN` yields `SC-FW-MAIN-001`, then `SC-FW-MAIN-002`). Then do one of:
- Write the id into the test that proves the scenario, inside a comment, a string, or a test display name, and list that test in the entry's `<TestFiles>`. Separate the id from adjacent text by whitespace or by punctuation other than `-`, `_` and `.`; `<!--SC-FW-MAIN-002-->` and `SC-FW-MAIN-002-boot` do not count as evidence.
- Add `<ManualEvidence>text</ManualEvidence>` inside the `<Scenario>`, naming who or what confirms it outside any `<Command>` (the device boot log, the bench, an owner check).
Leave untouched scenarios without an id.
</scenario_ids>
<gate_task_contract>
Reference named project tasks in `MustPassCommand` and `ExpectedCommand` (for example `bun run gate:e2e`) instead of inline `;`-chains. Decompose full gates into granular named tasks (`gate:test`, `gate:typecheck`, `gate:build`, `gate:e2e`) so a selective re-run is just running that task, timeouts map to one coherent unit, and `grace lint --run-commands` reports each gate step with its own timing and log.
</gate_task_contract>
<flake_contract>
A flaky gate is a defect of the verification entry, not a reason to re-run blindly. Diagnose from the per-attempt logs under `~/.cache/grace/run-commands/`. Fix it by decomposing the gate task, adding runner-level retries inside the task itself (for example playwright `--retries`), or quarantining the unstable scenario. Silent manual re-runs are not a fix: grace records every run honestly, and nondeterministic verification undermines assertion evidence.
</flake_contract>
</skill>
