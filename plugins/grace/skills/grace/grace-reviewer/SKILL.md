---
name: grace-reviewer
description: Review GRACE 4 integrity across .grace artifacts, active changes, scopes, assertions, code anchors, and verification evidence.
---

<skill>
<scope_widening_review>
- Read `committedScope` from the final `grace lint` output or the `grace archive` output; it lists `ObservedWriteScope` widenings, amendments and exempt files.
- Return each `far` file (`widenedFar`) and each re-approval addition (`reapprovalAdded`) as a finding for the archive commit body: who asked, who agreed, why the plan missed the file, and whether the miss was avoidable.
- Return each `amendments` entry as a finding for the archive commit body: who asked, who agreed, why the plan changed.
- Return each `reapprovalChangedGates` entry as a finding for the archive commit body: who asked, who agreed, which gate sections changed, and why no superseding bundle was created.
- State that there were none when `ownedCommits` is above 0, `skipped` is unset, and `widenedFar`, `reapprovalAdded`, `amendments` and `reapprovalChangedGates` are empty.
- State that nothing was classified when `ownedCommits` is 0 or `skipped` is set, and quote the `scope.no-owned-commits` or `scope.committed-check-skipped` warning.
</scope_widening_review>

<review_checklist>
- `.grace/context` artifacts are present and relevant.
- `.grace/graph/index.xml` routes every graph anchor to the correct graph document.
- Confirm every `<Scenario>` the change added or edited has an `SC-<entry>-NNN` id and reads `executable` or `manualOnly` in `grace status --json` `scenarioEvidence`. Report a finding for a `manualOnly` scenario that a `<Command>` could prove, and for a referenced test that no `<Command>` of its entry runs.
- `.grace/verification/index.xml` routes deterministic `V-M-*` entries and covers current modules.
- Active change specs/plans use valid statuses for their location and exactly one `C-*` wrapper.
- Baseline and target assertions are meaningful and not stale.
- Durable scopes and observed write scopes are explicit; unsafe parallel overlaps are blocked.
- File-local contracts, `LINKS:`, and semantic blocks match durable anchors.
- Verification evidence is fresh and tied to commands or markers.
- Even in valid artifacts, issue a finding for any task, check, or scenario that neither serves a spec `Criterion` nor protects existing behavior within `AffectedAreas`, for a duplicate check, and for a new mechanism where an existing one serves.
</review_checklist>

<output>
Return findings with severity, location, why it matters, expected fix direction, and verification target. Do not fix unless explicitly asked.
</output>
</skill>
