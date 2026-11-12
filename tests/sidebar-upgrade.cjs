// All filesystem and reading tests use generated fixtures and isolated app data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');

(async () => {
  const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-sidebar-'));
  const shelf = path.join(temp, 'Generated shelf');
  const target = path.join(shelf, '24 Series', 'Volume 2', 'Target Comic');
  const art = n => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850"><rect width="600" height="850" fill="hsl(${n * 12},30%,55%)"/><circle cx="300" cy="300" r="130" fill="#dfeac2"/><text x="180" y="350" font-size="100">${n}</text></svg>`;
  await fs.mkdir(target, { recursive: true });
  for (let p = 1; p <= 3; p++) await fs.writeFile(path.join(target, p + '.svg'), art(p));
  for (let n = 1; n < 24; n++) {
    const folder = path.join(shelf, String(n).padStart(2, '0') + ' Example');
    await fs.mkdir(folder); await fs.writeFile(path.join(folder, '1.svg'), art(n));
  }
  const archive = path.join(path.dirname(target), 'Target Archive.cbz');
  execFileSync(require('7zip-bin-full').path7z, ['a', '-tzip', archive, '.'], { cwd: target, windowsHide: true, stdio: 'ignore' });
  const outside = path.join(temp, 'Outside comic');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, '1.svg'), art(5));
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'),
    args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [root, '--disable-gpu'], env });
  let win;
  try {
    win = await app.firstWindow();
    const errors = []; win.on('pageerror', error => errors.push(error.message));
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ shell, dialog }, shelf) => {
      globalThis.__sidebarRevealCalls = 0;
      shell.showItemInFolder = () => { globalThis.__sidebarRevealCalls++; };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shelf] });
    }, shelf);
    const sidebar = win.locator('.library-sidebar'), tree = win.locator('.source-tree');
    const splitter = win.getByRole('separator', { name: '调整侧栏宽度', exact: true });
    const layout = await win.evaluate(() => {
      const aside = document.querySelector('.library-sidebar').getBoundingClientRect(), tree = document.querySelector('.source-tree').getBoundingClientRect();
      const language = document.querySelector('select[aria-label="Language"]');
      return { asideHeight: aside.height, treeHeight: tree.height, languageInHeader: !!language.closest('header'),
        languageInAside: !!language.closest('aside'), languageRight: language.getBoundingClientRect().right, viewport: innerWidth };
    });
    assert.ok(layout.treeHeight > layout.asideHeight * .55, JSON.stringify(layout));
    assert.equal(layout.languageInHeader, true); assert.equal(layout.languageInAside, false);
    assert.ok(layout.viewport - layout.languageRight < 60);
    const initial = (await sidebar.boundingBox()).width;
    const handle = await splitter.boundingBox();
    await win.mouse.move(handle.x + handle.width / 2, handle.y + 180); await win.mouse.down();
    await win.mouse.move(handle.x + handle.width / 2 + 120, handle.y + 180, { steps: 8 }); await win.mouse.up();
    const dragged = (await sidebar.boundingBox()).width;
    assert.ok(Math.abs(dragged - initial - 120) < 2, `Drag ${initial} -> ${dragged}`);
    assert.equal(await win.locator('body').evaluate(el => el.classList.contains('sidebar-resizing')), false);
    await splitter.press('ArrowLeft'); assert.equal(Math.round((await sidebar.boundingBox()).width), Math.round(dragged - 16));
    const saved = (await sidebar.boundingBox()).width;
    await win.reload(); await win.getByText('故事，从这里开始').waitFor();
    assert.ok(Math.abs((await sidebar.boundingBox()).width - saved) < 1, 'Width must persist');
    await win.locator('select[aria-label=Language]').selectOption('en');
    await win.reload(); await win.getByText('Every story starts here').waitFor();
    assert.equal(await win.locator('header select[aria-label=Language]').inputValue(), 'en');
    await win.locator('select[aria-label=Language]').selectOption('zh');
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.waitForFunction(() => document.querySelectorAll('.cover').length === 9);
    // Deep books are intentionally absent until their parent collection is opened.
    assert.equal((await win.evaluate(() => window.manga.list())).some(b => b.title === 'Target Comic'), false);
    for (const title of ['Generated shelf', '24 Series', 'Volume 2']) {
      await win.locator('.source-row > button').filter({ hasText: title }).first().click();
    }
    await win.waitForFunction(async () => (await window.manga.list()).some(b => b.title === 'Target Comic'));
    const openBook = async title => {
      await win.locator('.search').fill(title);
      await win.locator('.cover').filter({ hasText: title }).click();
      await win.locator('.pages button').first().click();
    };
    await openBook('Target Comic');
    await win.getByLabel('Page', { exact: true }).fill('2');
    const all = await win.evaluate(() => window.manga.list());
    const book = all.find(book => book.title === 'Target Comic');
    const chain = await win.evaluate(id => window.manga.locateBook(id), book.id);
    assert.equal(chain.length, 4);
    await assert.rejects(win.evaluate(() => window.manga.locateBook('invalid-id')));
    await win.getByRole('button', { name: '定位漫画', exact: true }).click();
    const selected = win.locator('.source-row.source-current > button[aria-current="true"]');
    await selected.waitFor();
    assert.match(await selected.innerText(), /Target Comic/);
    assert.equal(await selected.count(), 1);
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), '2');
    assert.equal(await win.locator('.spread img').count(), 1);
    assert.equal(await app.evaluate(() => globalThis.__sidebarRevealCalls), 0);
    const visible = await selected.evaluate(el => {
      const a = el.getBoundingClientRect(), t = document.querySelector('.source-tree').getBoundingClientRect();
      return a.top >= t.top && a.bottom <= t.bottom + 1;
    });
    assert.equal(visible, true, 'Selected comic must scroll into the independent list');
    assert.ok(await tree.evaluate(el => el.scrollTop > 0));
    assert.equal(await win.getByRole('button', { name: '定位漫画', exact: true }).evaluate(el => el.previousElementSibling.textContent), '定位');
    // Collapse a parent; repeated locate must reopen it even with the same ID.
    await win.locator(`.source-row[data-source-id="${chain[1]}"] > button`).first().click();
    await selected.waitFor({ state: 'detached' });
    await win.getByRole('button', { name: '定位漫画', exact: true }).click();
    await selected.waitFor();
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), '2');
    await win.screenshot({ path: path.join(root, '.tools/sidebar-upgrade.png') });
    // Archives use their own leaf in the same nested path.
    await win.getByRole('button', { name: '← 返回书库', exact: true }).click();
    await openBook('Target Archive.cbz');
    await win.getByRole('button', { name: '定位漫画', exact: true }).click();
    await win.waitForFunction(() => document.querySelector('.source-current > button[aria-current="true"]')?.textContent.includes('Target Archive.cbz'));
    assert.equal(await selected.getAttribute('aria-expanded'), null);
    // A new sibling book need not already be a sidebar root or library record.
    const late = path.join(path.dirname(target), 'Late comic');
    await fs.mkdir(late); await fs.writeFile(path.join(late, '1.svg'), art(7));
    const current = (await win.evaluate(() => window.manga.list())).find(book => book.title === 'Target Archive.cbz');
    const choices = await win.evaluate(id => window.manga.readingChoices(id), current.id);
    const lateItem = choices.items.find(item => item.title === 'Late comic');
    const lateBook = await win.evaluate(id => window.manga.openSource(id), lateItem.id);
    const lateChain = await win.evaluate(id => window.manga.locateBook(id), lateBook.id);
    assert.equal(lateChain.length, 4);
    // Known shortcut route into an external directory.
    const alias = path.join(shelf, 'External alias.lnk');
    await app.evaluate(({ shell }, { alias, outside }) => shell.writeShortcutLink(alias, { target: outside }), { alias, outside });
    const sources = await win.evaluate(() => window.manga.sources());
    const children = await win.evaluate(id => window.manga.children(id), sources[0].id);
    const aliasNode = children.find(node => node.title === 'External alias');
    const aliasBook = await win.evaluate(id => window.manga.openSource(id), aliasNode.id);
    const aliasChain = await win.evaluate(id => window.manga.locateBook(id), aliasBook.id);
    assert.deepEqual(aliasChain, [sources[0].id, aliasNode.id]);
    // No source exists for this favorite/read-next style record: add one direct entry only.
    const orphan = path.join(temp, 'Orphan shelf', 'Orphan comic');
    await fs.mkdir(orphan, { recursive: true }); await fs.writeFile(path.join(orphan, '1.svg'), art(9));
    const orphanChoice = await win.evaluate(async id => {
      const list = await window.manga.readingChoices(id); return list.items;
    }, aliasBook.id);
    // Outside comic's siblings include a container but not its deeper orphan comic.
    assert.equal(orphanChoice.some(item => item.title === 'Orphan shelf'), false);
    const sibling = path.join(temp, 'Orphan sibling');
    await fs.mkdir(sibling); await fs.writeFile(path.join(sibling, '1.svg'), art(11));
    const freshChoices = await win.evaluate(id => window.manga.readingChoices(id), aliasBook.id);
    const orphanBook = await win.evaluate(id => window.manga.openSource(id), freshChoices.items.find(item => item.title === 'Orphan sibling').id);
    const beforeSources = await win.evaluate(() => window.manga.sources());
    const direct = await win.evaluate(id => window.manga.locateBook(id), orphanBook.id);
    assert.equal(direct.length, 1);
    assert.equal((await win.evaluate(() => window.manga.sources())).length, beforeSources.length + 1);
    await win.evaluate(id => window.manga.locateBook(id), orphanBook.id);
    assert.equal((await win.evaluate(() => window.manga.sources())).length, beforeSources.length + 1, 'Locate must not duplicate roots');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 600));
    await win.getByRole('separator').press('End');
    assert.ok((await sidebar.boundingBox()).width <= 400);
    assert.ok((await tree.boundingBox()).height > 100);
    await win.getByRole('separator').press('Home'); assert.equal((await sidebar.boundingBox()).width, 200);
    await win.getByRole('separator').dblclick(); assert.equal((await sidebar.boundingBox()).width, 280);
    assert.deepEqual(errors, []);
    const result = { passed: true, initial, dragged, persisted: saved, layout,
      tests: ['taller independent tree', 'top-right language and persistence', 'drag/keyboard/reset/window clamp',
        'collapsed deep folder locate', 'single selected item scrolled into view', 'repeat locate', 'reader page preserved',
        'archive leaf', 'late-added sibling', 'shortcut route', 'direct-entry fallback', 'no Explorer launch'] };
    await fs.writeFile(path.join(root, '.tools/sidebar-upgrade-validation' + (process.env.MINIMANGA_PACKAGED ? '-packaged' : '') + '.json'), JSON.stringify(result, null, 2));
    console.log('PASS: sidebar upgrade.', result);
  } catch (error) {
    if (win) await win.screenshot({ path: path.join(root, '.tools/sidebar-upgrade-failure.png') }).catch(() => {});
    throw error;
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
