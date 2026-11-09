---
name: grace-brief
description: Audit a draft GRACE 4 spec-and-plan pair through an independent subagent, present the owner a one-screen brief, and record the owner's approval.
---

<skill>
<purpose>Carry one active bundle from draft `spec.xml` and `plan.xml` to the owner's approval: draft checks, independent audit, brief, owner decision, approval commit. Do not implement code or execute the plan.</purpose>

<preflight>
- Require `.grace/changes/active/C-ID/` with identity-matched `spec.xml` and `plan.xml` that `grace status --path PROJECT` reports as `awaiting-approval` (both `draft`) or `needs-plan-approval` (`spec.xml` approved, `plan.xml` draft).
- Run `grace lint --path PROJECT --assertions current`.
- Run `grace lint --path PROJECT --change C-ID --assertions baseline --draft`; add `--run-commands` when `BaselineAssertions` declares `MustPassCommand`.
- Run the project's own lint commands.
- Fix every failure in the drafts and rerun the three checks before the audit.
- Commit the draft bundle in a commit that touches only `.grace/` and ends with the `Change: <C-ID>` trailer, so the audit and the approval record name committed artifacts.
</preflight>

<audit_dispatch>
- Dispatch the auditor as a fresh subagent, never a fork of the authoring session.
- Give it only the bundle path and the project root; withhold the authoring conversation and your own summary.
- Use the project's `auditor` preset when installed; otherwise give the fresh subagent the role text of `references/auditor-role.md`.
- In a harness without subagents, run `references/auditor-role.md` yourself and state "self-audited" in the brief and in the approval record.
</audit_dispatch>

<brief_loop>
- Fix every section-D finding in the drafts, rerun `<preflight>` with its commit, and dispatch a fresh audit; show the owner nothing while section D is non-empty.
- Show the owner sections A to C, 60 lines or fewer, in the layout of `references/brief-template.md`, with the paths of `spec.xml` and `plan.xml`.
</brief_loop>

<owner_decision>
- Ask through the harness's question tool, one question per section-C item, your recommendation first.
- End with the approval question. Offer "approve <C-ID>: spec and plan" in state `awaiting-approval`, "approve <C-ID>: plan" in state `needs-plan-approval`, and "send back".
- Record each answer in `design-context.xml` as one `Decision` under `OwnerDecisions`, with `Date`, `Question`, `Chosen`, and one `Rejected` per option not taken; create `design-context.xml` when absent.
- On "send back", or on an answer that changes `spec.xml` or `plan.xml`, amend the drafts in place, rerun from `<preflight>` with its commit, and dispatch a fresh audit. Repeat until the owner approves.
- Discard an approve selection made in a round whose answers change `spec.xml` or `plan.xml`; ask again after the fresh audit.
- Only the owner approves. Treat the selection of an approve option, or a free-text approval naming the change, as the approval statement. Never set `status="approved"` without that statement.
</owner_decision>

<approval_commit>
- Set `status="approved"` on `spec.xml` and `plan.xml` together for "approve <C-ID>: spec and plan", and on `plan.xml` alone for "approve <C-ID>: plan".
- Run `grace status --path PROJECT`; require `approval-pending-commit` and no unexplained files.
- Commit the approval in one commit that touches only `.grace/`, before any commit that writes outside `.grace/`.
- Write the approval record in the commit body, before the final trailer block that carries `Change: <C-ID>`:
  - the theses as presented;
  - each owner decision with the owner's answer;
  - the contradictions found and how each was resolved;
  - the owner's approval statement, quoted with its option text and change id;
  - how the audit ran: an independent subagent or self-audited;
  - the lint runs the brief stood on: the draft bundle commit the audit read, the `--assertions current` result, and the `--assertions baseline --change C-ID --draft` result with whether commands ran;
  - when commands ran, the run-log path and the run's per-command result lines, quoted; when `BaselineAssertions` declares no `MustPassCommand`, "no commands";
  - for a re-approval, the last approved commit compared against, or "plan unchanged apart from its status; no audit ran".
- When `.grace/context` names another place for approval records, write the record there and name that place in the commit body; never write it inside the bundle.
</approval_commit>

<execution_order>
- Start `$grace-execute` only on a separate explicit owner order: the approval is not the execution order, even when both arrive in one message, unless the message says to execute.
- After the approval commit, report the bundle as `ready-to-execute` and wait for that order.
</execution_order>

<return_to_draft>
- Return an approved `plan.xml` to `draft` only on the owner's request or agreement.
- Re-approve only before the first commit of the change that writes outside `.grace/`; the committed-scope check reports a later re-approval as `scope.reapproval-after-write`.
- Before the return, run `git log --format=%h --grep='^Change: <C-ID>$' <approval-commit>..HEAD -- . ':(exclude).grace'`, where `<approval-commit>` is the first commit in which `plan.xml` is `approved`.
- On any output, refuse the return: widen `ObservedWriteScope` or amend `ImplementationPlan` tasks or `IntentSummary` in place as `grace-execute` defines, or supersede the bundle.
- On empty output, set `plan.xml` to `status="draft"` in a commit of its own that changes only the root `status` attribute, touches only `.grace/`, ends with the `Change: <C-ID>` trailer, and names in its body who asked. Make content edits in later commits.
- Keep `spec.xml` approved and run from `<preflight>` in state `needs-plan-approval`. When the owner wants `spec.xml` changed too, return both in that commit and run from `<preflight>` in state `awaiting-approval`.
</return_to_draft>

<reapproval_audit>
- For a `needs-plan-approval` bundle, read the last approved `plan.xml` from git: the newest commit in which it has `status="approved"`.
- When `plan.xml` equals that version apart from its root `status`, dispatch no audit, ask only the approval question, and record "plan unchanged apart from its status; no audit ran".
- Otherwise dispatch the audit; the auditor applies checks 4 and 5 to `plan.xml` as it stands and limits the brief to the change against the last approved `plan.xml`.
- Ask every change of `BaselineAssertions`, `TargetAssertions` or `DurableScope` as a section-C item.
- With no last approved `plan.xml`, audit the pair in full; "approve <C-ID>: plan" still approves `plan.xml` alone, since `spec.xml` is already approved.
</reapproval_audit>
</skill>
