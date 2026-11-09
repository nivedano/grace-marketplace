---
name: grace-setup-subagents
description: Create GRACE 4 worker and reviewer subagent presets that understand .grace artifacts, scopes, assertions, and verification evidence.
---

<skill>
<subagent_requirements>
Generated subagents must be told to:

- read `.grace/context`, `.grace/graph`, `.grace/verification`, and relevant `.grace/changes` packets explicitly;
- treat `spec.xml` as normative and design context as non-normative;
- respect `DurableScope`, `ObservedWriteScope`, `BaselineAssertions`, and `TargetAssertions`;
- never mutate approved plans or XML statuses without controller approval;
- return verification evidence and scoped graph/verification deltas.
</subagent_requirements>

<roles>
Install each preset from `references/roles/<role>.md`:

- `module-implementer`: implements one planned module or bounded module slice inside its write scope;
- `contract-reviewer`: verifies one module implementation against its approved contract;
- `verification-reviewer`: decides whether a module's automated verification suffices for autonomous execution;
- `fixer`: repairs one failure packet inside the assigned write scope;
- `auditor`: audits one draft change bundle against the owner's recorded decisions and the project's rules, and returns its brief; read-only.
</roles>
</skill>
