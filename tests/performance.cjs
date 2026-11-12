// Performance regression: generated media, isolated DB, and request/DOM bounds.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
(async () => {
  const baseline = process.argv.includes('--baseline');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-performance-'));
  const shelf = path.join(temp, 'Generated shelf'), count = 200;
  await fs.mkdir(shelf);
  for (let offset = 0; offset < count; offset += 32) await Promise.all(Array.from({ length: Math.min(32, count - offset) }, async (_, n) => {
    const folder = path.join(shelf, 'Comic ' + String(offset + n).padStart(4, '0'));
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, '1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="85"><rect width="60" height="85" fill="teal"/></svg>');
  }));
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const start = performance.now();
  const app = await _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'),
    args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [process.cwd(), '--disable-gpu'], env });
  try {
    const win = await app.firstWindow(); await win.getByText('故事，从这里开始').waitFor();
    const startupMs = Math.round(performance.now() - start);
    if (!baseline) await assert.rejects(fs.access(path.join(temp, 'data', 'ai', 'config.json')),
      'Normal startup must not initialize AI models/presets');
    await app.evaluate(({ ipcMain, dialog }, shelf) => {
      globalThis.__performance = { calls: {}, elapsed: {}, pending: 0 };
      const handlers = [...ipcMain._invokeHandlers.entries()];
      for (const [name, original] of handlers) {
        ipcMain.removeHandler(name);
        ipcMain.handle(name, async (...args) => {
          const stats = globalThis.__performance, start = performance.now(); stats.pending++;
          stats.calls[name] = (stats.calls[name] || 0) + 1;
          try { return await original(...args); }
          finally { stats.pending--; stats.elapsed[name] = (stats.elapsed[name] || 0) + performance.now() - start; }
        });
      }
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shelf] });
    }, shelf);
    const importStart = performance.now();
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.waitForFunction(() => document.querySelectorAll('.cover').length === 9);
    const importMs = Math.round(performance.now() - importStart);
    const expandStart = performance.now();
    await win.locator('.source-row > button').filter({ hasText: 'Generated shelf' }).first().click();
    await win.waitForFunction(count => document.querySelectorAll('.source-row').length === count + 1, count);
    await app.evaluate(async () => {
      const stop = Date.now() + 10000;
      while (globalThis.__performance.pending && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 20));
    });
    const expandMs = Math.round(performance.now() - expandStart);
    const hiddenActionPanels = await win.locator('.source-actions .item-actions').count();
    const treeElements = await win.locator('.source-tree *').count();
    const before = await app.evaluate(() => ({ ...globalThis.__performance.calls }));
    await win.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await win.waitForTimeout(300);
    const after = await app.evaluate(() => ({ ...globalThis.__performance.calls }));
    const focusRequests = Object.entries(after).reduce((sum, [name, value]) => sum + value - (before[name] || 0), 0);
    const collapseBefore = after['manga:openSource'] || 0;
    if (!baseline) {
      await win.locator('.source-row > button').filter({ hasText: 'Generated shelf' }).first().click();
      await win.waitForFunction(() => document.querySelectorAll('.source-row').length === 1);
      assert.equal(await app.evaluate(() => globalThis.__performance.calls['manga:openSource'] || 0), collapseBefore,
        'Collapsing a folder must not re-index or reopen it');
    }
    await win.locator('.source-actions summary').first().click();
    await win.locator('.source-actions .item-actions').first().waitFor();
    if (!baseline) {
      assert.equal(hiddenActionPanels, 0, 'Closed menus must not mount ratings/favorite queries');
      assert.ok(treeElements < count * 12, 'Closed source actions must have bounded DOM');
      assert.equal(focusRequests, 0, 'Returning to the window must not rescan all active queries');
      assert.equal(await win.locator('.source-actions .item-actions').count(), 1);
      const profiles = await win.evaluate(() => window.manga.aiProfiles());
      assert.ok(profiles.profiles.length > 0, 'AI still initializes when requested');
      await fs.access(path.join(temp, 'data', 'ai', 'config.json'));
    }
    const result = { startupMs, importMs, expandMs, children: count, hiddenActionPanels, treeElements, focusRequests,
      calls: await app.evaluate(() => globalThis.__performance.calls), passed: !baseline,
      scope: 'generated SVG folders; request and DOM bounds are enforced, wall times are measurements only' };
    await fs.writeFile(path.join(process.cwd(), '.tools/performance-ui-' + (baseline ? 'before' : process.env.MINIMANGA_PACKAGED ? 'packaged' : 'after') + '.json'), JSON.stringify(result, null, 2));
    console.log(result);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
