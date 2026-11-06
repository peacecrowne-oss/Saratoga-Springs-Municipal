# STORY-011 — Conduct Final System Testing and User Acceptance

As a project manager, I want to conduct final system testing and user acceptance, so that the system is verified for full deployment.

**Release:** r4 · System Integrations and Final Deployment (weeks 17–20)
**Owner:** Project Manager
**Blocked by:** STORY-010

## The requirement this satisfies

- **REQ-002** (Constraint, must) — The system must be deployed on-premises, with an option for near-real-time database replication to City-managed servers if on-premises is unavailable.
- **REQ-011** (Functional, must) — The system must integrate with Caselle, Granicus/311, ComplianceGO, Bluebeam Revu, Utilisync, and XpressBillPay using native connectors, REST APIs, or flat file exchanges.

## How to build it

Conduct end-to-end testing of the system, including all integrations and functionalities. Ensure user acceptance testing is completed and documented.

## Failure paths you must handle

- Critical issues found during testing
- User acceptance testing fails
- Test report is incomplete

## Where this fits

**Workspace:** Testing Dashboard · review

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given the system is fully developed, when final testing is conducted, then all functionalities should perform as expected.
- [ ] Given the system is tested, when a user performs acceptance testing, then no critical issues should be found.
- [x] Trust: Given the testing phase, when it concludes, then a comprehensive test report is generated.

_Acceptance testing is not done: it needs people to run the 14 scenarios on the Testing Dashboard (`/testing`) and record what they find. Then run `npm run test-report` again. Final testing ran against SIMULATED Tyler, Caselle, ArcGIS and Cityworks stand-ins, not the City's systems._

When every box above is ticked, stop and show the demo.
