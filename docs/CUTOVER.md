# Cityworks cutover plan

How the City moves from Cityworks to this system without losing open work
(STORY-013, REQ-012). Migrated Cityworks data is read-only, so anything still
open in Cityworks has to be finished there or re-created here.

## Before cutover

1. **Dry runs.** Run the migration against a copy of the export at least twice:
   `npm run migrate -- <export-dir>`. Each run writes a reconciliation report to
   `data/migration-reports/`. A rerun creates no duplicates.
2. **Resolve GIS relationships.** The report lists every relationship that could not be
   linked (no feature id, a feature GIS does not have, an id two layers share, a record
   not in the export). The GIS analyst resolves each one in a JSON file and reruns with
   `--resolutions <file>`:

   ```json
   {
     "<relationship key from the report>": { "layer": "WATER_MAIN", "feature_id": "20001" },
     "<another key>": { "no_feature": true, "reason": "Feature retired in 2019; no replacement" }
   }
   ```

3. **Check storage.** The migration refuses to start if the attachments would not fit
   (see `MIGRATION_MAX_ATTACHMENT_BYTES` and free disk space). Size the server for the
   attachments plus growth.

## Closing out open items, by department

The report's **Cutover** section lists every Cityworks item that is not closed,
grouped by department. Each department lead:

1. Reviews their list two weeks before cutover.
2. Closes in Cityworks whatever can be finished in time.
3. For each item that cannot: re-creates it in this system (a permit on the
   Permitting page, an asset task on Asset management) and notes the new reference
   in Cityworks, so the history links the two.
4. Signs off when their list is empty or every remaining item has a new reference.

| Department | Lead | Open items at last dry run | Signed off |
|---|---|---|---|
| Public Works | | | |
| Water | | | |
| Building | | | |
| Code Enforcement | | | |
| Planning | | | |

(Department names come from the report; add any the City's export shows.)

## Cutover day

1. Freeze Cityworks: read-only for everyone.
2. Take the final export, with its manifest.
3. Run the migration. **Go ahead only if the report says TRUSTED**: every count
   matches, every attachment is stored and verified by hash, no GIS relationship is
   orphaned, and none is left unresolved.
4. Spot-check ten records per department on the Cityworks history page (`/history`),
   including their attachments.
5. Keep the export and the Cityworks database read-only for the City's retention period.

## If the report is NOT TRUSTED

Do not cut over. Fix the cause the report names (a missing table, a manifest that does
not match, a missing file, an unresolved relationship), take a new export if needed,
and run again.
