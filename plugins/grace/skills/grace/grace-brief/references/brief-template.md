# Brief and approval record layout

## Brief

Show the owner sections A to C; section D goes to the author alone.

```text
Brief <C-ID>: independent subagent | self-audited (the author audited its own drafts; weaker)
Draft bundle commit: <commit>
Re-approval against: <commit> | none

A. Theses
- <what the change decides> [recorded: <Decision Date>, <Decision Question>]
- <what the change decides> [silent]

B. Shape
Goals <n>, criteria <n>, tasks <n>, verification entries <n>
Orphans: <Goal, Criterion or task by name> | none
AffectedAreas <M-*, ...> against DurableScope and ObservedWriteScope: <one line>

C. Owner decisions
1. <conflict in one line>
   a. <reading> -> <what changes in spec.xml or plan.xml>
   b. <reading> -> <what changes in spec.xml or plan.xml>

D. For the author
- <finding> (<location>)
```

## Approval record

The approval commit body, before the final trailer block.

```text
<subject>

Theses as presented:
- <thesis> [recorded | silent]

Owner decisions:
- <question>: <owner's answer>

Contradictions:
- <finding>: <resolution>

Approval statement: "approve <C-ID>: spec and plan" | "approve <C-ID>: plan" | "<free-text approval>"
Audit: independent subagent | self-audited

Lint runs:
- draft bundle commit: <commit>
- --assertions current: <result>
- --assertions baseline --change <C-ID> --draft: <result>; commands: ran | no commands
- run log: <path>
  <per-command result lines>

Re-approval: compared against <commit> | plan unchanged apart from its status; no audit ran

Change: <C-ID>
```
