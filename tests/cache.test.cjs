const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs'), path = require('node:path'), os = require('node:os');
const ts = require('typescript');

function cacheModule() {
  const counters = { scans: 0, stats: 0 }, clock = { now: Date.now() };
  const wrapped = { ...fs,
    readdir: (...args) => { counters.scans++; return fs.readdir(...args); },
    stat: (...args) => { counters.stats++; return fs.stat(...args); },
  };
  const output = ts.transpileModule(sync.readFileSync(path.join(__dirname, '../src/main/cache.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'Date', output)(mod, mod.exports,
    name => name === 'node:fs/promises' ? wrapped : require(name), { now: () => clock.now });
  return { ...mod.exports, counters, clock };
}

test('thumbnail bursts scan once, then account for individual writes and replacements', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-cache-bounds-'));
  const { trimCache, counters } = cacheModule();
  const files = Array.from({ length: 120 }, (_, n) => path.join(root, n.toString(16).padStart(64, '0') + '.jpg'));
  await Promise.all(files.map(file => fs.writeFile(file, 'generated cache data')));
  await Promise.all(files.slice(0, 30).map(file => trimCache(root, 1e6, file)));
  assert.equal(counters.scans, 1);
  assert.equal(counters.stats, files.length + 30);
  await fs.writeFile(files[0], Buffer.alloc(4096));
  await trimCache(root, 1e6, files[0]);
  assert.equal(counters.scans, 1);
  assert.equal(counters.stats, files.length + 31);
});

test('quota eviction preserves queued outputs, non-cache files, directories and outside files', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-cache-safety-'));
  const root = path.join(temp, 'cache'); await fs.mkdir(root);
  const notes = path.join(root, 'notes.txt'), outside = path.join(temp, 'aa.jpg');
  await fs.writeFile(notes, 'source must remain'); await fs.writeFile(outside, 'outside must remain');
  await fs.mkdir(path.join(root, 'dead.jpg'));
  const files = Array.from({ length: 20 }, (_, n) => path.join(root, n.toString(16).padStart(4, '0') + '.jpg'));
  await Promise.all(files.map(file => fs.writeFile(file, Buffer.alloc(10))));
  const { trimCache, counters } = cacheModule();
  await Promise.all(files.map(file => trimCache(root, 10, file)));
  await fs.access(files.at(-1));
  const remaining = (await fs.readdir(root)).filter(name => /^\d[\da-f]*\.jpg$/.test(name));
  assert.equal(remaining.length, 1);
  const scans = counters.scans;
  await trimCache(root, 0, outside);
  assert.equal(counters.scans, scans, 'outside keep must be rejected before scanning');
  assert.equal(await fs.readFile(notes, 'utf8'), 'source must remain');
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside must remain');
  assert.equal((await fs.stat(path.join(root, 'dead.jpg'))).isDirectory(), true);
});

test('periodic reconciliation accounts for external cache changes and missing files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-cache-refresh-'));
  const keep = path.join(root, 'ff.jpg'), older = path.join(root, 'aa.jpg');
  await fs.writeFile(keep, Buffer.alloc(10));
  const { trimCache, counters, clock } = cacheModule();
  await trimCache(root, 10, keep);
  await fs.writeFile(older, Buffer.alloc(40)); await fs.utimes(older, new Date(1), new Date(1));
  clock.now += 60001;
  await trimCache(root, 10, keep);
  assert.equal(counters.scans, 2);
  await assert.rejects(fs.access(older));
  await fs.unlink(keep); await trimCache(root, 10, keep);
  await fs.writeFile(keep, Buffer.alloc(10)); await trimCache(root, 10, keep);
  assert.equal((await fs.stat(keep)).size, 10);
});
