// Asset lifecycle management (STORY-004): the inventory, condition monitoring
// and maintenance scheduling, on top of the asset records.
//
// A condition reading is history: the asset's current condition is its latest
// reading by observed_at, so a late-arriving older reading is kept but does not
// replace a newer one. A reading can also move the asset's lifecycle status, and
// both land in one transaction with their audit events.
//
// Discrepancies are flagged and audited but never fixed automatically: whether
// to take a critical asset out of service is a person's decision.
//
// Every write is idempotent: the same reading (asset + observed_at) or the same
// task (asset + title + due date) sent twice writes nothing the second time.

import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { AssetStaleError, AssetTransitionError, AssetValidationError, ASSET_STATUSES, NEXT_STATUSES } from './assets.js';

export const CONDITIONS = ['good', 'fair', 'poor', 'critical'];
export const TASK_STATUSES = ['scheduled', 'completed', 'cancelled'];
const MAX_FUTURE_MS = 5 * 60000; // tolerates a device clock slightly ahead
const MAX_PAGE = 200;

// A request that conflicts with what is already recorded.
export class AssetCareConflict extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AssetCareConflict';
    this.kind = kind;
  }
}

const fromReading = row => row && ({
  id: row.id,
  assetId: row.asset_id,
  condition: row.condition,
  notes: row.notes,
  observedAt: row.observed_at,
  recordedBy: row.recorded_by,
  recordedAt: row.recorded_at,
});

const optionalNotes = (input, problems) => {
  if (input.notes === undefined || input.notes === null || input.notes === '') return null;
  if (typeof input.notes !== 'string') { problems.push({ field: 'notes', problem: 'must be text' }); return null; }
  if (input.notes.length > 1000) { problems.push({ field: 'notes', problem: 'must be at most 1000 characters' }); return null; }
  return input.notes.trim() || null;
};

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const localDate = d => d.toLocaleDateString('en-CA'); // YYYY-MM-DD

function isRealDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !isNaN(parsed) && parsed.toISOString().slice(0, 10) === text;
}

