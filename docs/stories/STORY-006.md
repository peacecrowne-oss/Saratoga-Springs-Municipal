# STORY-006 — Develop Permitting Process for Code Enforcement

As a code enforcement officer, I want to manage code enforcement permits, so that I can ensure compliance with regulations.

**Release:** r2 · Permitting and Licensing Module (weeks 9–12)
**Owner:** Code Enforcement Officer
**Blocked by:** STORY-004

## The requirement this satisfies

- **REQ-007** (Functional, must) — The system must support permitting processes including Code Enforcement, Planning, Building, Business Licensing, ACE Court, reimbursement agreements, and public-improvement/engineering/utility permits.

## How to build it

Create workflows for code enforcement permit applications, approvals, and rejections.

## Failure paths you must handle

- Permit application submission errors.
- Approval process failures.
- Regulatory compliance issues.

## Where this fits

**Workspace:** Permitting Dashboard · approve

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a code enforcement permit application is submitted, when I review it, then I should be able to approve or reject it.
- [x] Given a permit is approved, when I check the system, then it should reflect the approved status.
- [x] Trust: Ensure all permit actions are logged for audit.

_REQ-007's other permit types are not built. The compliance checks (code section verified, site inspected) and the rule that nobody decides their own application are working assumptions for the City to confirm._

When every box above is ticked, stop and show the demo.
