# STORY-007 — Public Portal for Permit Applications

As a resident, I want to submit permit applications online, so that I can interact with the city conveniently.

**Release:** r2 · Permitting and Licensing Module (weeks 9–12)
**Owner:** Resident
**Blocked by:** STORY-006

## The requirement this satisfies

- **REQ-007** (Functional, must) — The system must support permitting processes including Code Enforcement, Planning, Building, Business Licensing, ACE Court, reimbursement agreements, and public-improvement/engineering/utility permits.

## How to build it

Develop a public-facing portal for residents to submit applications and schedule inspections.

## Failure paths you must handle

- Portal access issues.
- Application submission errors.
- Notification delivery failures.

## Where this fits

**Workspace:** Public Portal · submit

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given I access the public portal, when I submit a permit application, then I should receive a confirmation notification.
- [ ] Given I schedule an inspection, when I check the portal, then I should see the scheduled date.
- [ ] Trust: Ensure all public interactions are logged for audit.

When every box above is ticked, stop and show the demo.
