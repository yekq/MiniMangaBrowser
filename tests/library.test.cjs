// Exercise the real library handlers and database worker against generated files.
// Native dialogs and Recycle Bin calls are replaced; nothing touches personal data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');

function load(file, replacements) {
  const output = ts.transpileModule(syncFs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', output)(mod, mod.exports, name => replacements[name] || require(name));
  return mod.exports;
}

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-library-'));
  let receive, next = 0;
  const pending = new Map();
  load('src/main/worker.ts', { 'node:worker_threads': {
    workerData: { database: path.join(temp, 'library.sqlite') },
    parentPort: {
      on: (_, callback) => { receive = callback; },
      postMessage: response => {
        const promise = pending.get(response.id); pending.delete(response.id);
        if (response.error) promise.reject(Error(response.error)); else promise.resolve(response.value);
      },
    },
  } });
  const db = {
    call: (op, data) => new Promise((resolve, reject) => {
      const id = ++next; pending.set(id, { resolve, reject }); receive({ id, op, ...data });
    }),
    prepare(sql) { return Object.fromEntries(['all', 'get', 'run'].map(op => [op, (...args) => db.call(op, { sql, args })])); },
  };
  const native = { answer: 0, failure: false, moved: [], prompts: [] };
  const shell = { trashItem: async file => {
    if (native.failure) throw Error('No Recycle Bin on this volume');
    native.moved.push(file);
    await fs.rename(file, path.join(temp, 'recycled-' + randomUUID()));
  } };
  const dialog = { showMessageBox: async (_, options) => { native.prompts.push(options); return { response: native.answer }; } };
  const nodes = new Map(), aliases = new Map(), assets = new Map(), archivePages = new Map();
  const pages = async file => {
    if (archivePages.has(file)) return archivePages.get(file);
    const stat = await fs.stat(file);
    const files = stat.isDirectory() ? (await fs.readdir(file)).filter(n => /\.(jpg|webp)$/i.test(n)).sort().map(n => path.join(file,n)) : [file];
    return files.map((f, index) => {
      const url = 'manga://asset/' + f;
      assets.set(url, f);
      return { id: String(index), title: path.basename(f), url };
    });
  };
  const deps = { db, nodes, target: async file => aliases.get(file) || file, pages,
    resolve: async url => assets.get(url), thumb: async url => url, getWindow: () => ({}) };
  const { createLibraryHandlers } = load('src/main/library.ts', { electron: { dialog, shell } });
  const api = createLibraryHandlers(deps);
  const folder = path.join(temp, 'Generated comic'); await fs.mkdir(folder);
  for (const name of ['01.jpg','02.webp']) await fs.writeFile(path.join(folder,name), 'generated image fixture');
  const bookId = randomUUID();
  await db.prepare('INSERT INTO books(id,path,title,tags,author) VALUES(?,?,?,?,?)').run(bookId,folder,'Generated comic','adventure','Sample author');
  return { temp, db, api, deps, createLibraryHandlers, native, nodes, aliases, folder, bookId, archivePages };
}

test('favorites keep zero stars, search metadata, validate ratings, and follow stable page names', async () => {
  const f = await fixture();
  await f.api.setFavorite({ kind: 'book', bookId: f.bookId }, 0);
  await f.api.setFavorite({ kind: 'page', bookId: f.bookId, page: 1 }, 5);
  await assert.rejects(f.api.setFavorite({ kind: 'book', bookId: f.bookId }, 6));
  let favorites = await f.api.favorites('Sample author');
  assert.equal(favorites.length, 2);
  assert.deepEqual(favorites.map(item => item.rating), [5,0]);
  assert.equal((await f.api.favorites('%')).length, 0, 'LIKE metacharacters are literal searches');
  await fs.writeFile(path.join(f.folder,'00.jpg'), 'generated image fixture');
  favorites = await f.api.favorites();
  const page = favorites.find(item => item.kind === 'page');
  assert.equal(page.target.page, 2);
  assert.equal((await f.api.openFavorite(page.id)).page, 2);
  assert.ok((await f.api.favoriteCover(page.id)).endsWith('02.webp'));
  await f.api.removeFavorite(page.id);
  assert.equal((await f.api.favorites()).length, 1);
});

