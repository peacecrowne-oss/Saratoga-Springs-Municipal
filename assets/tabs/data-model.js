import { PROJECT_FILES } from '../data.js';
import { esc, link, card, grid, emptyState, back, table } from '../ui.js';

// The model is a design proposal (model/data-model.json), not data the system
// produced, so it shows the same in sample and real mode.

const reqLabel = (v, id) => {
  const r = v.requirements.find(x => x.id === id);
  return `<a href="${link('knowledge', 'req', id)}"><strong>${esc(id)}</strong></a>${r ? ' ' + esc(r.statement) : ' <span class="muted">(statement not in your data yet)</span>'}`;
};

export function render(v, parts) {
  const m = v.model;
  if (!m) return `<h1>Data model</h1>` + emptyState('The tables behind every tab, with their fields and relationships.', `<code>${PROJECT_FILES.model}</code> could not be read.`);
  const tables = Array.isArray(m.tables) ? m.tables : [];
  if (parts[1]) return detail(v, tables, parts[1]);

  const rels = tables.flatMap(t => (t.fields ?? []).filter(f => f.references).map(f => [t.name, f.name, f.references]));
  return `<h1>Data model</h1>
    <div class="banner paused"><strong>Proposed, not created.</strong> ${esc(m.note ?? '')} Review it, change <code>${PROJECT_FILES.model}</code>, and only then create the tables.</div>
    <h2>Tables</h2>
    ${grid(tables.map(t => card({ ...v, isSample: false }, {
      href: link('data-model', t.name),
      label: (t.requirements ?? []).join(', ') || 'no requirement',
      value: t.name,
      note: `${esc(t.purpose)}<br>${(t.fields ?? []).length} fields`,
    })))}
    <h2>Relationships</h2>
    ${table(['Table', 'Field', 'Refers to'], rels.map(([t, f, to]) => [
      `<a href="${link('data-model', t)}">${esc(t)}</a>`, `<code>${esc(f)}</code>`, `<a href="${link('data-model', to)}">${esc(to)}</a>`,
    ]))}`;
}

function detail(v, tables, name) {
  const b = back('#/data-model', 'Data model');
  const t = tables.find(x => x.name === name);
  if (!t) return b + `<h1>${esc(name)}</h1>` + emptyState('This table, its fields and relationships.', 'No table by this name is in the proposal.');
  const referencedBy = tables.flatMap(o => (o.fields ?? []).filter(f => f.references === name).map(f => `<a href="${link('data-model', o.name)}">${esc(o.name)}</a>.<code>${esc(f.name)}</code>`));
  return b + `<h1>${esc(t.name)} <span class="tag">Proposed</span></h1>
    <p class="lede">${esc(t.purpose)}</p>
    ${table(['Field', 'Type', 'Key', 'Refers to', 'Note'], (t.fields ?? []).map(f => [
      `<code>${esc(f.name)}</code>`, esc(f.type), esc(f.key ?? ''),
      f.references ? `<a href="${link('data-model', f.references)}">${esc(f.references)}</a>` : '', esc(f.note ?? ''),
    ]))}
    <h2>Referenced by</h2>
    ${referencedBy.length ? `<ul>${referencedBy.map(x => `<li>${x}</li>`).join('')}</ul>` : '<p class="lede">Nothing yet.</p>'}
    <h2>Why it exists</h2>
    <ul>${(t.requirements ?? []).map(id => `<li>${reqLabel(v, id)}</li>`).join('')}</ul>`;
}