export function createAssetCare(db, audit, assets, { now = () => new Date() } = {}) {
  const latest = db.prepare('SELECT * FROM asset_condition WHERE asset_id = ? ORDER BY observed_at DESC LIMIT 1');
  const readings = db.prepare('SELECT * FROM asset_condition WHERE asset_id = ? ORDER BY observed_at DESC LIMIT ?');
  const readingAt = db.prepare('SELECT * FROM asset_condition WHERE asset_id = ? AND observed_at = ?');
  const addReading = db.prepare(`
    INSERT INTO asset_condition (id, asset_id, condition, notes, observed_at, recorded_by, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tasksOf = db.prepare('SELECT * FROM maintenance_task WHERE asset_id = ? ORDER BY due_on, created_at');
  const taskByKey = db.prepare('SELECT * FROM maintenance_task WHERE asset_id = ? AND title = ? AND due_on = ?');
  const taskById = db.prepare('SELECT * FROM maintenance_task WHERE id = ? AND asset_id = ?');
  const addTask = db.prepare(`
    INSERT INTO maintenance_task (id, asset_id, title, due_on, notes, status, created_by, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, NULL)
  `);
  const saveTask = db.prepare('UPDATE maintenance_task SET status = ?, notes = ?, updated_at = ?, completed_at = ? WHERE id = ?');
  const openTasks = db.prepare(`
    SELECT t.*, a.asset_tag, a.name AS asset_name FROM maintenance_task t JOIN asset a ON a.id = t.asset_id
    WHERE t.status = 'scheduled' ORDER BY t.due_on, t.created_at LIMIT ?
  `);

  const fromTask = row => row && ({
    id: row.id,
    assetId: row.asset_id,
    title: row.title,
    dueOn: row.due_on,
    notes: row.notes,
    status: row.status,
    overdue: row.status === 'scheduled' && row.due_on < localDate(now()),
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });

  function discrepancies(asset, condition, tasks) {
    const found = [];
    if (condition?.condition === 'critical' && asset.status === 'active') {
      found.push({ kind: 'critical_but_active', message: 'The latest condition is critical, but the asset is still active.' });
    }
    if (asset.status === 'retired' && tasks.some(t => t.status === 'scheduled')) {
      found.push({ kind: 'retired_with_open_maintenance', message: 'The asset is retired, but it still has maintenance scheduled.' });
    }
    return found;
  }

  // The inventory's view of one asset: lifecycle, condition, flags, next task.
  function view(asset, { detail = false } = {}) {
    const condition = fromReading(latest.get(asset.id)) ?? null;
    const tasks = tasksOf.all(asset.id).map(fromTask);
    const open = tasks.filter(t => t.status === 'scheduled');
    return {
      ...asset,
      nextStatuses: NEXT_STATUSES[asset.status],
      condition,
      discrepancies: discrepancies(asset, condition, tasks),
      nextMaintenance: open[0] ?? null,
      overdueMaintenance: open.filter(t => t.overdue).length,
      ...(detail && { conditionHistory: readings.all(asset.id, 20).map(fromReading), maintenance: tasks }),
    };
  }

  return {
    view,

    // The inventory list. Throws AssetValidationError on a bad filter.
    search({ status, assetType, condition, q, limit = 100, offset = 0 } = {}) {
      const problems = [];
      if (status && !ASSET_STATUSES.includes(status)) problems.push({ field: 'status', problem: `must be one of ${ASSET_STATUSES.join(', ')}` });
      if (condition && !CONDITIONS.includes(condition)) problems.push({ field: 'condition', problem: `must be one of ${CONDITIONS.join(', ')}` });
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) problems.push({ field: 'limit', problem: `must be a whole number from 1 to ${MAX_PAGE}` });
      if (!Number.isInteger(offset) || offset < 0) problems.push({ field: 'offset', problem: 'must be a whole number, 0 or more' });
      if (problems.length) throw new AssetValidationError(problems);

      const where = [];
      const params = [];
      if (status) { where.push('a.status = ?'); params.push(status); }
      if (assetType) { where.push('a.asset_type = ? COLLATE NOCASE'); params.push(assetType); }
      if (condition) {
        where.push('(SELECT c.condition FROM asset_condition c WHERE c.asset_id = a.id ORDER BY c.observed_at DESC LIMIT 1) = ?');
        params.push(condition);
      }
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        where.push("(a.asset_tag LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' OR a.location LIKE ? ESCAPE '\\')");
        params.push(like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...params).n;
      const rows = db.prepare(`SELECT a.id FROM asset a ${clause} ORDER BY a.asset_tag LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { assets: rows.map(r => view(assets.get(r.id))), total, limit, offset };
    },

    // Returns null if there is no such asset.
    recordCondition({ actor, assetId, input }) {
      if (!isObject(input)) throw new AssetValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
      const problems = [];
      if (!CONDITIONS.includes(input.condition)) problems.push({ field: 'condition', problem: `must be one of ${CONDITIONS.join(', ')}` });
      const observed = typeof input.observed_at === 'string' ? new Date(input.observed_at) : null;
      if (!observed || isNaN(observed)) problems.push({ field: 'observed_at', problem: 'must be a date and time' });
      else if (observed.getTime() > now().getTime() + MAX_FUTURE_MS) problems.push({ field: 'observed_at', problem: 'cannot be in the future' });
      const notes = optionalNotes(input, problems);
      if (input.status !== undefined && !ASSET_STATUSES.includes(input.status)) problems.push({ field: 'status', problem: `must be one of ${ASSET_STATUSES.join(', ')}` });
      if (problems.length) throw new AssetValidationError(problems);
      const observedAt = observed.toISOString();

      const requested = { condition: input.condition, observedAt, notes, status: input.status };
      try {
        return transaction(db, () => {
          const current = assets.get(assetId);
          if (!current) return null;

          const same = fromReading(readingAt.get(current.id, observedAt));
          if (same) {
            if (same.condition === input.condition && same.notes === notes) {
              return { recorded: false, reading: same, outOfOrder: false, asset: view(assets.get(current.id), { detail: true }) };
            }
            throw new AssetCareConflict('condition_conflict',
              `A different reading (${same.condition}) is already recorded for ${current.assetTag} at ${observedAt}.`);
          }
          if (current.status === 'retired') {
            throw new AssetCareConflict('asset_retired', `${current.assetTag} is retired, so it cannot take a new condition reading.`);
          }

          const previous = fromReading(latest.get(current.id)) ?? null;
          const outOfOrder = previous !== null && observedAt < previous.observedAt;
          const reading = {
            id: randomUUID(), assetId: current.id, condition: input.condition, notes, observedAt,
            recordedBy: actor, recordedAt: now().toISOString(),
          };
          addReading.run(reading.id, reading.assetId, reading.condition, notes, observedAt, actor, reading.recordedAt);
          audit.record({ actor, action: 'asset.condition_recorded', entityType: 'asset', entityId: current.id,
            before: previous && { condition: previous.condition, observedAt: previous.observedAt }, after: { ...reading, outOfOrder } });

          if (input.status !== undefined) assets.applyUpdate({ actor, id: current.id, input: { status: input.status } });

          const asset = view(assets.get(current.id), { detail: true });
          const raised = [...asset.discrepancies];
          if (outOfOrder) {
            raised.push({ kind: 'older_than_current', message: `This reading is older than the current one (${previous.observedAt}), so the current condition did not change.` });
          }
          if (raised.length) {
            audit.record({ actor, action: 'asset.condition_discrepancy', entityType: 'asset', entityId: current.id, after: { readingId: reading.id, discrepancies: raised } });
          }
          return { recorded: true, reading, outOfOrder, raised, asset };
        });
      } catch (err) {
        if (err instanceof AssetCareConflict || err instanceof AssetTransitionError || err instanceof AssetStaleError) {
          assets.recordRejection({ actor, id: assetId, input: requested, err });
        }
        throw err;
      }
    },

    // Returns null if there is no such asset.
    scheduleMaintenance({ actor, assetId, input }) {
      if (!isObject(input)) throw new AssetValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
      const problems = [];
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title) problems.push({ field: 'title', problem: 'is required' });
      else if (title.length > 200) problems.push({ field: 'title', problem: 'must be at most 200 characters' });
      if (!isRealDate(input.due_on)) problems.push({ field: 'due_on', problem: 'must be a real date, YYYY-MM-DD' });
      const notes = optionalNotes(input, problems);
      if (problems.length) throw new AssetValidationError(problems);

      try {
        return transaction(db, () => {
          const asset = assets.get(assetId);
          if (!asset) return null;
          const existing = fromTask(taskByKey.get(asset.id, title, input.due_on));
          if (existing) return { created: false, task: existing };
          if (input.due_on < localDate(now())) {
            throw new AssetValidationError([{ field: 'due_on', problem: 'is in the past' }]);
          }
          if (asset.status === 'retired') {
            throw new AssetCareConflict('asset_retired', `${asset.assetTag} is retired, so it cannot have maintenance scheduled.`);
          }
          const at = now().toISOString();
          const id = randomUUID();
          addTask.run(id, asset.id, title, input.due_on, notes, actor, at, at);
          const task = fromTask(taskById.get(id, asset.id));
          audit.record({ actor, action: 'maintenance.schedule', entityType: 'asset', entityId: asset.id, after: task });
          return { created: true, task };
        });
      } catch (err) {
        if (err instanceof AssetCareConflict) assets.recordRejection({ actor, id: assetId, input, err });
        throw err;
      }
    },

    // Completes or cancels a task. Returns null if there is no such task on this asset.
    closeMaintenance({ actor, assetId, taskId, input }) {
      if (!isObject(input)) throw new AssetValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
      const problems = [];
      if (!['completed', 'cancelled'].includes(input.status)) problems.push({ field: 'status', problem: 'must be completed or cancelled' });
      const notes = optionalNotes(input, problems);
      if (problems.length) throw new AssetValidationError(problems);

      try {
        return transaction(db, () => {
          const before = fromTask(taskById.get(String(taskId), String(assetId)));
          if (!before) return null;
          if (before.status === input.status) return { updated: false, task: before };
          if (before.status !== 'scheduled') {
            throw new AssetCareConflict('task_closed', `This task is already ${before.status}, so it cannot be marked ${input.status}.`);
          }
          const at = now().toISOString();
          saveTask.run(input.status, notes ?? before.notes, at, input.status === 'completed' ? at : null, before.id);
          const task = fromTask(taskById.get(before.id, before.assetId));
          audit.record({ actor, action: `maintenance.${input.status === 'completed' ? 'complete' : 'cancel'}`, entityType: 'asset', entityId: before.assetId, before, after: task });
          return { updated: true, task };
        });
      } catch (err) {
        if (err instanceof AssetCareConflict) assets.recordRejection({ actor, id: assetId, input, err });
        throw err;
      }
    },

    // Everything still to do, soonest first, across all assets.
    openMaintenance({ limit = 100 } = {}) {
      return openTasks.all(limit).map(row => ({ ...fromTask(row), assetTag: row.asset_tag, assetName: row.asset_name }));
    },
  };
}
