---
name: grace-reviewer
description: Review GRACE 4 integrity across .grace artifacts, active changes, scopes, assertions, code anchors, and verification evidence.
---

<skill>
<review_checklist>
- `.grace/context` artifacts are present and relevant.
- `.grace/graph/index.xml` routes every graph anchor to the correct graph document.
- `.grace/verification/index.xml` routes deterministic `V-M-*` entries and covers current modules.
- Active change specs/plans use valid statuses for their location and exactly one `C-*` wrapper.
- Baseline and target assertions are meaningful and not stale.
- Durable scopes and observed write scopes are explicit; unsafe parallel overlaps are blocked.
- An optional `ReviewScope` names only the corpus review may amend, never the approved `spec.xml` or `plan.xml`.
- File-local contracts, `LINKS:`, and semantic blocks match durable anchors.
- Verification evidence is fresh and tied to commands or markers.
</review_checklist>

<output>
Return findings with severity, location, why it matters, expected fix direction, and verification target. Do not fix unless explicitly asked.
</output>

<mandated_edits>
An approved plan's optional `ReviewScope` is the explicit ask made in advance: a project that wants review to amend its own corpus declares that corpus there before execution. Edits confined to the declared paths are permitted and are attributed as explained drift; everything outside them stays a finding, including the approved `spec.xml` and `plan.xml`, which review never edits in place. With no `ReviewScope`, nothing is asked for and nothing is fixed.
</mandated_edits>
</skill>
