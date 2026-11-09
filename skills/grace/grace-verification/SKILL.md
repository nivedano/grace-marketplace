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
<gate_task_contract>
Reference named project tasks in `MustPassCommand` and `ExpectedCommand` (for example `bun run gate:e2e`) instead of inline `;`-chains. Decompose full gates into granular named tasks (`gate:test`, `gate:typecheck`, `gate:build`, `gate:e2e`) so a selective re-run is just running that task, timeouts map to one coherent unit, and `grace lint --run-commands` reports each gate step with its own timing and log.
</gate_task_contract>
<flake_contract>
A flaky gate is a defect of the verification entry, not a reason to re-run blindly. Diagnose from the per-attempt logs under `~/.cache/grace/run-commands/`. Fix it by decomposing the gate task, adding runner-level retries inside the task itself (for example playwright `--retries`), or quarantining the unstable scenario. Silent manual re-runs are not a fix: grace records every run honestly, and nondeterministic verification undermines assertion evidence.
</flake_contract>
<wire_contracts>
A wire boundary is any byte layout, field encoding, number format, size cap, or ordering rule that crosses a process, device, or repository boundary. Cover each one as follows.
1. Keep one machine-readable contract artifact per boundary in the producing repository. Generate the producer's constants from it or check them against it.
2. Keep an unmodified copy of the artifact in each consuming repository. When the producer publishes a generated JSON rendering of the contract, copy that rendering instead, so a consumer without a parser for the source format adds no dependency.
3. Put a provenance file `<artifact>.source.json` beside each copy, with the fields `repository`, `path`, `commit`, and `sha256`. Keep provenance out of the copy so the copy stays byte-identical.
4. Write the consumer's conformance test to read its values from the copy and to compare the copy's SHA-256 with the recorded `sha256`. Never restate contract values in the test.
5. Run the conformance test on each side under a `<Command>` of the boundary's `V-M-*` entry. Add a `<Scenario>` to that entry naming the artifact and the test. Add that command to the `MustPassCommand` of every plan that touches the boundary.
6. Change a contract as a producer change followed by one change per consumer. In each consumer change, update the copy and its provenance and record the producer commit in `commit`. In the spec of a change that touches a wire boundary, list every repository it affects. In a producer change to a contract, name its consumers.
7. Compare a copy with the producer's file at the recorded `commit` to detect a hand edit that also rewrote `sha256`.
</wire_contracts>
</skill>
