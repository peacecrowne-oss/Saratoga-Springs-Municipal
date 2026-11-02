# Municipal Asset Management and Permitting Software Solution — Requirements

A comprehensive system for managing municipal assets and permitting processes, integrating with existing city systems and ensuring secure, user-friendly interactions for both staff and public users.

This is the source of truth for what you are building. Your Claude Code prompts
point here. If you sharpen a requirement, edit it — your version is the real one.

| Kind | Meaning |
|---|---|
| Functional | something the system does |
| Safety | a guardrail, with a check that enforces it |
| Reliability | how it behaves when something fails |
| Constraint | a technology or vendor you must use — context, not a task |

## Asset Management

### REQ-001 — Functional · must

The system must replace the current Cityworks system for asset management, supporting approximately 80 asset-management users.

Fulfilled by: STORY-004

## Data Migration

### REQ-012 — Functional · must

The system must migrate 10+ years of Cityworks data (permits, licenses, service requests, inspections, and work orders), preserving GIS feature relationships, attached documents (up to ~200,000 files), fees, people, and workflows. Migrated data may be read-only for historical look-up and analysis, with a plan to close out open Cityworks cases/work orders by department during cutover.

Fulfilled by: STORY-013

## Deployment

### REQ-002 — Constraint

The system must be deployed on-premises, with an option for near-real-time database replication to City-managed servers if on-premises is unavailable.

Fulfilled by: STORY-001, STORY-011

## GIS Integration

### REQ-004 — Functional · must

The system must fully integrate with ESRI ArcGIS Enterprise 11.3, utilizing ESRI REST endpoint service layers for data exchange and maintaining GIS field values.

Fulfilled by: STORY-002, STORY-005

## Integration with Other Systems

### REQ-011 — Functional · must

The system must integrate with Caselle, Granicus/311, ComplianceGO, Bluebeam Revu, Utilisync, and XpressBillPay using native connectors, REST APIs, or flat file exchanges.

Fulfilled by: STORY-010, STORY-011

## Permitting and Licensing

### REQ-007 — Functional · must

The system must support permitting processes including Code Enforcement, Planning, Building, Business Licensing, ACE Court, reimbursement agreements, and public-improvement/engineering/utility permits.

Fulfilled by: STORY-006, STORY-007

## User Authentication and Security

### REQ-010 — Safety · must

The system must integrate with the City’s Windows Active Directory for single sign-on and two-factor authentication, and document PII handling in the security architecture.

Fulfilled by: STORY-001, STORY-012
