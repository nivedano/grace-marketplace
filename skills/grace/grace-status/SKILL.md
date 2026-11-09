---
name: grace-status
description: Show GRACE 4 project health across .grace context, graph, verification, active changes, scopes, and migration boundaries.
---

<skill>
<task>Run `grace status --path PROJECT --json` and report current GRACE 4 state without mutating artifacts. Module-health summary counts are always evaluated; add `--with modules` only when detailed module records are needed.</task>

<must_report>
- Project kind: GRACE 4, legacy GRACE 3 migration candidate, or missing GRACE; plus context completeness.
- Graph/verification projection integrity, routed coverage, and module counts.
- Active/archive bundle statuses and derived states.
- `needs-plan`, `needs-plan-approval`, `stale-plan`, `integrity-issues`, and `ready-to-execute` with readiness mutually exclusive from stale/integrity states.
- The approval states: `awaiting-approval` (`spec.xml` and `plan.xml` both `draft`), `approval-pending-commit` (`plan.xml` set to `approved`, uncommitted), `return-pending-commit` (an approved artifact returned to `draft` by its root `status` alone, uncommitted), and `half-approval` (`spec.xml` set to `approved` while `plan.xml` is `draft`; an error that fails `--fail-on errors`).
- `ready-to-execute` as awaiting the owner's explicit execution order.
- Route-aware explained/unexplained drift, scope coexistence warnings, and parallel blockers.
- Module-health load failure as integrity/degraded status rather than a crash.
- The next safe action: lint, migrate, specify, plan, audit through `$grace-brief`, commit a pending approval or return, await the owner's execution order, or execute.
</must_report>

<commands>
- Pre-implementation active-baseline integrity: `grace lint --path PROJECT --assertions current`
- Parallel decision: `grace lint --path PROJECT --parallel-preflight`
- Status snapshot: `grace status --path PROJECT --with modules --json --fail-on errors`
</commands>

<hard_rules>Do not edit XML statuses. A draft spec without a plan is normal, and so is a draft pair (`spec.xml` and `plan.xml` both `draft`) awaiting the `$grace-brief` audit; an approved spec without a plan needs planning. A stale or integrity-invalid approved plan is never ready. Start `$grace-execute` only on a separate explicit owner order: the approval is not the execution order, even when both arrive in one message, unless the message says to execute.</hard_rules>
</skill>