test('source aliases persist independently and empty parent collections open a bounded library scope', async () => {
  const f = await fixture();
  const collection = path.join(f.temp, 'Collection'); await fs.mkdir(collection);
  const nested = path.join(collection,'Nested'); await fs.mkdir(nested);
  const sibling = collection + '-other'; await fs.mkdir(sibling);
  const nestedId = randomUUID(), siblingId = randomUUID();
  await f.db.prepare('INSERT INTO books(id,path,title) VALUES(?,?,?)').run(nestedId,nested,'Nested');
  await f.db.prepare('INSERT INTO books(id,path,title) VALUES(?,?,?)').run(siblingId,sibling,'Sibling');
  const link = path.join(f.temp,'My collection.lnk'); await fs.writeFile(link,'generated shortcut fixture');
  f.aliases.set(link,collection); f.nodes.set('collection',link);
  await f.api.setFavorite({kind:'source',sourceId:'collection'},3);
  const favorites = await f.api.favorites();
  const restartedNodes = new Map();
  const restarted = f.createLibraryHandlers({...f.deps,nodes:restartedNodes});
  await restarted.favorites();
  assert.equal(restartedNodes.get('collection'),link);
  const location = await restarted.openFavorite(favorites[0].id);
  assert.deepEqual(location.bookIds,[nestedId]);
  assert.equal(location.sourceId,'collection');
  assert.equal((await f.db.prepare('SELECT path FROM sources WHERE id=?').get('collection')).path,link);
});

test('search history persists, deduplicates, trims to thirty, and can be cleared', async () => {
  const f = await fixture();
  for (let i = 0; i < 35; i++) await f.api.rememberSearch('query ' + i);
  await f.api.rememberSearch(' Query 34 ');
  assert.equal((await f.api.searchHistory()).length,30);
  assert.equal((await f.api.searchHistory()).filter(q=>q.toLowerCase()==='query 34').length,1);
  const reopened = f.createLibraryHandlers({...f.deps});
  assert.deepEqual(await reopened.searchHistory(),await f.api.searchHistory());
  await f.api.clearSearchHistory();
  assert.deepEqual(await reopened.searchHistory(),[]);
});

test('trash cancellation and OS failure keep data; shortcut trash preserves target and book', async () => {
  const f = await fixture();
  const link = path.join(f.temp,'Comic shortcut.lnk'); await fs.writeFile(link,'generated shortcut fixture');
  f.aliases.set(link,f.folder); f.nodes.set('shortcut',link);
  await f.db.prepare('INSERT INTO sources(id,path,title) VALUES(?,?,?)').run('shortcut',link,'Comic shortcut');
  await f.api.setFavorite({kind:'source',sourceId:'shortcut'},4);
  await f.api.setFavorite({kind:'book',bookId:f.bookId},0);
  f.native.answer = 1;
  assert.equal(await f.api.trash({kind:'source',sourceId:'shortcut'}),false);
  assert.equal((await f.api.favorites()).length,2);
  await fs.access(link);
  f.native.answer = 0; f.native.failure = true;
  await assert.rejects(f.api.trash({kind:'source',sourceId:'shortcut'}),/No Recycle Bin/);
  await fs.access(link);
  assert.equal((await f.api.favorites()).length,2);
  f.native.failure = false;
  assert.equal(await f.api.trash({kind:'source',sourceId:'shortcut'}),true);
  assert.deepEqual(f.native.moved,[link]);
  await fs.access(f.folder);
  assert.equal((await f.api.favorites()).length,1);
  assert.ok(await f.db.prepare('SELECT id FROM books WHERE id=?').get(f.bookId));
});

test('trashing a physical page cleans its favorite but cannot trash an archive or PDF page', async () => {
  const f = await fixture();
  await f.api.setFavorite({kind:'book',bookId:f.bookId},2);
  await f.api.setFavorite({kind:'page',bookId:f.bookId,page:1},5);
  await f.api.trash({kind:'page',bookId:f.bookId,page:1});
  assert.deepEqual(f.native.moved,[path.join(f.folder,'02.webp')]);
  assert.equal((await f.api.favorites()).length,1);
  assert.equal((await f.db.prepare('SELECT pages FROM books WHERE id=?').get(f.bookId)).pages,1);
  for (const ext of ['zip','pdf']) {
    const file = path.join(f.temp,'Container.'+ext); await fs.writeFile(file,'generated container fixture');
    const id=randomUUID(); await f.db.prepare('INSERT INTO books(id,path,title) VALUES(?,?,?)').run(id,file,'Container');
    f.archivePages.set(file,[{id:'0',title:'01.jpg',url:'manga://page/fixture/0'}]);
    const previousPrompts=f.native.prompts.length;
    await assert.rejects(f.api.trash({kind:'page',bookId:id,page:0}),/cannot be trashed individually/);
    assert.equal(f.native.prompts.length,previousPrompts);
    await fs.access(file);
  }
});
