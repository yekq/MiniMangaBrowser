// Confirm that importing a collection never indexes its deeper subtrees.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright-core');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-lazy-'));
  const shelf = path.join(temp, 'Shelf');
  const first = path.join(shelf, 'First Book');
  const deep = path.join(shelf, 'Collection', 'Part A', 'Deep Comic');
  const untouched = path.join(shelf, 'Collection', 'Part B', 'Other Comic');
  for (const dir of [first, deep, untouched]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '01.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  }
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require('electron'), args: [process.cwd(), '--disable-gpu'], env,
  });
  try {
    const win = await app.firstWindow();
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, shelf);
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    const list = () => win.evaluate(() => window.manga.list());
    await win.waitForFunction(async () => (await window.manga.list()).some(b => b.title === 'First Book'));
    assert.deepEqual((await list()).map(b => b.title), ['First Book']);
    const root = (await win.evaluate(() => window.manga.sources()))[0];
    assert.equal(root.title, 'Shelf');
    await win.evaluate(id => window.manga.children(id), root.id);
    assert.deepEqual((await list()).map(b => b.title), ['First Book'], 'listing children must not import grandchildren');

    const click = title => win.locator('.source-row > button').filter({ hasText: title }).first().click();
    await click('Shelf');
    await click('Collection');
    assert.deepEqual((await list()).map(b => b.title), ['First Book']);
    await click('Part A');
    await win.waitForFunction(async () => (await window.manga.list()).some(b => b.title === 'Deep Comic'));
    assert.deepEqual((await list()).map(b => b.title), ['Deep Comic', 'First Book']);
    await win.locator('.cover').filter({ hasText: 'Deep Comic' }).waitFor();
    await click('Deep Comic');
    await win.waitForFunction(() => document.querySelector('h1')?.textContent === 'Deep Comic');
    assert.equal((await list()).some(b => b.title === 'Other Comic'), false);
    console.log('PASS: imports index one level; deeper comics appear only after opening their parent.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
