# STORY-012 — STORY-012 · Develop Reporting Tools for Asset and Permitting Data

As a data analyst, I want pre-defined and ad-hoc reporting tools, so that I can analyze asset and permitting data effectively.

**Release:** r3 · Release 3 · Advanced Reporting and User Management (weeks 5–5)
**Owner:** data_analyst
**Blocked by:** STORY-007

## The requirement this satisfies

_No requirement linked._

## How to build it

## Read this first
Your workspace repo is still being set up, so the full requirements are not on disk yet.
Everything you need for THIS task is inlined below — work from it directly.
Once the portal finishes provisioning, the full documents will be in your repo.

## What we're building
Saratoga Springs Municipal Asset Management and Permitting Software Solution — A comprehensive system to manage municipal assets and permits, integrating with existing systems and enhancing operational efficiency.
You are in Release r3 · Advanced Reporting and User Management (weeks 13–16).
This release lands when: Display customizable dashboards and demonstrate role-based access control.

## Your task
STORY-012 — Develop Reporting Tools for Asset and Permitting Data
As a data analyst, I want pre-defined and ad-hoc reporting tools, so that I can analyze asset and permitting data effectively.
Owning agent(s): data_analyst

## The requirement this satisfies
REQ-012 (FUNC, must) — "The system must offer pre-defined and ad-hoc reporting tools to analyze asset and permitting data."

## Guardrails that apply to the WHOLE project
These hold regardless of which story you are on. If this task would break one,
stop and say so rather than working around it.

- The system must provide role-based access control to restrict functionalities based on user roles.
- The system must maintain audit trails to track user actions and changes.

## How we build here
Implement reporting tool interfaces and ensure data sources are correctly linked for report generation.

Walking skeleton first, then harden. Small, testable, reversible steps. Every external
call gets an explicit timeout and capped retries. Every side effect is idempotent —
running it twice must not double-charge, double-email, or double-create.

## Where this sits in the build
This story waits on these — they are already specified, reuse them, do not rebuild them:
- STORY-009 · Implement Role-Based Access Control

This is the last story in the plan.

## Failure paths you must handle
- Report generation failure
- Incorrect data display
- Audit trail logging failure

## Acceptance — your stop condition
- Given the system has pre-defined reports, when I select a report, then I should see the report data displayed accurately.
- Given the system allows ad-hoc report creation, when I create a new report, then I should see the custom report data displayed accurately.
- Trust: All report generation actions must be logged in the audit trail.

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
- The commit message names the story: `STORY-012: <what you did>`. The platform reads that to track your progress.
- A junior developer can read the change and understand why it is correct.
- When you are finished, tell me your confidence as a percentage that this story is
  complete and correct, and what would raise it.

## When you finish: record what this story taught the project
Before you start, read `.colaberry/plan.json` and `docs/stories/STORY-000.md` (the section
"What the platform understands about this project"). That is the current truth. Note anything
this story adds to it: a system it turns out to talk to, a decision you had to make, a limit you
discovered, a role or approval point that appeared.

When the acceptance criteria pass, write `.colaberry/enrichment/STORY-012.json` with exactly this shape:

```
{
  "schemaVersion": "1",
  "projectId": "57d39200-48c4-474f-9aaf-46e236476363",
  "storyId": "STORY-012",
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

- [ ] Given the system has pre-defined reports, when I select a report, then I should see the report data displayed accurately.
- [ ] Given the system allows ad-hoc report creation, when I create a new report, then I should see the custom report data displayed accurately.
- [ ] Trust: All report generation actions must be logged in the audit trail.

When every box above is ticked, stop and show the demo.
