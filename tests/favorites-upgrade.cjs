// Generated fixtures only. The OS recycle operation is intercepted and simulated
// as a move inside this test's temporary directory; no personal files are read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron } = require('playwright-core');
const { samplePdf } = require('./pdf-fixture.cjs');

(async () => {
  const root = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-favorites-'));
  const library = path.join(temp, 'Library');
  const alpha = path.join(library, 'Alpha Pages');
  const targetFolder = path.join(temp, 'Shortcut Target');
  const bin = path.join(temp, 'Simulated Recycle Bin');
  for (const folder of [alpha, targetFolder, bin]) await fs.mkdir(folder, { recursive: true });
  for (let n = 1; n <= 3; n++) await sharp({ create: { width: 480, height: 680, channels: 3,
    background: { r: 65 + n * 20, g: 130, b: 150 } } }).jpeg().toFile(path.join(alpha, `${String(n).padStart(2, '0')}.jpg`));
  await sharp({ create: { width: 480, height: 680, channels: 3, background: '#b8c9a2' } }).webp().toFile(path.join(alpha, '04.webp'));
  await fs.copyFile(path.join(alpha, '01.jpg'), path.join(targetFolder, '01.jpg'));
  const archive = path.join(library, 'Collection.cbz');
  const pdf = path.join(library, 'Generated.pdf');
  await fs.writeFile(pdf, samplePdf(3));
  execFileSync(require('7zip-bin-full').path7z, ['a', '-tzip', archive, '.'], { cwd: alpha, windowsHide: true, stdio: 'ignore' });
  const folderLink = path.join(library, 'Folder Shortcut.lnk');
  const archiveLink = path.join(library, 'Archive Shortcut.lnk');
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'),
    args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [root, '--disable-gpu'], env });
  let win;
  try {
    win = await app.firstWindow();
    await win.getByText('故事，从这里开始').waitFor();
    await fs.mkdir(path.join(root, '.tools'), { recursive: true });
    await app.evaluate(({ shell, dialog }, { folderLink, archiveLink, targetFolder, archive, bin }) => {
      if (!shell.writeShortcutLink(folderLink, { target: targetFolder })) throw Error('Cannot create generated folder shortcut');
      if (!shell.writeShortcutLink(archiveLink, { target: archive })) throw Error('Cannot create generated archive shortcut');
      globalThis.__confirmTrash = 1;
      globalThis.__trashMode = 'ok';
      globalThis.__trashCalls = [];
      globalThis.__trashPrompts = [];
      dialog.showMessageBox = async (...args) => {
        globalThis.__trashPrompts.push(args.at(-1));
        return { response: globalThis.__confirmTrash, checkboxChecked: false };
      };
      shell.trashItem = async file => {
        globalThis.__trashCalls.push(file);
        if (globalThis.__trashMode === 'fail') throw Error('Simulated recycle failure');
        const nativeFs = process.getBuiltinModule('fs').promises;
        const nativePath = process.getBuiltinModule('path');
        await nativeFs.rename(file, nativePath.join(bin, globalThis.__trashCalls.length + '-' + nativePath.basename(file)));
      };
    }, { folderLink, archiveLink, targetFolder, archive, bin });
    const importPaths = async (files, mode = 'files') => {
      await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, Array.isArray(files) ? files : [files]);
      return win.evaluate(mode => window.manga.import(mode), mode);
    };
    await app.evaluate(({ dialog }, library) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [library] }); }, library);
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.waitForFunction(() => document.querySelectorAll('.book-card').length >= 4);
    const books = await win.evaluate(() => window.manga.list());
    const alphaBook = books.find(b => path.normalize(b.path) === alpha);
    const archiveBook = books.find(b => path.normalize(b.path) === archive);
    const pdfBook = books.find(b => path.normalize(b.path) === pdf);
    assert.ok(alphaBook && archiveBook && pdfBook, 'Folder, archive and PDF must all be indexed');
    const alphaTarget = { kind: 'book', bookId: alphaBook.id };
    const alphaCard = win.locator('.book-card').filter({ has: win.locator('.cover strong', { hasText: /^Alpha Pages$/ }) });
    await alphaCard.getByRole('button', { name: 'Alpha Pages 收藏', exact: true }).click();
    await win.waitForFunction(async id => (await window.manga.favorites()).some(f => f.target.bookId === id && f.rating === 0), alphaBook.id);
    for (const stars of [1, 2, 3, 4, 5, 0]) {
      await alphaCard.locator('.rating-menu summary').click();
      await alphaCard.getByRole('button', { name: stars + '星', exact: true }).click();
      await win.waitForFunction(async ({ id, stars }) => (await window.manga.favorites()).some(f => f.kind === 'book' && f.target.bookId === id && f.rating === stars), { id: alphaBook.id, stars });
    }
    const roots = await win.evaluate(() => window.manga.sources());
    const libraryRoot = roots.find(node => node.title === 'Library');
    const children = await win.evaluate(id => window.manga.children(id), libraryRoot.id);
    const folderSource = children.find(node => node.title === 'Folder Shortcut');
    const archiveSource = children.find(node => node.title === 'Archive Shortcut');
    assert.ok(folderSource && archiveSource);
    await win.evaluate(async ({ alphaBook, archiveBook, pdfBook, folderSource, archiveSource, root }) => {
      await window.manga.setFavorite({ kind: 'page', bookId: alphaBook.id, page: 1 }, 4);
      await window.manga.setFavorite({ kind: 'book', bookId: archiveBook.id }, 5);
      await window.manga.setFavorite({ kind: 'source', sourceId: folderSource.id }, 3);
      await window.manga.setFavorite({ kind: 'source', sourceId: archiveSource.id }, 2);
      await window.manga.setFavorite({ kind: 'source', sourceId: root.id }, 0);
      await window.manga.setFavorite({ kind: 'page', bookId: pdfBook.id, page: 1 }, 5);
      await window.manga.metadata(alphaBook.id, 'generated-tag', 'Generated Author');
    }, { alphaBook, archiveBook, pdfBook, folderSource, archiveSource, root: libraryRoot });
    assert.equal((await win.evaluate(() => window.manga.favorites('generated-tag'))).length, 2, 'Search must match parent book metadata for page favorites');
    assert.equal((await win.evaluate(() => window.manga.favorites('no-such-generated-title'))).length, 0);
    await assert.rejects(() => win.evaluate(target => window.manga.setFavorite(target, 6), alphaTarget));
    await assert.rejects(() => win.evaluate(target => window.manga.setFavorite(target, -1), alphaTarget));

    // Reordering pages must not redirect a favorite to the old numeric index.
    await fs.copyFile(path.join(alpha, '01.jpg'), path.join(alpha, '00.jpg'));
    let favorites = await win.evaluate(() => window.manga.favorites());
    const pageFavorite = favorites.find(f => f.kind === 'page' && f.bookId === alphaBook.id);
    const stable = await win.evaluate(id => window.manga.openFavorite(id), pageFavorite.id);
    assert.equal(stable.page, 2, 'Page favorite must follow its saved filename');
    assert.equal((await win.evaluate(id => window.manga.open(id), alphaBook.id))[stable.page].title, '02.jpg');
    const rootFavorite = favorites.find(f => f.kind === 'source' && f.sourceId === libraryRoot.id);
    const location = await win.evaluate(id => window.manga.openFavorite(id), rootFavorite.id);
    assert.ok(location.sourceId && location.bookIds.includes(alphaBook.id), 'Parent folder favorite must browse its descendant books');

    const decode = (bookId, page, thumbnail = true) => win.evaluate(async ({ bookId, page, thumbnail }) => {
      const pages = await window.manga.open(bookId);
      const url = thumbnail ? await window.manga.thumb(pages[page].url) : pages[page].url;
      return new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve(null);
        image.src = url;
      });
    }, { bookId, page, thumbnail });
    const pageList = await win.evaluate(id => window.manga.open(id), alphaBook.id);
    assert.ok(await decode(alphaBook.id, pageList.findIndex(p => p.title === '04.webp')), 'WebP must decode');
    assert.ok(await decode(alphaBook.id, pageList.findIndex(p => p.title === '04.webp'), false), 'Original WebP must decode in Chromium');
    const archivePages = await win.evaluate(id => window.manga.open(id), archiveBook.id);
    assert.ok(await decode(archiveBook.id, archivePages.findIndex(p => p.title === '04.webp'), false), 'WebP inside a CBZ must decode');
    assert.equal((await win.evaluate(id => window.manga.open(id), pdfBook.id)).length, 3);
    assert.ok(await decode(pdfBook.id, 1), 'PDF thumbnail must decode');
    assert.equal((await fs.readdir(path.join(temp, 'data', 'pdf-pages')).catch(() => [])).length, 0,
      'Listing and PDF thumbnails must not eagerly render full reader pages');
    const pdfFavorite = favorites.find(f => f.kind === 'page' && f.bookId === pdfBook.id);
    assert.equal((await win.evaluate(id => window.manga.openFavorite(id), pdfFavorite.id)).page, 1);
    for (const book of [archiveBook, pdfBook]) {
      await assert.rejects(() => win.evaluate(bookId => window.manga.trash({ kind: 'page', bookId, page: 0 }), book.id));
      await fs.access(book.path);
    }
    assert.equal((await app.evaluate(() => globalThis.__trashCalls)).length, 0, 'Archive/PDF page trash must not recycle the container');

    await win.reload();
    await win.getByRole('button', { name: /^☆\s*我的收藏$/ }).click();
    await win.waitForFunction(() => document.querySelectorAll('.favorite-card').length >= 7);
    await win.getByLabel('收藏评分', { exact: true }).selectOption('0');
    await win.waitForFunction(() => document.querySelectorAll('.favorite-card').length === 2);
    await win.getByLabel('收藏评分', { exact: true }).selectOption('-1');
    const pdfCard = win.locator('.favorite-card').filter({ has: win.locator('.cover strong', { hasText: pdfFavorite.title }) });
    await pdfCard.locator('.cover').click();
    await win.waitForFunction(() => document.querySelector('.spread img')?.naturalWidth > 0);
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), '2', 'PDF favorite must open its page in the reader');
    assert.ok((await fs.readdir(path.join(temp, 'data', 'pdf-pages'))).length > 0, 'Reader page must render PDF on demand');
    await win.getByRole('button', { name: /^☆\s*我的收藏$/ }).click();
    const imageCard = win.locator('.favorite-card').filter({ has: win.locator('.cover strong', { hasText: pageFavorite.title }) });
    await imageCard.locator('.cover').click();
    await win.waitForFunction(() => document.querySelector('.spread img')?.naturalWidth > 0);
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), '3', 'Page favorite must open its current filename position');
    await win.getByRole('button', { name: /^☆\s*我的收藏$/ }).click();
    const search = win.getByLabel('搜索书库或收藏', { exact: true });
    await search.fill('Alpha');
    await search.press('Enter');
    await win.waitForFunction(() => document.querySelectorAll('.favorite-card').length === 2);
    await win.waitForFunction(async () => (await window.manga.searchHistory()).includes('Alpha'));
    await search.fill('Collection');
    await search.press('Enter');
    await win.waitForFunction(async () => (await window.manga.searchHistory())[0] === 'Collection');
    await search.fill('Alpha');
    await search.press('Enter');
    const history = await win.evaluate(() => window.manga.searchHistory());
    assert.equal(history[0], 'Alpha');
    assert.equal(history.filter(q => q === 'Alpha').length, 1);
    await win.reload();
    assert.deepEqual(await win.evaluate(() => window.manga.searchHistory()), history);
    assert.equal((await win.evaluate(() => window.manga.favorites())).length, 7);
    await win.locator('.search-history summary').click();
    await win.locator('.search-history').getByRole('button', { name: 'Alpha', exact: true }).click();
    assert.equal(await search.inputValue(), 'Alpha');
    await win.locator('.search-history').getByRole('button', { name: '清空记录', exact: true }).click();
    await win.waitForFunction(async () => (await window.manga.searchHistory()).length === 0);

    // Cancellation/failure must preserve both the original file and database.
    const trashTarget = { kind: 'book', bookId: archiveBook.id };
    assert.equal(await win.evaluate(target => window.manga.trash(target), trashTarget), false);
    await fs.access(archive);
    assert.ok((await win.evaluate(() => window.manga.list())).some(b => b.id === archiveBook.id));
    await app.evaluate(() => { globalThis.__confirmTrash = 0; globalThis.__trashMode = 'fail'; });
    await assert.rejects(() => win.evaluate(target => window.manga.trash(target), trashTarget));
    await fs.access(archive);
    assert.ok((await win.evaluate(() => window.manga.favorites())).some(f => f.kind === 'book' && f.bookId === archiveBook.id));
    await app.evaluate(() => { globalThis.__trashMode = 'ok'; });
    assert.equal(await win.evaluate(id => window.manga.trash({ kind: 'source', sourceId: id }), archiveSource.id), true);
    await assert.rejects(() => fs.access(archiveLink));
    await fs.access(archive);
    assert.ok((await win.evaluate(() => window.manga.list())).some(b => b.id === archiveBook.id), 'Trashing a shortcut must preserve the target book');
    assert.ok(!(await win.evaluate(() => window.manga.favorites())).some(f => f.sourceId === archiveSource.id));
    const remainingPageFavorite = (await win.evaluate(() => window.manga.favorites())).find(f => f.kind === 'page' && f.bookId === alphaBook.id);
    assert.equal(await win.evaluate(target => window.manga.trash(target), remainingPageFavorite.target), true);
    await assert.rejects(() => fs.access(path.join(alpha, '02.jpg')));
    await fs.access(alpha);
    assert.ok(!(await win.evaluate(() => window.manga.favorites())).some(f => f.id === remainingPageFavorite.id));
    // Exercise the visible trash button and the renderer's post-trash refresh.
    await search.fill(archiveBook.title);
    await search.press('Enter');
    const archiveCard = win.locator('.book-card').filter({ has: win.locator('.cover strong', { hasText: archiveBook.title }) });
    await archiveCard.locator('.cover').click();
    await win.locator('.reader-actions-flat').getByRole('button', { name: archiveBook.title + ' 删除到回收站', exact: true }).click();
    await win.waitForFunction(async id => !(await window.manga.list()).some(book => book.id === id), archiveBook.id);
    await assert.rejects(() => fs.access(archive));
    assert.ok(!(await win.evaluate(() => window.manga.list())).some(b => b.id === archiveBook.id));
    assert.ok(!(await win.evaluate(() => window.manga.favorites())).some(f => f.bookId === archiveBook.id));
    const trashFolder = path.join(temp, 'Trash Folder');
    const trashChild = path.join(trashFolder, 'Child');
    await fs.mkdir(trashChild, { recursive: true });
    await fs.copyFile(path.join(alpha, '01.jpg'), path.join(trashChild, '01.jpg'));
    const extraBooks = await importPaths(trashFolder, 'folder');
    const childBook = extraBooks.find(book => path.normalize(book.path) === trashChild);
    const trashRoot = (await win.evaluate(() => window.manga.sources())).find(source => source.title === 'Trash Folder');
    assert.ok(childBook && trashRoot);
    await win.evaluate(async ({ child, source }) => {
      await window.manga.setFavorite({ kind: 'book', bookId: child }, 1);
      await window.manga.setFavorite({ kind: 'source', sourceId: source }, 0);
    }, { child: childBook.id, source: trashRoot.id });
    assert.equal(await win.evaluate(sourceId => window.manga.trash({ kind: 'source', sourceId }), trashRoot.id), true);
    await assert.rejects(() => fs.access(trashFolder));
    assert.ok(!(await win.evaluate(() => window.manga.list())).some(book => book.id === childBook.id));
    assert.ok(!(await win.evaluate(() => window.manga.favorites())).some(favorite => favorite.sourceId === trashRoot.id || favorite.bookId === childBook.id));
    const prompts = await app.evaluate(() => globalThis.__trashPrompts);
    assert.ok(prompts.every(prompt => prompt.defaultId === 1 && prompt.cancelId === 1), 'Trash confirmations must default to cancel');
    const result = { passed: true, stars: [0, 1, 2, 3, 4, 5], stablePageFavorite: true,
      searchedMetadata: true, historyPersisted: true, shortcutTargetPreserved: true,
      formats: ['JPEG', 'WebP', 'CBZ', 'PDF'], simulatedRecycleOnly: true };
    await fs.writeFile(path.join(root, '.tools/favorites-upgrade-validation.json'), JSON.stringify(result, null, 2));
    console.log('PASS: favorites, ratings, search/history, page identity, PDF/WebP and safe recycle semantics.', result);
  } catch (error) {
    if (win) await win.screenshot({ path: path.join(root, '.tools/favorites-upgrade-failure.png') }).catch(() => {});
    throw error;
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
