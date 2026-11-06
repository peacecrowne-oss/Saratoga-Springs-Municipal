# STORY-010 — Integrate with Caselle for Billing

As a billing manager, I want to integrate with Caselle, so that billing processes are streamlined and accurate.

**Release:** r4 · System Integrations and Final Deployment (weeks 17–20)
**Owner:** Billing Manager
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-011** (Functional, must) — The system must integrate with Caselle, Granicus/311, ComplianceGO, Bluebeam Revu, Utilisync, and XpressBillPay using native connectors, REST APIs, or flat file exchanges.

## How to build it

Ensure the integration with Caselle uses the provided API endpoints and adheres to the data format specifications outlined by Caselle.

## Failure paths you must handle

- Caselle API is down
- Incorrect API credentials
- Data format mismatch
- Network timeout
- Unauthorized access attempt

## Where this fits

**Runs headless:** Caselle Integration Job — no page shows this; it is background work.

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given the system is connected to Caselle, when a billing request is made, then the billing information should be accurately retrieved from Caselle.
- [x] Given the system is not connected to Caselle, when a billing request is made, then an error message should be displayed indicating the connection issue.
- [x] Trust: All billing transactions must be logged with a timestamp and user ID for audit purposes.

_Tested against a SIMULATED Caselle stand-in only. No Caselle API documentation was available, so the interface is defined in `server/integrations/caselle/client.js` and must be mapped to Caselle's real API. The other REQ-011 systems (Granicus/311, ComplianceGO, Bluebeam Revu, Utilisync, XpressBillPay) are not built._

When every box above is ticked, stop and show the demo.
