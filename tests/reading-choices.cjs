// End-of-book navigation, using generated media and an isolated library only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');

(async () => {
  const root = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-reading-choices-'));
  const shelf = path.join(temp, 'Shelf');
  await fs.mkdir(shelf);
  const image = (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850"><rect width="600" height="850" fill="hsl(${n * 25},35%,60%)"/><circle cx="300" cy="310" r="160" fill="#dfe6bf"/><text x="200" y="360" font-size="110" fill="#293d40">${n}</text></svg>`;
  for (let n = 1; n <= 13; n++) {
    const dir = path.join(shelf, 'Chapter ' + n);
    await fs.mkdir(dir);
    for (let p = 1; p <= 3; p++) await fs.writeFile(path.join(dir, p + '.svg'), image(n));
  }
  const source = path.join(shelf, 'Chapter 1');
  const archive = path.join(shelf, 'Chapter 14.cbz');
  execFileSync(require('7zip-bin-full').path7z, ['a', '-tzip', archive, '.'], { cwd: source, windowsHide: true, stdio: 'ignore' });
  await fs.mkdir(path.join(shelf, 'Empty'));
  await fs.mkdir(path.join(shelf, 'Container', 'Nested'), { recursive: true });
  await fs.writeFile(path.join(shelf, 'Container', 'Nested', '1.svg'), image(1));
  await fs.writeFile(path.join(shelf, 'loose.svg'), image(1));
  await fs.writeFile(path.join(shelf, 'notes.txt'), 'generated fixture');
  await fs.writeFile(path.join(shelf, 'ZZ Broken.cbz'), 'invalid generated archive');
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'),
    args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [root, '--disable-gpu'], env });
  let win;
  try {
    win = await app.firstWindow();
    const errors = []; win.on('pageerror', e => errors.push(e.message));
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.locator('.cover').click();
    await win.locator('.pages button').first().click();
    assert.equal(await win.locator('.reading-choices').count(), 0, 'must not open at start');
    const books = await win.evaluate(() => window.manga.list());
    assert.equal(books.length, 1);
    const choices = await win.evaluate(id => window.manga.readingChoices(id), books[0].id);
    assert.deepEqual(choices.items.filter(x => x.title.startsWith('Chapter')).map(x => x.title),
      [...Array.from({ length: 12 }, (_, i) => 'Chapter ' + (i + 2)), 'Chapter 14.cbz']);
    assert.equal(choices.items.length, 14);
    assert.equal(choices.items.find(x => x.id === choices.nextId).title, 'Chapter 2');
    assert.equal((await win.evaluate(() => window.manga.list())).length, 1, 'discovery must not import books');
    await assert.rejects(win.evaluate(() => window.manga.readingChoiceCover('0'.repeat(64))), /Choice unavailable/);
    await win.getByLabel('Page', { exact: true }).fill('3');
    const panel = win.getByRole('region', { name: '继续阅读', exact: true });
    await panel.waitFor();
    await win.waitForFunction(() => document.querySelectorAll('.reading-choice').length === 9);
    await panel.getByText('下一本', { exact: true }).waitFor();
    await win.waitForFunction(() => Array.from(document.querySelectorAll('.reading-choice-art img')).filter(i => i.complete && i.naturalWidth > 0).length === 9);
    await panel.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
    assert.equal(await panel.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'nine choices and footer must fit the panel');
    assert.equal(await panel.evaluate(el => el.getBoundingClientRect().bottom < document.querySelector('.filmstrip').getBoundingClientRect().top), true, 'panel must leave the bottom filmstrip usable');
    await win.screenshot({ path: path.join(root, '.tools/reading-choices.png') });
    const before = await win.getByLabel('Page', { exact: true }).inputValue();
    await win.locator('.reading-choice').nth(1).focus();
    await win.keyboard.press('ArrowLeft');
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), before);
    await win.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await win.locator('.spread img').count(), 1, 'Escape in panel must not go back to grid');
    await win.locator('.reading-choices-restore').click();
    await panel.waitFor();
    await win.getByRole('button', { name: '下一组漫画', exact: true }).click();
    await win.waitForFunction(() => document.querySelectorAll('.reading-choice').length === 5);
    assert.equal(await win.locator('.reading-choice strong').first().innerText(), 'Chapter 11');
    await win.locator('.reading-choice').filter({ hasText: 'Broken.cbz' }).click();
    await panel.getByRole('alert').waitFor();
    assert.equal(await win.locator('h1').innerText(), 'Chapter 1');
    await win.getByRole('button', { name: '上一组漫画', exact: true }).click();
    await win.locator('.reading-choice').filter({ hasText: 'Chapter 2' }).click();
    await win.waitForFunction(() => document.querySelector('h1')?.textContent === 'Chapter 2');
    await win.waitForFunction(() => document.querySelector('.toolbar input[aria-label="Page"]')?.value === '1');
    await win.waitForFunction(() => document.querySelector('.spread img')?.naturalWidth > 0);
    assert.equal(await win.locator('.spread img').count(), 1);
    assert.equal(await win.locator('.reading-choices').count(), 0);
    assert.equal((await win.evaluate(() => window.manga.list())).length, 2, 'click registers previously unimported sibling');
    // Double-page reaches the end when the last page is on the right.
    await win.getByRole('button', { name: '双页', exact: true }).click();
    assert.equal(await win.locator('.reading-choices').count(), 0);
    await win.getByLabel('Page', { exact: true }).fill('2');
    await panel.waitFor();
    await win.getByRole('button', { name: '关闭继续阅读', exact: true }).click();
    await panel.waitFor({ state: 'detached' });
    await win.getByLabel('Page', { exact: true }).fill('1');
    await win.getByLabel('Page', { exact: true }).fill('2');
    await panel.waitFor();
    // Panel is inside the fullscreen stage and remains clickable.
    await win.getByRole('button', { name: '全屏', exact: true }).click();
    await win.waitForFunction(() => document.fullscreenElement?.classList.contains('reader-stage'));
    assert.equal(await panel.evaluate(el => document.fullscreenElement.contains(el)), true);
    await win.evaluate(() => document.exitFullscreen());
    // The archive can be opened without a prior import.
    await win.getByRole('button', { name: '下一组漫画', exact: true }).click();
    await win.locator('.reading-choice').filter({ hasText: 'Chapter 14.cbz' }).click();
    await win.waitForFunction(() => document.querySelector('h1')?.textContent === 'Chapter 14.cbz');
    await win.getByRole('button', { name: '单页', exact: true }).click();
    await win.getByLabel('Page', { exact: true }).fill('3');
    await panel.waitFor();
    // Continuous mode waits for actual bottom, not just the top of the last page.
    await win.getByLabel('Page', { exact: true }).fill('1');
    await win.getByRole('button', { name: '滚动', exact: true }).click();
    await win.waitForFunction(() => document.querySelector('.continuous-reader img')?.naturalWidth > 0);
    assert.equal(await win.locator('.reading-choices').count(), 0);
    await win.evaluate(() => { const reader = document.querySelector('.continuous-reader'); reader.scrollTop = reader.scrollHeight; });
    await panel.waitFor();
    // Reopen refreshes the sibling listing, excluding disappeared files.
    await fs.rename(path.join(shelf, 'Chapter 13'), path.join(temp, 'Moved generated fixture'));
    await win.getByRole('button', { name: '关闭继续阅读', exact: true }).click();
    await win.locator('.reading-choices-restore').click();
    await win.waitForFunction(() => document.querySelector('.reading-choices-footer span')?.textContent.includes('13 本'));
    await win.locator('select[aria-label=Language]').selectOption('en');
    await win.getByRole('region', { name: 'Read next', exact: true }).waitFor();
    await win.getByRole('button', { name: 'Close read next', exact: true }).click();
    // Lone single-page folder: useful empty state, no unrelated library books.
    const lone = path.join(temp, 'LoneShelf', 'Only comic');
    await fs.mkdir(lone, { recursive: true }); await fs.writeFile(path.join(lone, '1.svg'), image(1));
    await app.evaluate(({ dialog }, lone) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lone] }); }, lone);
    await win.getByRole('button', { name: 'Add folder', exact: false }).first().click();
    await win.getByRole('button', { name: '← Library', exact: true }).click();
    await win.locator('.cover').filter({ hasText: 'Only comic' }).click();
    await win.locator('.pages button').first().click();
    await win.getByText('No other comics in this folder', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    const result = { passed: true, scope: 'generated folders and CBZ only', siblings: choices.items.length,
      tests: ['natural name order', 'nine-card pagination', 'unimported sibling discovery', 'empty/non-book exclusion',
        'single/double/scroll completion', 'close/restore', 'keyboard isolation', 'fullscreen', 'archive open',
        'corrupt archive error', 'removed sibling refresh', 'single-page empty state', 'English'] };
    await fs.writeFile(path.join(root, '.tools/reading-choices-validation' + (process.env.MINIMANGA_PACKAGED ? '-packaged' : '') + '.json'), JSON.stringify(result, null, 2));
    console.log('PASS: end-of-book choices.', result);
  } catch (e) {
    if (win) await win.screenshot({ path: path.join(root, '.tools/reading-choices-failure.png') });
    throw e;
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
