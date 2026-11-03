const { persistEdgesWithGlobalFanInCap, __internal: { isRowDataError, isIntegrityViolation, writeFailureGateExceeded, writeFailureLine } } =
  require('../../scripts/build-product-relationship-graph');

// 2026-11-02: one label with half an emoji in its snapshot was refused by Postgres and aborted the
// build, and with it the night. A write that fails on the ROW's data is now skipped and counted; a
// database or job failure still fails the build; many row failures still fail it.
function edge(id, relation = 'related_product', extra = {}) {
  return { id, anchor_type: 'product', anchor_ref: `product:a_${id}`, candidate_product_ref: extra.candidate || `product:c_${id}`,
    relation_type: relation, market: 'US', score_total: 0.8, anchor_snapshot: { title: 'A' }, candidate_snapshot: { title: 'B' },
    source_refs: [], ...extra };
}
const pgError = (code, message = 'refused') => Object.assign(new Error(message), { code });

function fakeDb({ failFor = new Map() } = {}) {
  const log = [];
  const run = async (sql, params = []) => {
    const text = String(sql).trim();
    log.push(text.split(/\s+/).slice(0, 4).join(' '));
    if (/^INSERT INTO relationship_candidate_labels/.test(text)) {
      const id = params[0];
      if (failFor.has(id)) throw failFor.get(id);
      return { rows: [{ id }] };
    }
    return { rows: [] };
  };
  return { log, queryFn: jest.fn(run), runInClient: jest.fn(async (fn) => fn({ query: run })) };
}

describe('uncapped writes (autocommit)', () => {
  test('a row refused for its data is skipped and reported; the others are written', async () => {
    const db = fakeDb({ failFor: new Map([['bad', pgError('22P02', 'invalid input syntax for type json')]]) });
    const result = await persistEdgesWithGlobalFanInCap({ edges: [edge('ok1'), edge('bad'), edge('ok2')], cap: 8, queryFn: db.queryFn, runInClient: db.runInClient });
    expect(result).toMatchObject({ applied: 2, attempted: 3 });
    expect(result.failed).toEqual([{ edge_id: 'bad', anchor_ref: 'product:a_bad', candidate_ref: 'product:c_bad', relation_type: 'related_product',
      label_state: 'generated', code: '22P02' }]);
  });
  test('the writer\'s own validation refusal is a row failure too', async () => {
    const db = fakeDb();
    const result = await persistEdgesWithGlobalFanInCap({ edges: [edge('ok'), { ...edge('noref'), candidate_product_ref: '' }], cap: 8,
      queryFn: db.queryFn, runInClient: db.runInClient });
    expect(result.failed.map((row) => [row.edge_id, row.code])).toEqual([['noref', 'LABEL_MISSING_IDENTITY']]);
    expect(result.applied).toBe(1);
  });
  test('a database failure (connection, timeout) still fails the build, naming the row', async () => {
    const lost = pgError('57P01', 'terminating connection due to administrator command');
    const db = fakeDb({ failFor: new Map([['bad', lost]]) });
    await expect(persistEdgesWithGlobalFanInCap({ edges: [edge('ok'), edge('bad')], cap: 8, queryFn: db.queryFn, runInClient: db.runInClient }))
      .rejects.toBe(lost);
    expect(lost.relgraph_write).toMatchObject({ edge_id: 'bad', candidate_ref: 'product:c_bad' });
    const noCode = new Error('socket hang up');
    const db2 = fakeDb({ failFor: new Map([['bad', noCode]]) });
    await expect(persistEdgesWithGlobalFanInCap({ edges: [edge('bad')], cap: 8, queryFn: db2.queryFn, runInClient: db2.runInClient })).rejects.toBe(noCode);
  });
});

describe('capped writes (one transaction per candidate)', () => {
  const alt = (id) => edge(id, 'competitive_alternative', { candidate: 'product:shared' });
  test('each row has a savepoint; a bad row rolls back only itself and the group commits', async () => {
    const db = fakeDb({ failFor: new Map([['bad', pgError('22021', 'invalid byte sequence for encoding "UTF8": 0x00')]]) });
    const result = await persistEdgesWithGlobalFanInCap({ edges: [alt('ok1'), alt('bad'), alt('ok2')], cap: 8, queryFn: db.queryFn, runInClient: db.runInClient });
    expect(result).toMatchObject({ applied: 2, attempted: 3 });
    expect(result.failed.map((row) => row.edge_id)).toEqual(['bad']);
    const writes = db.log.filter((line) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|INSERT)/.test(line));
    expect(writes[0]).toBe('BEGIN');
    expect(writes.at(-1)).toBe('COMMIT');
    const rowStatements = writes.slice(1, -1);
    expect(rowStatements.filter((line) => line.startsWith('SAVEPOINT'))).toHaveLength(3);
    expect(rowStatements.filter((line) => line.startsWith('RELEASE'))).toHaveLength(2);
    expect(rowStatements.filter((line) => line.startsWith('ROLLBACK TO'))).toHaveLength(1);
    expect(writes).not.toContain('ROLLBACK');
  });
  test('a database failure inside the group rolls the group back and fails the build', async () => {
    const lost = pgError('08006', 'connection failure');
    const db = fakeDb({ failFor: new Map([['bad', lost]]) });
    await expect(persistEdgesWithGlobalFanInCap({ edges: [alt('ok'), alt('bad')], cap: 8, queryFn: db.queryFn, runInClient: db.runInClient }))
      .rejects.toBe(lost);
    expect(db.log).toContain('ROLLBACK');
    expect(db.log).not.toContain('COMMIT');
  });
});

