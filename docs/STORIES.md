# Municipal Asset Management and Permitting Software Solution — Stories

9 stories across 5 releases, walking-skeleton first:
the earliest release proves the thinnest end-to-end path including the trust
spine, and later releases stack features on top of something already working.

## Before the releases — start here

- **[STORY-000](stories/STORY-000.md)** — Build your Command Center

The first thing you build, on day one, before any part of the system itself. It is
the page you keep open for the rest of the programme and demo from. It belongs to no
release and fulfils none of your requirements, because it is the window onto your
system rather than a part of it.

## r0 · Initial Setup and Core Integration — weeks 1–4

**Goal:** Establish core system infrastructure and basic integrations.
**Done when you can show:** Show end-to-end data flow from asset management to GIS with authentication via Active Directory.

- **[STORY-001](stories/STORY-001.md)** — Deploy Initial System with Core Functionalities
- **[STORY-002](stories/STORY-002.md)** — Integrate with ESRI ArcGIS Enterprise

## r1 · Asset Management and GIS Integration — weeks 5–8

**Goal:** Implement asset management features and GIS integration.
**Done when you can show:** Demonstrate asset lifecycle management with GIS data synchronization.

- **[STORY-004](stories/STORY-004.md)** — Implement Asset Lifecycle Management _(waits on STORY-001)_
- **[STORY-005](stories/STORY-005.md)** — Synchronize Asset Data with GIS _(waits on STORY-002)_

## r2 · Permitting and Licensing Module — weeks 9–12

**Goal:** Develop permitting processes and public portal.
**Done when you can show:** Process a permit application from submission to approval with public portal interaction.

- **[STORY-006](stories/STORY-006.md)** — Develop Permitting Process for Code Enforcement _(waits on STORY-004)_
- **[STORY-007](stories/STORY-007.md)** — Public Portal for Permit Applications _(waits on STORY-006)_

## r3 · Security and Authentication Enhancements — weeks 13–16

**Goal:** Enhance security features and user authentication.
**Done when you can show:** Authenticate users with two-factor authentication and demonstrate PII handling.

- **[STORY-012](stories/STORY-012.md)** — Enhance Security Protocols for User Authentication

## r4 · System Integrations and Final Deployment — weeks 17–20

**Goal:** Complete system integrations and finalize deployment.
**Done when you can show:** Showcase integration with all specified external systems and final deployment setup.

- **[STORY-010](stories/STORY-010.md)** — Integrate with Caselle for Billing
- **[STORY-011](stories/STORY-011.md)** — Conduct Final System Testing and User Acceptance _(waits on STORY-010)_
