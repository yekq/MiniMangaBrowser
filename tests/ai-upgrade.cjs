// Generated fixtures and isolated app data only; no personal library is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron } = require('playwright-core');

(async () => {
  const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-ai-'));
  const data = path.join(temp, 'data'), source = path.join(temp, 'Generated Comic'), bin = path.join(temp, 'Recycle');
  await fs.mkdir(source); await fs.mkdir(bin); await fs.mkdir(path.join(data, 'ai'), { recursive: true });
  await fs.cp(path.join(root, 'resources/ai'), path.join(data, 'ai'), { recursive: true });
  const original = await sharp({ create: { width: 640, height: 900, channels: 3, background: '#dba575' } }).jpeg().toBuffer();
  const edited = await sharp({ create: { width: 480, height: 672, channels: 3, background: '#588bbd' } }).png().toBuffer();
  await fs.writeFile(path.join(source, '01.jpg'), original);
  await fs.writeFile(path.join(source, '02.jpg'), original);
  const archive = path.join(temp, 'Generated.cbz');
  execFileSync(require('7zip-bin-full').path7z, ['a', '-tzip', archive, '.'], { cwd: source, windowsHide: true, stdio: 'ignore' });
  let mode = 'ok', uploads = 0, openaiCalls = 0, prompts = [], jobs = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
      const reply = object => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(object)); };
      if (req.url === '/upload/image') { uploads++; assert.ok(body.includes(Buffer.from('MiniManga'))); return reply({ name: 'generated.png', subfolder: 'MiniManga' }); }
      if (req.url === '/prompt') {
        const graph = JSON.parse(body).prompt; prompts.push(graph); const id = String(prompts.length);
        jobs.set(id, { mode, reads: 0 }); return reply({ prompt_id: id });
      }
      if (req.url.startsWith('/history/')) {
        const id = req.url.split('/').at(-1), job = jobs.get(id); job.reads++;
        if (job.mode === 'pending' || job.reads < 2) return reply({});
        if (job.mode === 'fail') return reply({ [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'Generated test error' }]] } } });
        return reply({ [id]: { status: { status_str: 'success', completed: true }, outputs: { '12': { images: [{ filename: 'generated.png', subfolder: '', type: 'output' }] } } } });
      }
      if (req.url.startsWith('/view?')) { res.setHeader('Content-Type', 'image/png'); return res.end(edited); }
      if (req.url === '/v1/images/edits') { openaiCalls++; assert.ok(body.includes(Buffer.from('replace with blue'))); return reply({ data: [{ b64_json: edited.toString('base64') }] }); }
      res.statusCode = 503; res.end('Generated offline test');
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const configFile = path.join(data, 'ai/config.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  for (const p of config.profiles) p.endpoint = endpoint;
  config.profiles.push({ id: 'alternate', name: 'Alternate image service', provider: 'openai-images', endpoint: endpoint + '/v1', model: 'mock-edit' });
  config.profiles.push({ ...config.profiles.find(p => p.id === 'klein-4b'), id: 'offline', name: 'Unavailable service', endpoint: endpoint + '/unavailable' });
  await fs.writeFile(configFile, JSON.stringify(config));
  const env = { ...process.env, MINIMANGA_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'), args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [root, '--disable-gpu'], env });
  let app = await launch(), win;
  try {
    win = await app.firstWindow();
    const errors = []; win.on('pageerror', e => errors.push(e.message));
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ dialog, shell }, { source, bin }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      shell.trashItem = async file => { const fs = process.getBuiltinModule('fs').promises, path = process.getBuiltinModule('path'); await fs.rename(file, path.join(bin, path.basename(file))); };
    }, { source, bin });
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.locator('.book-card').first().waitFor();
    const books = await win.evaluate(() => window.manga.list()), book = books.find(b => b.title === 'Generated Comic'); assert.ok(book);
    await win.locator('.book-card .cover').first().click();
    await win.getByRole('button', { name: '✦ AI修改', exact: true }).click();
    const dialog = win.getByRole('dialog', { name: 'AI修改', exact: true });
    await dialog.getByLabel('AI模型', { exact: true }).selectOption('pony-sdxl');
    await dialog.getByLabel('AI修改要求').fill('blue jacket');
    assert.equal(await dialog.getByRole('button', {name:'发送并修改'}).isDisabled(), true);
    const canvas = dialog.getByLabel('涂抹修改区域'); await win.waitForFunction(() => document.querySelector('.ai-mask-stage img')?.naturalWidth > 0);
    const box = await canvas.boundingBox(); assert.ok(box);
    await win.mouse.move(box.x+box.width/2,box.y+box.height/2); await win.mouse.down(); await win.mouse.move(box.x+box.width/2+30,box.y+box.height/2+60,{steps:8}); await win.mouse.up();
    assert.equal(await dialog.getByRole('button', {name:'发送并修改'}).isDisabled(), false);
    await win.screenshot({ path: path.join(root, '.tools/ai-mask.png'),
      mask: [dialog.locator('.ai-endpoint')], maskColor: '#202938' });
    await dialog.getByRole('button',{name:'清空选区'}).click(); assert.equal(await dialog.getByRole('button', {name:'发送并修改'}).isDisabled(), true);
    await dialog.getByLabel('AI模型', { exact: true }).selectOption('klein-4b');
    await dialog.getByLabel('AI修改要求').fill('replace with blue');
    await dialog.getByRole('button', { name: '发送并修改' }).click();
    await dialog.getByRole('button', { name: '保存到当前路径' }).waitFor();
    assert.equal(uploads, 1); assert.equal(prompts[0]['4'].inputs.text, 'replace with blue');
    assert.equal(prompts[0]['1'].inputs.unet_name, 'flux-2-klein-4b-Q8_0.gguf');
    assert.equal(prompts[0]['8'].inputs.width, prompts[0]['16'].inputs.width);
    assert.equal(prompts[0]['9'].inputs.height, prompts[0]['16'].inputs.height);
    assert.ok(prompts[0]['8'].inputs.width * prompts[0]['8'].inputs.height <= 786432);
    await win.waitForFunction(() => document.querySelector('.ai-result img')?.naturalWidth > 0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    let records = await win.evaluate(() => window.manga.aiHistory()), record = records[0];
    assert.equal(record.status, 'ready'); assert.ok(record.imageUrl); assert.equal(records.length, 1);
    // The reading toolbar provides a scrollable three-column gallery and in-reader preview.
    await win.getByRole('button', { name: 'AI修改记录', exact: true }).click();
    const gallery = win.getByRole('dialog', { name: '阅读器AI修改记录' });
    await gallery.locator('.ai-gallery-item').first().waitFor();
    assert.equal(await gallery.locator('.ai-gallery-item').count(), 1);
    const columns = await gallery.locator('.ai-gallery-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 3, 'Gallery must have three columns');
    await gallery.locator('.ai-gallery-item').first().click();
    await win.getByRole('button', { name: '返回原图' }).waitFor();
    assert.equal(await win.locator('.spread img').first().getAttribute('src'), record.imageUrl);
    await win.getByRole('button', { name: '返回原图' }).click();
    assert.notEqual(await win.locator('.spread img').first().getAttribute('src'), record.imageUrl);
    await win.getByRole('button', { name: '✦　AI修改记录', exact: true }).click();
    await win.getByRole('button', { name: '查看结果 / 操作' }).first().click();
    // Comparing an edit must load the original page without changing its bytes.
    await dialog.getByRole('button', { name: '修改前后对比' }).click();
    await win.waitForFunction(() => [...document.querySelectorAll('.ai-compare-grid img')].length === 2 && [...document.querySelectorAll('.ai-compare-grid img')].every(img => img.naturalWidth > 0));
    assert.equal(await dialog.getByAltText('修改后图片').getAttribute('src'), record.imageUrl);
    assert.notEqual(await dialog.getByAltText('修改前原图').getAttribute('src'), record.imageUrl);
    await dialog.getByRole('button', { name: '只看修改结果' }).click();
    assert.equal(await dialog.locator('.ai-result img').count(), 1);
    await win.getByRole('button', { name: '保存到当前路径' }).click();
    await win.getByRole('button', { name: '已保存', exact: true }).waitFor();
    record = await win.evaluate(id => window.manga.aiGet(id), record.id);
    assert.equal(path.dirname(record.savedPath), source);
    assert.deepEqual(await fs.readFile(path.join(source, '01.jpg')), original, 'Original bytes must be unchanged');
    assert.deepEqual(await fs.readFile(record.savedPath), edited);
    assert.equal((await win.evaluate(id => window.manga.aiSave(id), record.id)).savedPath, record.savedPath, 'Save is idempotent');
    await win.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal((await win.evaluate(() => window.manga.aiHistory('replace with blue'))).length, 1);
    assert.equal((await win.evaluate(() => window.manga.aiHistory('unmatched'))).length, 0);
    await fs.mkdir(path.join(root, '.tools'), { recursive: true });
    await win.screenshot({ path: path.join(root, '.tools/ai-history.png') });
    // Cancellation of the delete confirmation must retain both record and file.
    await win.getByRole('button', { name: '查看结果 / 操作' }).first().click();
    win.once('dialog', d => d.dismiss()); await win.getByRole('button', { name: '删除', exact: true }).click();
    assert.equal((await win.evaluate(id => window.manga.aiGet(id), record.id)).status, 'saved');
    await win.screenshot({ path: path.join(root, '.tools/ai-result.png'),
      mask: [dialog.locator('.ai-saved-path')], maskColor: '#202938' });
    win.once('dialog', d => d.accept()); await win.getByRole('button', { name: '删除', exact: true }).click();
    await win.waitForFunction(async id => (await window.manga.aiGet(id)).status === 'deleted', record.id);
    assert.equal(await fs.stat(record.savedPath).then(() => true, () => false), false);
    assert.deepEqual(await fs.readFile(path.join(source, '01.jpg')), original);
    // Other compatible provider, archives, malformed input and backend failure.
    const wait = async id => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const record = await win.evaluate(id => window.manga.aiGet(id), id);
        if (record.status !== 'generating') return record;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('AI test task timed out');
    };
    let alternate = await win.evaluate(id => window.manga.aiStart(id, 0, 'replace with blue', 'alternate'), book.id);
    alternate = await wait(alternate.id); assert.equal(alternate.status, 'ready'); assert.equal(openaiCalls, 1);
    // UI paint/erase/clear, mandatory masks, parameter binding and exact outside preservation.
    const mask = await sharp({ create: { width: 640, height: 900, channels: 3, background: 'black' } }).composite([{ input: await sharp({ create: { width: 240, height: 240, channels: 3, background: 'white' } }).png().toBuffer(), left: 200, top: 300 }]).png().toBuffer();
    await assert.rejects(() => win.evaluate(id => window.manga.aiStart(id, 0, 'blue jacket', 'pony-sdxl'), book.id), /涂抹|Paint/);
    await assert.rejects(() => win.evaluate(({id, mask}) => window.manga.aiStart(id, 0, 'blue jacket', 'pony-sdxl', {mask, parameters:{denoise:2}}), {id:book.id, mask:'data:image/png;base64,'+mask.toString('base64')}), /Invalid parameter/);
    const startMask = () => win.evaluate(({id, mask}) => window.manga.aiStart(id, 0, 'blue jacket', 'pony-sdxl', {mask, parameters:{denoise:0.75, reference:0.2}}), {id:book.id, mask:'data:image/png;base64,'+mask.toString('base64')});
    let local = await startMask(); local = await wait(local.id); assert.equal(local.status, 'ready', local.error); assert.equal(local.localEdit, true);
    assert.equal(prompts.at(-1)['6'].inputs.denoise, 0.75); assert.equal(prompts.at(-1)['24'].inputs.weight, 0.2); assert.match(prompts.at(-1)['4'].inputs.text, /^score_9.*blue jacket$/);
    local = await win.evaluate(id => window.manga.aiSave(id), local.id);
    const before = await sharp(original).removeAlpha().raw().toBuffer(), after = await sharp(local.savedPath).removeAlpha().raw().toBuffer();
    assert.equal(before.length, after.length); let changed = 0;
    for(let y=0;y<900;y++) for(let x=0;x<640;x++) for(let c=0;c<3;c++) { const i=(y*640+x)*3+c; if(x<200||x>=440||y<300||y>=540) assert.equal(after[i],before[i], 'Outside mask pixel changed'); else if(after[i]!==before[i]) changed++; }
    assert.ok(changed>0, 'Editable area must change');
    if (process.env.MINIMANGA_DOCS_SCREENSHOTS === '1') {
      const ponyCard = win.locator('.ai-record-card').filter({ hasText: 'blue jacket' });
      await ponyCard.getByRole('button', { name: '查看结果 / 操作' }).click();
      await win.waitForFunction(() => document.querySelector('.ai-result img')?.naturalWidth > 0);
      await win.screenshot({ path: path.join(root, '.tools/ai-pony-public.png'),
        mask: [dialog.locator('.ai-saved-path')], maskColor: '#202938' });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
    await app.evaluate(({ dialog }, archive) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] }); }, archive);
    const imported = await win.evaluate(() => window.manga.import('files')), archiveBook = imported.find(b => b.path === archive); assert.ok(archiveBook);
    let archiveEdit = await win.evaluate(id => window.manga.aiStart(id, 0, 'replace with blue', 'klein-9b'), archiveBook.id);
    archiveEdit = await wait(archiveEdit.id); assert.equal(archiveEdit.status, 'ready');
    archiveEdit = await win.evaluate(id => window.manga.aiSave(id), archiveEdit.id);
    assert.equal(path.dirname(archiveEdit.savedPath), path.join(temp, 'Generated_AI'));
    await assert.rejects(() => win.evaluate(id => window.manga.aiStart(id, 99999, 'test', 'klein-4b'), book.id));
    await assert.rejects(() => win.evaluate(id => window.manga.aiStart(id, 0, ' ', 'klein-4b'), book.id));
    await assert.rejects(() => win.evaluate(id => window.manga.aiStart(id, 0, 'test', 'unknown'), book.id));
    await assert.rejects(() => win.evaluate(() => window.manga.aiGet('../../outside')));
    mode = 'fail'; let failed = await win.evaluate(id => window.manga.aiStart(id, 0, 'test', 'klein-4b'), book.id);
    failed = await wait(failed.id); assert.equal(failed.status, 'failed'); assert.match(failed.error, /Generated test error/);
    let offline = await win.evaluate(id => window.manga.aiStart(id, 0, 'test', 'offline'), book.id);
    offline = await wait(offline.id); assert.equal(offline.status, 'failed'); assert.match(offline.error, /503/);
    await fs.writeFile(configFile, JSON.stringify({ ...config, defaultProfile: 'missing-profile' }));
    await assert.rejects(() => win.evaluate(() => window.manga.aiProfiles()));
    await fs.writeFile(configFile, JSON.stringify(config));
    mode = 'pending'; const interrupted = await win.evaluate(id => window.manga.aiStart(id, 0, 'test', 'klein-4b'), book.id);
    await assert.rejects(() => win.evaluate(id => window.manga.aiStart(id, 0, 'concurrent', 'klein-9b'), book.id));
    await assert.rejects(() => win.evaluate(id => window.manga.aiDelete(id), interrupted.id));
    await assert.rejects(() => win.evaluate(id => window.manga.aiRemove(id), interrupted.id));
    assert.deepEqual(errors, []);
    await app.close();
    const legacy = {...config, defaultProfile:'klein-9b', presetRevision:1, profiles:config.profiles.filter(p=>p.id!=='pony-sdxl')};
    await fs.writeFile(configFile, JSON.stringify(legacy));
    await fs.rm(path.join(data,'ai/pony-inpaint.json'));
    app = await launch(); win = await app.firstWindow();
    await win.getByRole('button', { name: '✦　AI修改记录', exact: true }).waitFor();
    assert.equal((await win.evaluate(id => window.manga.aiGet(id), interrupted.id)).status, 'failed');
    assert.equal((await win.evaluate(id => window.manga.aiGet(id), archiveEdit.id)).status, 'saved');
    assert.equal((await win.evaluate(() => window.manga.aiHistory())).length, 7);
    const upgraded = JSON.parse(await fs.readFile(configFile,'utf8'));
    assert.equal(upgraded.defaultProfile,'pony-sdxl'); assert.equal(upgraded.presetRevision,2);
    assert.equal(upgraded.profiles.find(p=>p.id==='klein-4b').endpoint,endpoint);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile+'.before-pony','utf8')),legacy);
    assert.ok(await fs.stat(path.join(data,'ai/pony-inpaint.json')));
    await win.getByRole('button', { name: '✦　AI修改记录', exact: true }).click();
    await win.getByLabel('筛选AI记录漫画').selectOption(archiveBook.id);
    await win.waitForFunction(() => document.querySelectorAll('.ai-record-card').length === 1);
    // Removing a history entry must not delete the user's saved copy.
    win.once('dialog', d => d.dismiss()); await win.getByRole('button', { name: '移除记录' }).click();
    assert.equal((await win.evaluate(id => window.manga.aiHistory('', id), archiveBook.id)).length, 1);
    win.once('dialog', d => d.accept()); await win.getByRole('button', { name: '移除记录' }).click();
    await win.waitForFunction(async id => (await window.manga.aiHistory('', id)).length === 0, archiveBook.id);
    await assert.rejects(() => win.evaluate(id => window.manga.aiGet(id), archiveEdit.id), /AI记录不存在|not found/);
    assert.deepEqual(await fs.readFile(archiveEdit.savedPath), edited);
    console.log('PASS: AI edit UI, in-reader gallery, original/result compare, record removal, ComfyUI binding/upload/poll/download, alternate provider, immutable originals, folder/archive save, recoverable deletion, restart and failures.');
  } catch (e) {
    if (win) await win.screenshot({ path: path.join(root, '.tools/ai-failure.png') }).catch(() => {});
    throw e;
  } finally { await app.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