test('which errors are the row\'s', () => {
  for (const code of ['22P02', '22021', '22P05', '22001', '23505', '23502', '23514', 'INVALID_LABEL_STATE', 'LABEL_MISSING_IDENTITY',
    'INVALID_PRODUCT_RELATIONSHIP_EDGE', 'MISSING_PREFILTER_REASONS']) expect(isRowDataError(pgError(code))).toBe(true);
  for (const code of ['08006', '57P01', '57014', '40001', '25P02', '53300', 'ECONNRESET', '', undefined]) expect(isRowDataError(pgError(code))).toBe(false);
  expect(isRowDataError(null)).toBe(false);
  // Class 23 is contained per row but marked: it fails the build at the end (a code bug, not bad data).
  for (const code of ['23505', '23503', '23502', '23514']) expect(isIntegrityViolation(pgError(code))).toBe(true);
  for (const code of ['22P02', '22021', 'INVALID_LABEL_STATE', '08006']) expect(isIntegrityViolation(pgError(code))).toBe(false);
});

test('an integrity violation is rolled back per row and marked; the other rows still write', async () => {
  const db = fakeDb({ failFor: new Map([['dup', pgError('23505', 'duplicate key value violates unique constraint "relationship_candidate_labels_pkey"')]]) });
  const result = await persistEdgesWithGlobalFanInCap({ edges: [edge('ok'), edge('dup')], cap: 8, queryFn: db.queryFn, runInClient: db.runInClient });
  expect(result.applied).toBe(1);
  expect(result.failed).toEqual([expect.objectContaining({ edge_id: 'dup', code: '23505', integrity: true })]);
});

test('many row failures still fail the build: at least 20 and more than 5% of the writes', () => {
  expect(writeFailureGateExceeded({ failed: 19, attempted: 400 })).toBe(false);
  expect(writeFailureGateExceeded({ failed: 20, attempted: 100 })).toBe(true);
  // Every write failed: not "a few bad rows", however small the build.
  expect(writeFailureGateExceeded({ failed: 19, attempted: 19 })).toBe(true);
  expect(writeFailureGateExceeded({ failed: 1, attempted: 1 })).toBe(true);
  expect(writeFailureGateExceeded({ failed: 4, attempted: 5 })).toBe(false);
  expect(writeFailureGateExceeded({ failed: 20, attempted: 400 })).toBe(false);
  expect(writeFailureGateExceeded({ failed: 21, attempted: 400 })).toBe(true);
  expect(writeFailureGateExceeded({ failed: 0, attempted: 0 })).toBe(false);
});

test('the failure line is one bounded line of ids and codes, no product text', () => {
  const failed = Array.from({ length: 25 }, (_, i) => ({ edge_id: `e${i}`, anchor_ref: `product:a${i}`, candidate_ref: `product:c${i}`,
    relation_type: 'related_product', label_state: 'generated', code: i % 2 ? '22P02' : '23505' }));
  const line = writeFailureLine(failed, { attempted: 500 });
  expect(line.endsWith('\n')).toBe(true);
  expect(line.trim().split('\n')).toHaveLength(1);
  const parsed = JSON.parse(line);
  expect(parsed).toMatchObject({ severity: 'WARNING', message: 'RELGRAPH_BUILD_WRITE_FAILED', write_failed_count: 25, attempted_write_count: 500,
    write_failed_by_code: { '22P02': 12, 23505: 13 } });
  expect(parsed.samples).toHaveLength(20);
  expect(Object.keys(parsed.samples[0]).sort()).toEqual(['anchor_ref', 'candidate_ref', 'code', 'edge_id', 'relation_type']);
  expect(JSON.parse(writeFailureLine(failed, { attempted: 30, gateFailed: true })).severity).toBe('ERROR');
  expect(parsed.write_integrity_violation_count).toBe(0);
  const withIntegrity = JSON.parse(writeFailureLine([{ ...failed[0], code: '23505', integrity: true }], { attempted: 500 }));
  expect(withIntegrity).toMatchObject({ severity: 'ERROR', write_integrity_violation_count: 1 });
  expect(writeFailureLine([])).toBe('');
});
