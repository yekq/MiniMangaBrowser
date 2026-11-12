// Real Everything SDK + generated fixtures; no personal files or records are used.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { _electron } = require('playwright-core');
const sharp = require('sharp');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-repair-'));
  const uid = randomUUID().slice(0, 8), source = path.join(temp, '漫画 Repair ' + uid);
  const destination = source + ' moved', alternative = source + ' other', data = path.join(temp, 'data');
  const art = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850"><rect width="600" height="850" fill="#6e9c88"/><circle cx="300" cy="300" r="150" fill="#d6e7a3"/></svg>';
  for (const dir of [source, alternative]) { await fs.mkdir(dir); for (let n = 0; n < 3; n++) await fs.writeFile(path.join(dir, `0${n}.svg`), art); }
  const env = { ...process.env, MINIMANGA_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'),
    args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [process.cwd(), '--disable-gpu'], env });
  let app = await launch(), win;
  const sql = (query, args = []) => app.evaluate(({ app }, { query, args }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite'), path = process.getBuiltinModule('node:path');
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'library.sqlite'));
    try { return db.prepare(query).all(...args); } finally { db.close(); }
  }, { query, args });
  const run = (query, args = []) => app.evaluate(({ app }, { query, args }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite'), path = process.getBuiltinModule('node:path');
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'library.sqlite'));
    try { return db.prepare(query).run(...args); } finally { db.close(); }
  }, { query, args });
  const api = (method, ...args) => win.evaluate(({ method, args }) => window.manga[method](...args), { method, args });
  const importPath = async (file, mode = 'folder') => {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await win.getByRole('button', { name: mode === 'folder' ? '＋ 添加目录' : '打开文件', exact: true }).first().click();
    await win.waitForFunction(async file => (await window.manga.list()).some(book => book.path === file), file);
  };
  const waitIndex = async (target, keyword, count = 1, requiredPath) => {
    const stop = Date.now() + 20000;
    do {
      const result = await api('repairSearch', target, keyword);
      if (result.items.length >= count && (!requiredPath || result.items.some(item => item.path === requiredPath))) return result;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < stop);
    throw Error('Everything did not index the generated fixture in time');
  };
  try {
    win = await app.firstWindow(); await win.getByText('故事，从这里开始').waitFor();
    const errors = []; win.on('pageerror', error => errors.push(error.message));
    await importPath(source);
    await win.locator('.cover').waitFor();
    let book = (await api('list'))[0];
    await api('metadata', book.id, 'generated, keep', 'Fixture author'); await api('progress', book.id, 1);
    await api('setFavorite', { kind: 'book', bookId: book.id }, 4);
    await api('setFavorite', { kind: 'page', bookId: book.id, page: 1 }, 5);
    const favoriteIds = (await api('favorites')).map(favorite => favorite.id).sort();
    await fs.rename(source, destination);
    const target = { kind: 'book', id: book.id };
    await waitIndex(target, path.basename(source), 2);
    let modal = win.getByRole('dialog', { name: '查找漫画新位置', exact: true });
    await win.locator('.cover').click(); await modal.waitFor();
    await win.waitForFunction(() => document.querySelectorAll('.repair-result').length >= 2);
    assert.equal(await modal.getByRole('button', { name: '修正路径并打开', exact: true }).isDisabled(), true);
    assert.equal((await api('list'))[0].path, source, 'Search must not change the path');
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('list'))[0].path, source, 'Cancel must not change records');
    const choices = await api('repairSearch', target, path.basename(source));
    await assert.rejects(api('repairApply', target, randomUUID()), /expired|过期/);
    const sourceId = (await api('sources'))[0].id;
    await assert.rejects(api('repairApply', { kind: 'source', id: sourceId }, choices.items[0].id), /expired|过期/);
    await win.locator('.cover').click(); await modal.waitFor();
    await modal.locator('.repair-result').filter({ hasText: destination }).getByRole('radio').check();
    await win.screenshot({ path: path.join(process.cwd(), '.tools/path-repair.png') });
    await modal.getByRole('button', { name: '修正路径并打开', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    await win.waitForFunction(() => document.querySelectorAll('.pages img').length === 3);
    book = (await api('list')).find(item => item.id === book.id);
    assert.equal(book.path, destination); assert.equal(book.author, 'Fixture author'); assert.match(book.tags, /keep/);
    const favorites = await api('favorites');
    assert.deepEqual(favorites.map(favorite => favorite.id).sort(), favoriteIds);
    assert.deepEqual(favorites.map(favorite => favorite.rating).sort(), [4, 5]);
    assert.ok(favorites.every(favorite => favorite.available));
    assert.equal((await api('sources'))[0].id, sourceId);
    assert.equal((await sql('SELECT path FROM sources WHERE id=?', [sourceId]))[0].path, destination);
    assert.equal((await sql('SELECT count(*) n FROM path_repairs'))[0].n, 1);
    // An interrupted AI write must block the repair before any database/node changes.
    await api('aiProfiles');
    const busyId = randomUUID(), secondDestination = destination + ' again';
    await fs.rename(destination, secondDestination);
    await run('INSERT INTO ai_edits(id,book_id,created,data) VALUES(?,?,?,?)', [busyId, book.id, Date.now(), JSON.stringify({
      id: busyId, bookId: book.id, bookPath: destination, bookTitle: book.title, status: 'generating' })]);
    const second = await waitIndex(target, path.basename(source), 1, secondDestination);
    const selected = second.items.find(item => item.path === secondDestination);
    await assert.rejects(api('repairApply', target, selected.id), /AI.*任务|AI job/);
    assert.equal((await api('list')).find(item => item.id === book.id).path, destination);
    await run('DELETE FROM ai_edits WHERE id=?', [busyId]);
    await win.locator('.source-row > button').filter({ hasText: book.title }).first().click();
    await modal.waitFor();
    await modal.locator('.repair-result').filter({ hasText: secondDestination }).getByRole('radio').check();
    await modal.getByRole('button', { name: '修正路径并打开', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    await win.waitForFunction(() => document.querySelectorAll('.pages img').length === 3);
    assert.equal((await api('list')).find(item => item.id === book.id).path, secondDestination);
    await app.close(); app = await launch(); win = await app.firstWindow();
    modal = win.getByRole('dialog', { name: '查找漫画新位置', exact: true });
    await win.locator('.cover').waitFor(); await win.locator('.cover').click();
    await win.waitForFunction(() => document.querySelectorAll('.pages img').length === 3);
    assert.equal(await modal.count(), 0, 'Repaired paths persist across restart');
    await win.getByRole('button', { name: '← 返回书库', exact: true }).click();
    // A stale indexed ZIP result is revalidated; manual selection remains available.
    const zipOld = path.join(temp, 'Archive ' + uid + '.zip'), zipMoved = path.join(temp, 'Archive ' + uid + ' moved.zip');
    execFileSync(require('7zip-bin-full').path7z, ['a', '-tzip', zipOld, '.'], { cwd: secondDestination, windowsHide: true, stdio: 'ignore' });
    await importPath(zipOld, 'files');
    const zipBook = (await api('list')).find(item => item.path === zipOld);
    await fs.rename(zipOld, zipMoved);
    await waitIndex({ kind: 'book', id: zipBook.id }, 'Archive ' + uid);
    await win.locator('.cover').filter({ hasText: zipBook.title }).click();
    const currentModal = win.getByRole('dialog', { name: '查找漫画新位置', exact: true });
    await currentModal.locator('.repair-result').filter({ hasText: zipMoved }).getByRole('radio').check();
    const zipFinal = path.join(temp, 'Final archive ' + uid + '.zip'); await fs.rename(zipMoved, zipFinal);
    const zipHash = createHash('sha256').update(await fs.readFile(zipFinal)).digest('hex');
    await currentModal.getByRole('button', { name: '修正路径并打开', exact: true }).click();
    await currentModal.getByRole('alert').waitFor();
    assert.equal((await api('list')).find(item => item.id === zipBook.id).path, zipOld);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, zipFinal);
    await currentModal.getByRole('button', { name: '手动选择文件', exact: true }).click();
    await currentModal.getByRole('button', { name: '修正路径并打开', exact: true }).click();
    await currentModal.waitFor({ state: 'detached' });
    await win.waitForFunction(() => document.querySelectorAll('.pages img').length === 3);
    assert.equal(createHash('sha256').update(await fs.readFile(zipFinal)).digest('hex'), zipHash);
    // Restore an orphan AI book and merge an already imported destination safely.
    await win.getByRole('button', { name: '← 返回书库', exact: true }).click();
    const orphanOld = path.join(temp, 'Orphan ' + uid), orphanNew = orphanOld + ' moved';
    await fs.mkdir(orphanNew); for (let n = 0; n < 3; n++) await fs.writeFile(path.join(orphanNew, `0${n}.svg`), art);
    await importPath(orphanNew);
    const existing = (await api('list')).find(item => item.path === orphanNew);
    await api('metadata', existing.id, 'destination tag', 'Destination author');
    await api('setFavorite', { kind: 'book', bookId: existing.id }, 4);
    await api('aiProfiles');
    const orphanId = randomUUID(), editId = randomUUID(), favoriteId = randomUUID(), output = path.join(temp, 'Generated result.png');
    await sharp({ create: { width: 10, height: 10, channels: 3, background: 'teal' } }).png().toFile(output);
    const outputHash = createHash('sha256').update(await fs.readFile(output)).digest('hex');
    await run('INSERT INTO ai_edits(id,book_id,created,data) VALUES(?,?,?,?)', [editId, orphanId, Date.now(), JSON.stringify({
      id: editId, bookId: orphanId, bookPath: orphanOld, bookTitle: 'Orphan ' + uid, pageTitle: '01.svg', page: 1,
      status: 'ready', outputFile: output, destination: orphanOld, prompt: 'generated fixture', profileId: 'fixture', profileName: 'Fixture', createdAt: Date.now() })]);
    const key = createHash('sha256').update(JSON.stringify(['book', orphanOld, null])).digest('hex');
    await run('INSERT INTO favorites(id,target_key,kind,title,rating,book_id,book_path,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [favoriteId, key, 'book', 'Orphan ' + uid, 5, orphanId, orphanOld, Date.now()]);
    await waitIndex({ kind: 'ai', id: editId }, 'Orphan ' + uid);
    await win.getByRole('button', { name: '✦　AI修改记录', exact: false }).click();
    await win.locator('.ai-book-title').filter({ hasText: 'Orphan ' + uid }).click();
    await currentModal.waitFor();
    await currentModal.locator('.repair-result').filter({ hasText: orphanNew }).getByRole('radio').check();
    await currentModal.getByRole('button', { name: '修正路径并打开', exact: true }).click();
    await currentModal.waitFor({ state: 'detached' });
    await win.waitForFunction(() => document.querySelectorAll('.spread img').length === 1);
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), '2');
    const restored = (await api('list')).find(book => book.id === orphanId);
    assert.equal(restored.path, orphanNew); assert.equal(restored.author, 'Destination author');
    assert.equal((await api('list')).some(book => book.id === existing.id), false);
    const mergedFavorites = (await api('favorites')).filter(item => item.bookId === orphanId && item.kind === 'book');
    assert.equal(mergedFavorites.length, 1); assert.equal(mergedFavorites[0].rating, 5);
    const row = (await sql('SELECT data FROM ai_edits WHERE id=?', [editId]))[0];
    assert.equal(JSON.parse(row.data).bookPath, orphanNew);
    assert.equal(JSON.parse(row.data).destination, orphanNew);
    assert.equal(createHash('sha256').update(await fs.readFile(output)).digest('hex'), outputHash);
    assert.deepEqual(errors, []);
    console.log('PASS: real Everything SDK, ambiguous candidates/cancel, folder/ZIP repair, stale results/manual fallback, metadata/favorites, AI orphan restore/destination merge, persistence and immutable files.');
    await fs.writeFile(path.join(process.cwd(), '.tools/path-repair-validation' + (process.env.MINIMANGA_PACKAGED ? '-packaged' : '') + '.json'),
      JSON.stringify({ passed: true, everything: 'real local SDK', fixturesOnly: true }, null, 2));
  } catch (error) {
    if (win) await win.screenshot({ path: path.join(process.cwd(), '.tools/path-repair-failure.png'), timeout: 5000 }).catch(() => {});
    throw error;
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
