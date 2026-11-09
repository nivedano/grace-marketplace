---
name: grace-execute
description: Execute an approved GRACE 4 GraceChangePlan in sequential or parallel-safe mode with recovery-aware preflight and centralized durable apply.
---

<skill>
<preflight>
Require one active bundle with approved, identity-matched `spec.xml` and `plan.xml`. Approved plans are immutable. Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`. Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them. Read context, projections, assertions, scopes, task dependencies, and verification before editing. Reject phase-incompatible plans before writes: `MustPassCommand` must be leaf project evidence, and neither target assertions nor post-write task verification may invoke `--assertions current` or nest GRACE lifecycle commands. Supersede and replan instead of editing an approved conflict in place.
</preflight>

<assertion_commands>
- Active-baseline preflight before observed writes: `grace lint --path PROJECT --assertions current`
- Selected baseline: `grace lint --path PROJECT --change C-ID --assertions baseline` (add `--run-commands` when the baseline declares `MustPassCommand`)
- Selected target without commands: `grace lint --path PROJECT --change C-ID --assertions target`
- Selected target with command evidence: `grace lint --path PROJECT --change C-ID --assertions target --run-commands`
- Final end-state validation: `grace lint --path PROJECT --change C-ID --assertions final` (add `--run-commands` when the target declares `MustPassCommand`)
- Parallel preflight: `grace lint --path PROJECT --parallel-preflight`
</assertion_commands>

<mode_selection>
Wait for explicit `sequential` or `parallel-safe` choice. Parallel-safe requires the explicit preflight to pass. Workers never mutate approved plans; only the controller widens and amends. Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`. Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them. Durable `.grace` changes are applied centrally after observed work verifies.
</mode_selection>

<scope_widening>
Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`.
Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them.
1. Stop a task that needs a file outside `ObservedWriteScope`, or whose `ImplementationPlan` entry cannot be carried out as written, and the tasks that depend on it; continue independent tasks.
2. Ask the user. Propose the smallest widening or amendment that still meets the spec.
3. After the user agrees, commit the widening alone; its body names the user's agreement and lists the admitted files. Commit an amendment alone; its body names the user's agreement and the changed tasks.
4. Write the admitted files only after that commit.
5. Change `BaselineAssertions`, `TargetAssertions` and `DurableScope` through a superseding bundle, never in place.
</scope_widening>

<commit_contract>
- End every commit made for a change with one trailer paragraph that holds `Change: <C-ID>`, once per change the commit serves.
- Put `Change: <C-ID>` in the same final paragraph as `Co-Authored-By` and any other trailers, with no blank line and no prose between them.
- Treat a `Change:` line anywhere else as prose; it is not a trailer.
- Commit the approved `plan.xml` in or before the first commit that writes outside `.grace/`.
- Run `grace status` before each commit; stop and report unexplained files.
- Treat a committed-scope error other than `scope.approval-uncommitted` and `scope.committed-check-failed` as fixed in history, since no new commit clears it: stop and report it to the user, who chooses between rewriting unpublished history and superseding the bundle.
</commit_contract>

<recovery_decision_table>
| state | required action |
| clean-to-start | Run selected baseline, then execute tasks. |
| partial-observed-writes | Inspect the declared observed scope and ask whether to resume or revert. |
| durable-state-changed | Hard stop; supersede and replan. Approved assertions are immutable. |
| target-already-satisfied | Run final end-state validation, opted-in command evidence when declared, durable reconciliation, and ask for explicit apply confirmation. |
| unsafe-unknown-drift | Hard stop and report unexplained files. |
</recovery_decision_table>

<execution_rules>
1. Run the selected baseline before implementation, including explicit `--run-commands` when its assertions declare `MustPassCommand`.
2. Execute one dependency-ready task or one verified parallel-safe batch at a time.
3. Run each task's acceptance and verification immediately.
4. Apply approved durable context, graph, and verification changes centrally.
5. Reconcile durable state, commit observed and durable work, run leaf plan gates, then run selected `--assertions final` as the outermost lifecycle gate, including `--run-commands` when `MustPassCommand` is declared. Final mode performs full project lint, evaluates the selected target, keeps unrelated approved baselines active, and does not re-evaluate the selected plan's superseded baseline.
6. Ask for explicit apply confirmation after fresh end-state evidence passes.
7. Only then archive the complete bundle with `grace archive --path PROJECT --change C-ID`, which sets spec and plan to `applied`.
8. Never edit approved assertions or `DurableScope` in place, bypass stale evidence, or continue through unknown drift. Widen `ObservedWriteScope` of an approved plan only after the user agrees, in a commit that touches only `.grace/`. Amend `ImplementationPlan` tasks or `IntentSummary` of an approved plan only after the user agrees, in a commit that touches only `.grace/`; never place `BaselineAssertions`, `TargetAssertions`, `DurableScope` or `ObservedWriteScope` inside them.
</execution_rules>
</skill>
