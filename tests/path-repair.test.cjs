const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto'), ts = require('typescript');
function load(file, replacements = {}, clock = Date) {
  const code = ts.transpileModule(sync.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'Date', code)(mod, mod.exports, name => replacements[name] || require(name), clock);
  return mod.exports;
}
async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-repair-unit-'));
  let receive, sequence = 0; const pending = new Map();
  load('src/main/worker.ts', { 'node:worker_threads': { workerData: { database: path.join(temp, 'library.sqlite') }, parentPort: {
    on: (_, fn) => { receive = fn; }, postMessage: result => { const p = pending.get(result.id); pending.delete(result.id); result.error ? p.reject(Error(result.error)) : p.resolve(result.value); },
  } } });
  const db = { call: (op, data) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); receive({ id, op, ...data }); }),
    prepare(sql) { return Object.fromEntries(['all', 'get', 'run'].map(op => [op, (...args) => db.call(op, { sql, args })])); } };
  const old = path.join(temp, 'Old comic collection'), moved = path.join(temp, 'New comic collection');
  const child = path.join(old, 'Child'); await fs.mkdir(child, { recursive: true }); await fs.writeFile(path.join(child, '01.jpg'), 'generated fixture bytes');
  const rootId = randomUUID(), bookId = randomUUID();
  await db.prepare('INSERT INTO sources(id,path,title) VALUES(?,?,?)').run(rootId, old, 'Collection');
  await db.prepare('INSERT INTO books(id,path,title,pages,progress,tags,author) VALUES(?,?,?,?,?,?,?)').run(bookId, child, 'Child', 10, 6, 'keep', 'author');
  const nodes = new Map([[rootId, old]]), clock = { now: Date.now() }, state = { hits: [], failure: false, selected: null };
  const pages = async file => (await fs.readdir(file)).filter(name => /\.jpg$/.test(name)).map((title, i) => ({ id: String(i), title, url: 'manga://fixture/' + i }));
  const { createPathRepair } = load('src/main/pathRepair.ts', {
    electron: { dialog: { showOpenDialog: async () => ({ canceled: !state.selected, filePaths: state.selected ? [state.selected] : [] }) } },
    './everything': { searchEverything: async () => { if (state.failure) throw Error('Everything unavailable'); return { items: state.hits, total: state.hits.length }; } },
  }, { now: () => clock.now });
  const api = createPathRepair({ db, nodes, target: async file => file, pages, helperDirectory: temp, getWindow: () => ({}) });
  return { temp, db, old, moved, child, rootId, bookId, nodes, state, clock, api, target: { kind: 'source', id: rootId } };
}

