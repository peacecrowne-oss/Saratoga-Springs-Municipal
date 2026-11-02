# STORY-005 — Synchronize Asset Data with GIS

As a GIS analyst, I want asset data synchronized with GIS, so that spatial information is accurate and up-to-date.

**Release:** r1 · Asset Management and GIS Integration (weeks 5–8)
**Owner:** GIS Analyst
**Blocked by:** STORY-002

## The requirement this satisfies

- **REQ-004** (Functional, must) — The system must fully integrate with ESRI ArcGIS Enterprise 11.3, utilizing ESRI REST endpoint service layers for data exchange and maintaining GIS field values.

## How to build it

Implement data synchronization processes between asset management and GIS systems.

## Failure paths you must handle

- Data synchronization errors.
- GIS layer update failures.
- Network connectivity issues.

## Where this fits

**Runs headless:** GIS Sync Job — no page shows this; it is background work.

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given asset data is updated, when I check GIS, then the spatial information should be accurate.
- [ ] Given a synchronization error occurs, when I review logs, then I should see error details.
- [ ] Trust: Ensure synchronization logs are maintained for audit.

When every box above is ticked, stop and show the demo.
