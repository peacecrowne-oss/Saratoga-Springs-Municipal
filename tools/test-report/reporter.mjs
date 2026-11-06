// A node:test reporter that writes one JSON line per finished test, for the
// final test report (STORY-011). Used as:
//   node --test --test-reporter=./tools/test-report/reporter.mjs --test-reporter-destination=<file>

export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    if (d.details?.type === 'suite') continue;
    if (d.nesting > 0 && !d.name) continue;
    yield `${JSON.stringify({
      ok: event.type === 'test:pass',
      skipped: Boolean(d.skip || d.todo),
      name: d.name,
      file: d.file ?? null,
      nesting: d.nesting,
      ms: Math.round(d.details?.duration_ms ?? 0),
      error: event.type === 'test:fail' ? String(d.details?.error?.cause?.message ?? d.details?.error?.message ?? 'failed').slice(0, 500) : null,
    })}\n`;
  }
}
