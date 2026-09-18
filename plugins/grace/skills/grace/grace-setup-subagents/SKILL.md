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
- supervise every verification job as one invocation recording job id, process identity, start time, deadline (the command's declared budget where one exists, otherwise `--command-timeout`, default 600s), output path, and exit status; treat empty output as a diagnosis trigger, read the job's own exit status before concluding anything, never launch a second copy of a job that may still hold the substrate, and on deadline kill the process group, report it, and do not retry silently;
- return verification evidence and scoped graph/verification deltas.
</subagent_requirements>
</skill>
