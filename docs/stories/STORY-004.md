# STORY-004 — Implement Asset Lifecycle Management

As an asset manager, I want to manage the lifecycle of municipal assets, so that I can track and maintain them effectively.

**Release:** r1 · Asset Management and GIS Integration (weeks 5–8)
**Owner:** Asset Manager
**Blocked by:** STORY-001

## The requirement this satisfies

- **REQ-001** (Functional, must) — The system must replace the current Cityworks system for asset management, supporting approximately 80 asset-management users.

## How to build it

Develop asset management features including inventory, maintenance scheduling, and condition monitoring.

## Failure paths you must handle

- Asset data entry errors.
- Lifecycle status update failures.
- Condition monitoring discrepancies.

## Where this fits

**Workspace:** Asset Management Dashboard

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an asset is added to the system, when I view its details, then I should see its lifecycle status.
- [ ] Given an asset's condition changes, when I update its status, then the system should reflect the new condition.
- [ ] Trust: Ensure all asset updates are logged for audit.

When every box above is ticked, stop and show the demo.
