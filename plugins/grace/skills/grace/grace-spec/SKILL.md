---
name: grace-spec
description: Interview the user, record the user's decisions in design-context.xml, and draft a GRACE 4 GraceChangeSpec inside .grace/changes/active/C-*/.
---

<skill>
<change_bundle_contract>
`.grace/changes/active/C-CHANGE-ID/`

- `spec.xml` — normative `GraceChangeSpec`
- `design-context.xml` — explanatory only; required once `OwnerDecisions` holds a `Decision`
- `plan.xml` — drafted by `grace-plan` in the same session; `spec.xml` and `plan.xml` are the pair
</change_bundle_contract>

<status_rules>
Create `spec.xml` as `status="draft"`. Set `status="approved"` only when the user explicitly approves the pair at the approval question of `$grace-brief` after the audit. Rejected or cancelled specs move to archive with terminal status. Do not create or edit `plan.xml` in this skill.
</status_rules>

<strict_contract>
The direct `C-*` wrapper must contain exactly one meaningful `Summary`, `Goals`, `Constraints`, `NonGoals`, `AcceptanceCriteria`, `AffectedAreas`, and `VerificationIntent` section. Empty containers are not approval-ready. Semantic anchors are canonical attribute-free XML tags, never attributes or attribute values.
</strict_contract>

<scope_discipline>
Add a `Goal` or `Criterion` only from one of three sources: the user asked for it, the requested result cannot work without it, or it fixes a defect observed within `AffectedAreas`. Confine `Constraints` and `.grace/context` principles to how the result is built; derive no goal from them. Propose to the user, as its own option, any hardening against a failure nobody has observed; record a declined option as a `NonGoal`.
</scope_discipline>

<owner_decisions>
- Record each decision of the user in `design-context.xml` as one `Decision` under `OwnerDecisions`, with `Date`, `Question`, `Chosen`, and one `Rejected` per option not taken, when it is made. `Date` is the day the user decided. Create `design-context.xml` from `references/design-context-template.xml` at the first `Decision`, omitting the template sections you do not fill. Until step 4 of `<workflow>` writes the draft `spec.xml`, lint reports `xml.missing-file` for the bundle's `spec.xml`; expect it during the interview.
- Record a `Decision` for each choice between alternatives, each decline, each boundary the user fixed (scope, platform, what stays untouched), and exactly one consensus `Decision` at the end of the interview whose `Chosen` lists the theses of the design summary the user accepted. Record no accepted `Goal` or `Criterion` one by one.
- Place `OwnerDecisions` as a direct child of the root `GraceChangeDesignContext` when the bundle identity is a `<Change>` element, after `DeferredDecisions` as in `references/design-context-template.xml`; place it as a child of the `C-*` wrapper in the wrapper form.
- Keep `DeferredDecisions` for decisions postponed to a later change.
- `$grace-brief` adds the answers of the audit loop the same way.
</owner_decisions>

<workflow>
1. Create a deterministic uppercase-kebab `C-*` change id from the goal the user states.
2. Ask one focused question at a time until goal, scope, constraints, non-goals, acceptance criteria, affected areas, and verification expectations are clear. Record each decision as `<owner_decisions>` defines.
3. Propose a concise design summary and its technical assumptions, then record the consensus `Decision`. Ask for no approval.
4. Write `spec.xml` from `references/change-spec-template.xml` as `status="draft"`, with exactly one direct `C-*` wrapper and no empty required section. Write `Summary` and `Problem` one sentence per line. Put only technical assumptions in `Assumptions`.
5. If rationale, alternatives, scenarios, or external constraints would otherwise bloat the spec, write them into non-normative `design-context.xml`; create it from its template when absent, omitting the template sections you do not fill.
6. Hand the draft `spec.xml` to `$grace-plan` in the same session.
</workflow>

<hard_rules>
- `spec.xml` is the source of truth for `grace-plan`; design context never adds requirements.
- Do not implement code, mutate current graph/verification state, or create retroactive change bundles.
- Recommend `grace lint --path <project-root> --assertions current` as a pre-implementation active-baseline check after writing the bundle; never present it as target or final evidence.
</hard_rules>
</skill>
