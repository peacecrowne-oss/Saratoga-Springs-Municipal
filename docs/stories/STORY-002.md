# STORY-002 — Integrate with ESRI ArcGIS Enterprise

As a GIS analyst, I want the system to integrate with ESRI ArcGIS, so that asset data is synchronized with GIS layers.

**Release:** r0 · Initial Setup and Core Integration (weeks 1–4)
**Owner:** GIS Analyst
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-004** (Functional, must) — The system must fully integrate with ESRI ArcGIS Enterprise 11.3, utilizing ESRI REST endpoint service layers for data exchange and maintaining GIS field values.

## How to build it

Use ESRI REST endpoints to connect and synchronize data with ArcGIS.

## Failure paths you must handle

- REST endpoint authentication failure.
- Data mismatch between system and GIS.
- Network latency issues.

## Where this fits

**Runs headless:** GIS Sync Job — no page shows this; it is background work.

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given the system is connected to ESRI ArcGIS, when asset data is updated, then GIS layers should reflect these updates.
- [x] Given a GIS field value is changed, when I check the system, then it should show the updated value.
- [x] Trust: Ensure all GIS transactions are logged for audit.

_Verified against the SIMULATED ArcGIS stand-in (`npm run arcgis-standin`), not yet against the City's ArcGIS Enterprise 11.3._

When every box above is ticked, stop and show the demo.
