# STORY-001 — Deploy Initial System with Core Functionalities

As an IT administrator, I want to deploy the initial system with core functionalities, so that the system is ready for further integrations and use.

**Release:** r0 · Initial Setup and Core Integration (weeks 1–4)
**Owner:** IT Administrator
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-002** (Constraint, must) — The system must be deployed on-premises, with an option for near-real-time database replication to City-managed servers if on-premises is unavailable.
- **REQ-010** (Safety, must) — The system must integrate with the City’s Windows Active Directory for single sign-on and two-factor authentication, and document PII handling in the security architecture.

## How to build it

Deploy the system on-premises ensuring core functionalities are operational. Verify integration with Windows Active Directory for authentication.

## Failure paths you must handle

- Deployment fails due to network issues
- Core functionality does not initialize
- Audit log entry is not created

## Where this fits

**Workspace:** System Dashboard

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given the system is ready for deployment, when the deployment process is initiated, then the system should be operational with core functionalities.
- [x] Given the system is deployed, when a core functionality is accessed, then it should perform as expected.
- [x] Trust: Given the deployment process, when it completes, then an audit log entry is created with deployment details.

When every box above is ticked, stop and show the demo.
