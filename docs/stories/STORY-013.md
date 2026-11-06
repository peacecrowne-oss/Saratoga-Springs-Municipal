# STORY-013 — Migrate Cityworks Data with GIS Relationships Preserved

As the City, I want a decade of Cityworks data migrated into the new system with GIS feature relationships, attachments, fees, people, and workflows preserved, so that historical records stay usable and no open work is lost during cutover.

**Release:** r1 · Asset Management and GIS Integration (weeks 5–8)
**Owner:** IT Administrator
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-012** (Functional, must) — The system must migrate 10+ years of Cityworks data (permits, licenses, service requests, inspections, and work orders), preserving GIS feature relationships, attached documents (up to ~200,000 files), fees, people, and workflows. Migrated data may be read-only for historical look-up and analysis, with a plan to close out open Cityworks cases/work orders by department during cutover.

## How to build it

Build a repeatable, idempotent migration pipeline off the Cityworks SQL schema; preserve GIS feature relationships and attachments; emit a reconciliation report; include a by-department cutover plan to close out open Cityworks cases/work orders.

## Failure paths you must handle

- Source export incomplete or schema drift between Cityworks versions
- Attachment volume exceeds transfer/storage limits
- Legacy records with ambiguous or missing GIS relationships

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a Cityworks SQL export, when the migration runs, then permits, licenses, service requests, inspections, and work orders import with their GIS feature relationships intact.
- [x] Given attached documents up to ~200,000 files, when the migration completes, then each attachment is linked to its record and retrievable.
- [x] Given migrated data is designated read-only, when a user opens a historical case, then it is viewable for look-up and analysis and clearly marked read-only.
- [x] Trust the migration only when a reconciliation report shows source and target record counts match and zero orphaned GIS relationships remain.

_Proven on a SIMULATED export only (`npm run sample-export`). The table and column names follow Cityworks' conventions but must be checked against the City's real export; `SOURCE` in `server/migration.js` is the one place to adjust them. Workflow definitions are not migrated. The cutover plan is in `docs/CUTOVER.md`._

When every box above is ticked, stop and show the demo.
