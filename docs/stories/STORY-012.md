# STORY-012 — Enhance Security Protocols for User Authentication

As a system administrator, I want to enhance security protocols, so that user authentication is more secure and compliant with industry standards.

**Release:** r3 · Security and Authentication Enhancements (weeks 13–16)
**Owner:** System Administrator
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-010** (Safety, must) — The system must integrate with the City’s Windows Active Directory for single sign-on and two-factor authentication, and document PII handling in the security architecture.

## How to build it

Implement multi-factor authentication and ensure all login attempts are logged with necessary details for security audits.

## Failure paths you must handle

- Incorrect password entry
- Multi-factor authentication failure
- Brute force attack detected
- Session hijacking attempt
- Expired session token

## Where this fits

**Workspace:** User Authentication · login

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a user attempts to log in, when the credentials are correct, then access should be granted with enhanced security protocols.
- [x] Given a user attempts to log in, when the credentials are incorrect, then access should be denied and an alert should be logged.
- [x] Trust: All login attempts must be recorded with IP address and timestamp for security auditing.

_REQ-010's Active Directory and single sign-on are not met: accounts are local. See `docs/SECURITY.md`._

When every box above is ticked, stop and show the demo.
