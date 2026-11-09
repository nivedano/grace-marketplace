---
name: grace-explainer
description: Explain GRACE 4 methodology, .grace artifacts, semantic anchors, change lifecycle, verification, and migration boundaries.
---

<skill>
<core_model>
GRACE 4 uses `.grace` as the durable project model:

- `.grace/context` stores requirements, technology, principles, deployment, and UX constraints.
- `.grace/graph` stores graph indexes and routed graph documents with `GD-*`, `M-*`, and `DF-*` tags.
- `.grace/verification` stores verification indexes and routed `V-M-*` entries.
- `.grace/changes` stores active and archived `C-*` change bundles with `GraceChangeSpec`, optional non-normative design context, and `GraceChangePlan`.
</core_model>

<workflow>
1. `grace-init` creates the `.grace` skeleton.
2. `grace-spec` interviews the user, records the user's decisions in `design-context.xml`, and writes `spec.xml` as `draft`.
3. `grace-plan` writes `plan.xml` as `draft` in the same session; no approval sits between the two drafts. It holds assertions, scopes, and `T-*` implementation tasks.
4. `grace-brief` runs the draft baseline lint and an independent audit of the draft pair, and shows the owner a one-screen brief; one owner approval sets `spec.xml` and `plan.xml` to `approved` in one commit that touches only `.grace/`.
5. `grace-execute` runs sequential or parallel-safe mode from the approved plan. Start `$grace-execute` only on a separate explicit owner order: the approval is not the execution order, even when both arrive in one message, unless the message says to execute.
6. `grace lint` and `grace status` provide validation and health evidence.
7. Existing GRACE 3 projects use `grace-migrate`; the CLI validates the result but does not convert legacy docs directly.
</workflow>
</skill>
