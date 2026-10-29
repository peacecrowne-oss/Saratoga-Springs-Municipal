# STORY-001 — STORY-001 · Integrate Tyler Technologies for Budget Tracking

As a financial manager, I want to integrate with Tyler Technologies, so that I can track budgets and manage costs effectively.

**Release:** r0 · Release 0 · Initial Integration and Trust Spine (weeks 1–1)
**Owner:** financial_manager
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

_No requirement linked._

## How to build it

## Read this first
Your workspace repo is still being set up, so the full requirements are not on disk yet.
Everything you need for THIS task is inlined below — work from it directly.
Once the portal finishes provisioning, the full documents will be in your repo.

## What we're building
Saratoga Springs Municipal Asset Management and Permitting Software Solution — A comprehensive system to manage municipal assets and permits, integrating with existing systems and enhancing operational efficiency.
You are in Release r0 · Initial Integration and Trust Spine (weeks 1–4).
This release lands when: Demonstrate integration with Tyler Technologies and basic asset tracking with audit trail.

## Your task
STORY-001 — Integrate Tyler Technologies for Budget Tracking
As a financial manager, I want to integrate with Tyler Technologies, so that I can track budgets and manage costs effectively.
Owning agent(s): financial_manager

## The requirement this satisfies
REQ-007 (FUNC, must) — "The system must integrate with financial systems for budget tracking and cost management."
REQ-014 (CONSTRAINT, must) — "The system must integrate with Tyler Technologies for municipal asset management and permitting solutions."

## Guardrails that apply to the WHOLE project
These hold regardless of which story you are on. If this task would break one,
stop and say so rather than working around it.

- The system must provide role-based access control to restrict functionalities based on user roles.
- The system must maintain audit trails to track user actions and changes.

## How we build here
Ensure Tyler Technologies integration endpoints are correctly configured for budget data retrieval.

Walking skeleton first, then harden. Small, testable, reversible steps. Every external
call gets an explicit timeout and capped retries. Every side effect is idempotent —
running it twice must not double-charge, double-email, or double-create.

## Where this sits in the build
This is the first story. Nothing exists yet — you are laying the foundation.

Waiting on this one — leave room for it, but do NOT build it now:
- STORY-003 · Implement Asset Inventory Management
- STORY-004 · Integrate GIS for Asset Visualization

## Failure paths you must handle
- Integration failure with Tyler Technologies
- Incorrect budget data retrieval
- Audit trail logging failure

## Acceptance — your stop condition
- Given the system is connected to Tyler Technologies, when I view the budget tracking dashboard, then I should see real-time budget data.
- Given the system is disconnected from Tyler Technologies, when I attempt to view the budget tracking dashboard, then I should receive an error message indicating the integration issue.
- Trust: All budget tracking actions must be logged in the audit trail.

When every line above passes, the task is done — stop the build loop and show me the demo.

## Stop and ask me if
- A guardrail above would have to bend to finish this.
- The requirement turns out to be wrong, or impossible as written. Say so — do not
  silently build something adjacent that passes the tests.
- You need a credential, an account, or access to an external system that you do not have.
- The acceptance criteria cannot be tested as written.
- You are about to change a file outside this story to make it pass.

## Definition of done
- Tests cover the happy path and at least one failure path above.
- No secrets in code, commits, or logs.
- The commit message names the story: `STORY-001: <what you did>`. The platform reads that to track your progress.
- A junior developer can read the change and understand why it is correct.
- When you are finished, tell me your confidence as a percentage that this story is
  complete and correct, and what would raise it.

## When you finish: record what this story taught the project
Before you start, read `.colaberry/plan.json` and `docs/stories/STORY-000.md` (the section
"What the platform understands about this project"). That is the current truth. Note anything
this story adds to it: a system it turns out to talk to, a decision you had to make, a limit you
discovered, a role or approval point that appeared.

When the acceptance criteria pass, write `.colaberry/enrichment/STORY-001.json` with exactly this shape:

```
{
  "schemaVersion": "1",
  "projectId": "57d39200-48c4-474f-9aaf-46e236476363",
  "storyId": "STORY-001",
  "projectTruthBaseRevision": 0,
  "observedAt": "<ISO timestamp>",
  "sourceCommitSha": "<sha of your last commit, or null>",
  "factProposals": [
    {
      "dimension": "integrations",
      "value": "Reads open tickets from the Zendesk API.",
      "evidence": "src/zendesk/client.ts"
    }
  ],
  "decisions": [
    {
      "statement": "Poll every 5 minutes rather than subscribe to webhooks.",
      "rationale": "no webhook access in the sandbox",
      "evidence": "src/poll.ts"
    }
  ],
  "limitations": [
    {
      "statement": "Attachments over 10MB are skipped.",
      "evidence": "src/zendesk/client.ts#L40"
    }
  ],
  "demonstrationEvidence": [
    {
      "kind": "test",
      "ref": "zendesk.client.test.ts"
    }
  ],
  "measurementEvents": []
}
```

Rules for that file:
- Only what this story's work actually shows. Each entry names the file, commit or test that
  proves it. No evidence, no entry.
- `dimension` is one of: problem, desired_outcome, actors, current_workflow, inputs, outputs,
  data, systems, integrations, pain_points, exceptions, approval_points, security_context,
  ai_opportunities, human_only_decisions, assumptions, unknowns, constraints,
  success_definition, delivery_profile.
- Never claim a business result. What the business wanted, what hurt before, what "success"
  means: those are the student's statements, not the build's, and the platform refuses them
  from this file.
- If you found something that contradicts the truth, still write it: the platform files it as
  a question for the student rather than replacing what they confirmed.
- `projectTruthBaseRevision` is `truth_revision` from `.colaberry/manifest.json`, or 0 if absent.
- Commit it with the story. The platform reads it on push; pushing it twice changes nothing.

## How I want you to work
Work as a paced co-pilot. Move one step at a time: propose the next change, wait for me
to confirm, then make it. Never batch several edits together. After each step, tell me
what you did and what the next step is.

## Your workspace repo
Not provisioned yet. Finish repo setup in the portal to get a repo, your requirements on disk, and progress tracking. That repo is public, so keep secrets out of it.

Begin.

## Failure paths you must handle


## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given the system is connected to Tyler Technologies, when I view the budget tracking dashboard, then I should see real-time budget data.
- [ ] Given the system is disconnected from Tyler Technologies, when I attempt to view the budget tracking dashboard, then I should receive an error message indicating the integration issue.
- [ ] Trust: All budget tracking actions must be logged in the audit trail.

When every box above is ticked, stop and show the demo.