test('collection relocation updates descendants, favorites, exclusions and AI links atomically', async () => {
  const f = await fixture(), favoriteId = randomUUID(), aiId = randomUUID();
  const saved = path.join(f.child, 'saved.jpg'); await fs.writeFile(saved, 'saved generated result');
  const key = createHash('sha256').update(JSON.stringify(['book', f.child, null])).digest('hex');
  await f.db.prepare('INSERT INTO favorites(id,target_key,kind,title,rating,book_id,book_path,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(favoriteId, key, 'book', 'Child', 5, f.bookId, f.child, 1);
  await f.db.prepare('INSERT INTO source_exclusions(path) VALUES(?)').run(path.join(f.old, 'Excluded'));
  await f.db.prepare('CREATE TABLE ai_edits(id TEXT PRIMARY KEY,book_id TEXT,created INTEGER,data TEXT)').run();
  await f.db.prepare('INSERT INTO ai_edits VALUES(?,?,?,?)').run(aiId, f.bookId, 1, JSON.stringify({
    id: aiId, bookId: f.bookId, bookPath: f.child, destination: f.child, savedPath: saved, status: 'saved' }));
  await fs.rename(f.old, f.moved);
  f.state.hits = [{ path: f.moved, kind: 'folder' }];
  const result = await f.api.repairSearch(f.target, 'collection');
  await f.api.repairApply(f.target, result.items[0].id);
  const child = path.join(f.moved, 'Child');
  const book = await f.db.prepare('SELECT * FROM books WHERE id=?').get(f.bookId);
  assert.equal(book.path, child); assert.equal(book.progress, 6); assert.equal(book.tags, 'keep'); assert.equal(book.author, 'author');
  const favorite = await f.db.prepare('SELECT * FROM favorites WHERE id=?').get(favoriteId);
  assert.equal(favorite.book_path, child); assert.equal(favorite.rating, 5);
  assert.equal((await f.db.prepare('SELECT * FROM source_exclusions').get()).path, path.join(f.moved, 'Excluded'));
  const ai = JSON.parse((await f.db.prepare('SELECT data FROM ai_edits WHERE id=?').get(aiId)).data);
  assert.equal(ai.bookPath, child); assert.equal(ai.destination, child); assert.equal(ai.savedPath, path.join(child, 'saved.jpg'));
  assert.equal(await fs.readFile(ai.savedPath, 'utf8'), 'saved generated result');
  assert.equal(f.nodes.get(f.rootId), f.moved);
  const audit = await f.db.prepare('SELECT * FROM path_repairs').get();
  assert.equal(JSON.parse(audit.before_data).books[0].path, f.child);
});

test('Everything failure/cancel leave records unchanged; manual location still repairs them', async () => {
  const f = await fixture(); await fs.rename(f.old, f.moved);
  f.state.failure = true;
  await assert.rejects(f.api.repairSearch(f.target, 'name'), /Everything unavailable/);
  assert.equal(await f.api.repairBrowse(f.target, 'folder'), null);
  assert.equal((await f.db.prepare('SELECT path FROM sources WHERE id=?').get(f.rootId)).path, f.old);
  f.state.selected = f.moved;
  const manual = await f.api.repairBrowse(f.target, 'folder');
  await f.api.repairApply(f.target, manual.id);
  assert.equal((await f.db.prepare('SELECT path FROM sources WHERE id=?').get(f.rootId)).path, f.moved);
});

test('expired candidates and an original location that reappears cannot silently redirect records', async () => {
  const f = await fixture(); await fs.rename(f.old, f.moved);
  f.state.hits = [{ path: f.moved, kind: 'folder' }];
  const first = await f.api.repairSearch(f.target, 'name'); f.clock.now += 600001;
  await assert.rejects(f.api.repairApply(f.target, first.items[0].id), /过期|expired/);
  const next = await f.api.repairSearch(f.target, 'name');
  await fs.mkdir(f.old);
  await assert.rejects(f.api.repairApply(f.target, next.items[0].id), /恢复|available/);
  assert.equal(f.nodes.get(f.rootId), f.old);
  assert.equal((await f.db.prepare('SELECT path FROM sources WHERE id=?').get(f.rootId)).path, f.old);
});

test('transaction preconditions reject stale snapshots and roll back every write', async () => {
  const f = await fixture();
  await assert.rejects(f.db.call('transaction', {
    checks: [{ sql: 'SELECT title FROM books WHERE id=?', args: [f.bookId], expected: { title: 'changed by another operation' } }],
    statements: [{ sql: 'UPDATE books SET title=? WHERE id=?', args: ['must not persist', f.bookId] }],
  }), /记录已发生变化|Records changed/);
  assert.equal((await f.db.prepare('SELECT title FROM books WHERE id=?').get(f.bookId)).title, 'Child');
  await f.db.prepare('UPDATE books SET title=? WHERE id=?').run('valid after rollback', f.bookId);
});

test('Everything keyword operators remain inside a quoted name and blank names are rejected', () => {
  const { literalSearch } = load('src/main/everything.ts');
  const text = literalSearch('漫画 " | folder: example');
  assert.ok(text.endsWith('"漫画   | folder: example"'));
  assert.throws(() => literalSearch('  "  '));
});
