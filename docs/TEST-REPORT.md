# Final test report

Generated 2026-11-06T19:04:44.825Z on commit `648a830`.

**Report: COMPLETE** · **Verdict: NOT READY**

## Why it is not ready

- user acceptance: 14 of 14 scenarios have not been run

## Critical issues

None found.

## Automated tests

190 passed, 0 failed, 0 skipped, of 190.

| File | Passed | Failed |
|---|---:|---:|
| server/app.test.js | 7 | 0 |
| server/asset-care.test.js | 18 | 0 |
| server/assets.test.js | 8 | 0 |
| server/audit.test.js | 6 | 0 |
| server/auth.test.js | 27 | 0 |
| server/billing.test.js | 11 | 0 |
| server/deploy.test.js | 6 | 0 |
| server/gis-accuracy.test.js | 19 | 0 |
| server/gis-sync.test.js | 12 | 0 |
| server/integrations/arcgis/client.test.js | 8 | 0 |
| server/integrations/tyler/client.test.js | 9 | 0 |
| server/migration.test.js | 13 | 0 |
| server/permits.test.js | 13 | 0 |
| server/portal.test.js | 15 | 0 |
| server/testing.test.js | 11 | 0 |
| tests/command-center.test.mjs | 1 | 0 |
| tools/tyler-standin/server.test.js | 6 | 0 |

## End-to-end smoke test

A real deployment on a throwaway database, real sign-in, every module over HTTP. Tyler, Caselle and the Cityworks export are SIMULATED.

| Check | Story | Result | Detail |
|---|---|---|---|
| Deployment is healthy | STORY-001 | pass |  |
| Every page is served | STORY-000 | pass | 7 pages |
| Every role signs in with password and authenticator code | STORY-012 | pass | 7 roles |
| A wrong password is refused | STORY-012 | pass |  |
| Assets: add, record condition, schedule maintenance | STORY-004 | pass |  |
| GIS sync status is readable | STORY-002 | pass |  |
| Budget comes from Tyler (SIMULATED) | STORY-005 | pass |  |
| Billing comes from Caselle (SIMULATED), and its outage is named | STORY-010 | pass |  |
| Permits: a clerk submits, an officer approves | STORY-006 | pass |  |
| Portal: a resident applies, is confirmed, books an inspection | STORY-007 | pass |  |
| Cityworks history is migrated, trusted and read-only | STORY-013 | pass |  |
| Roles are enforced | STORY-012 | pass |  |
| Every action above is on the audit trail | STORY-001 | pass |  |

## User acceptance

0 of 14 scenarios run, 0 passing, 0 open issue(s), 0 critical. Testers: none yet.
Accepted: **no** (14 of 14 scenarios have not been run).

| Scenario | Story | Title | Latest result | By | Notes |
|---|---|---|---|---|---|
| UAT-01 | STORY-012 | Sign in with password and authenticator code | not run |  |  |
| UAT-02 | STORY-001 | Check the system is up | not run |  |  |
| UAT-03 | STORY-004 | Add an asset, record its condition and schedule maintenance | not run |  |  |
| UAT-04 | STORY-004 | Try an impossible status change | not run |  |  |
| UAT-05 | STORY-002 | Review the GIS sync | not run |  |  |
| UAT-06 | STORY-006 | Submit a code enforcement application | not run |  |  |
| UAT-07 | STORY-006 | Approve an application with both checks, reject another | not run |  |  |
| UAT-08 | STORY-007 | Apply on the public portal | not run |  |  |
| UAT-09 | STORY-007 | Book and then move the inspection | not run |  |  |
| UAT-10 | STORY-013 | Look up a historical Cityworks case | not run |  |  |
| UAT-11 | STORY-013 | Read the migration reconciliation | not run |  |  |
| UAT-12 | STORY-010 | Look up a Caselle billing account | not run |  |  |
| UAT-13 | STORY-005 | View the budget from Tyler | not run |  |  |
| UAT-14 | STORY-012 | Sign out, and try a page you are not allowed | not run |  |  |

## Cityworks migration

Latest run: **TRUSTED** (SIMULATED export), 2026-11-06T18:27:15.940Z. permit 25, license 25, service_request 50, inspection 50, work_order 50; 200 attachments; 200 GIS links, 0 orphaned, 0 unresolved.

## Tests on record per story

| Story | Test files |
|---|---|
| STORY-001 | server/deploy.test.js, server/assets.test.js |
| STORY-002 | server/gis-sync.test.js, server/integrations/arcgis/client.test.js, server/assets.test.js |
| STORY-004 | server/asset-care.test.js |
| STORY-005 | server/gis-accuracy.test.js, server/gis-sync.test.js |
| STORY-006 | server/permits.test.js |
| STORY-007 | server/portal.test.js |
| STORY-010 | server/billing.test.js |
| STORY-011 | server/testing.test.js |
| STORY-012 | server/auth.test.js |
| STORY-013 | server/migration.test.js |

## Known gaps

- **REQ-010**: No Windows Active Directory or single sign-on: accounts are local (password + authenticator code).
- **REQ-011**: Only Caselle is integrated, and only against a SIMULATED stand-in. Granicus/311, ComplianceGO, Bluebeam Revu, Utilisync and XpressBillPay are not built.
- **REQ-004**: ArcGIS is exercised only against a SIMULATED stand-in, not ArcGIS Enterprise 11.3.
- **REQ-014**: Tyler budget data comes only from a SIMULATED stand-in.
- **REQ-002**: On-premises deployment is built; near-real-time replication to City-managed servers is not.
- **REQ-007**: Only code enforcement permits exist; Planning, Building, Business Licensing, ACE Court and the other permit types do not.
- **REQ-012**: The migration is proven on a SIMULATED export; table and column names must be checked against the City's real Cityworks export. Workflow definitions are not migrated.
- **STORY-007**: Resident email is SIMULATED: no mail service is connected.
- **all**: No penetration test or City security review has been done.
