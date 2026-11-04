// Reviewing the GIS Sync Job (STORY-005). It runs headless, so this is how a
// person finds out what it did and what went wrong. Everything here is read from
// the append-only audit trail, plus the current state of each asset's GIS link.

const fromJson = v => (v === null || v === undefined ? null : JSON.parse(v));

export const GIS_ERROR_ACTIONS = ['gis.sync_failed', 'gis.push_failed', 'gis.verify_failed', 'gis.feature_missing', 'gis.mismatch', 'gis.spatial_problem'];

export function readGisLog(audit, { errorsOnly = false, limit = 50 } = {}) {
  return errorsOnly
    ? audit.listActions({ only: GIS_ERROR_ACTIONS, limit })
    : audit.listActions({ prefix: 'gis.', limit });
}

// The state of the sync right now: the last run, the last failure, and every
// asset that needs someone's attention.
export function gisStatus(db, audit) {
  const state = key => fromJson(db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM asset_gis GROUP BY status').all().map(r => [r.status, r.n]));
  const attention = db.prepare(`
    SELECT a.id, a.asset_tag, g.object_id, g.status, g.last_error, g.spatial_problem, g.mismatch, g.synced_at
    FROM asset_gis g JOIN asset a ON a.id = g.asset_id
    WHERE g.status IN ('error', 'missing', 'mismatch') OR g.spatial_problem IS NOT NULL
    ORDER BY a.asset_tag LIMIT 200
  `).all().map(r => ({
    assetId: r.id,
    assetTag: r.asset_tag,
    objectId: r.object_id,
    status: r.status,
    lastError: fromJson(r.last_error),
    spatialProblem: fromJson(r.spatial_problem),
    mismatch: fromJson(r.mismatch),
    syncedAt: r.synced_at,
  }));
  const reconciledAt = state('gis.reconcile.last_at');
  return {
    lastRun: audit.listActions({ only: ['gis.sync_run'], limit: 1 })[0] ?? null,
    lastFailure: audit.listActions({ only: ['gis.sync_failed'], limit: 1 })[0] ?? null,
    lastReconcileAt: reconciledAt === null ? null : new Date(reconciledAt).toISOString(),
    links: counts,
    awaitingLocation: db.prepare("SELECT COUNT(*) AS n FROM asset_gis WHERE geometry IS NULL AND status <> 'missing'").get().n,
    attention,
  };
}

// One line for a person reading the log.
export function describeGisEvent(e) {
  const a = e.after ?? {};
  switch (e.action) {
    case 'gis.sync_run': return `pulled ${a.pulled}, pushed ${a.pushed}, verified ${a.verified}, mismatches ${a.mismatches}, push failures ${a.pushFailed}, read-back failures ${a.verifyFailed}, missing features ${a.missingFeatures}, spatial problems ${a.spatialProblems}${a.reconciled ? ', whole layer compared' : ''}`;
    case 'gis.sync_failed': return `stopped at ${a.stage}${a.assetTag ? ` on ${a.assetTag}` : ''} (${a.kind}): ${a.message} Next step: ${a.hint}`;
    case 'gis.push': return `${a.operation} object ${a.objectId}${a.overwrote ? `, overwrote GIS ${a.overwrote.map(f => f.field).join(', ')}` : ''}`;
    case 'gis.push_failed': return `${a.assetTag ?? ''} ${a.operation} object ${a.objectId ?? 'new'} refused: ${a.error?.description ?? 'no detail'}${a.error?.code ? ` (code ${a.error.code})` : ''}`;
    case 'gis.verify_failed': return `${a.assetTag ?? ''} object ${a.objectId}: ${a.description} ${(a.fields ?? []).map(f => `${f.field} sent "${f.sent}", GIS has "${f.gis}"`).join('; ')}`;
    case 'gis.feature_missing': return `${a.assetTag ?? ''} ${a.description}`;
    case 'gis.pull': return `object ${a.objectId} by ${a.editedBy ?? 'unknown'}${a.geometry ? ` at (${a.geometry.x}, ${a.geometry.y})` : ''}${a.found_by ? `, found by ${a.found_by}` : ''}`;
    case 'gis.spatial_problem': return `object ${a.objectId} ${a.kind}: ${a.message}`;
    case 'gis.mismatch':
      if (a.kind === 'unknown_asset') return `feature ${a.objectId} has tag "${a.assetTag ?? ''}", which matches no asset`;
      if (a.kind === 'duplicate_feature') return `${a.assetTag}: feature ${a.duplicateObjectId} duplicates feature ${a.objectId}; ${a.resolution}`;
      return `object ${a.objectId}: ${(a.fields ?? []).map(f => `${f.field} system "${f.system}", GIS "${f.gis}"`).join('; ')}; ${a.resolution}`;
    default: return '';
  }
}
