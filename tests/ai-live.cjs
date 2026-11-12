// Opt-in smoke test against an already running local ComfyUI, using generated art.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const sharp = require('sharp');
const { _electron } = require('playwright-core');
if (process.env.MINIMANGA_LIVE_AI !== '1') { console.log('Set MINIMANGA_LIVE_AI=1 to run the local model smoke test.'); process.exit(0); }
(async () => {
  const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-ai-live-'));
  const data = path.join(temp, 'data'), source = path.join(temp, 'Generated panel');
  await fs.mkdir(source); await fs.mkdir(path.join(data, 'ai'), { recursive: true });
  await fs.cp(path.join(root, 'resources/ai'), path.join(data, 'ai'), { recursive: true });
  const configFile = path.join(data, 'ai/config.json'), config = JSON.parse(await fs.readFile(configFile));
  config.defaultProfile = 'klein-4b';
  for (const profile of config.profiles) { profile.maxPixels = 65536; profile.endpoint = process.env.MINIMANGA_COMFY_URL || 'http://127.0.0.1:8188'; }
  await fs.writeFile(configFile, JSON.stringify(config));
  const original = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="384"><rect width="256" height="384" fill="white"/><rect x="16" y="16" width="224" height="352" fill="none" stroke="black" stroke-width="5"/><circle cx="128" cy="190" r="70" fill="red" stroke="black" stroke-width="5"/></svg>')).png().toBuffer();
  const file = path.join(source, '01.png'); await fs.writeFile(file, original);
  const env = { ...process.env, MINIMANGA_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require('electron'), args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [root, '--disable-gpu'], env });
  try {
    const win = await app.firstWindow();
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.locator('.book-card .cover').first().click();
    await win.getByRole('button', { name: '✦ AI修改', exact: true }).click();
    await win.getByLabel('AI修改要求').fill('Change the red circle to blue. Preserve the white background and black rectangular frame.');
    await win.getByRole('button', { name: '发送并修改' }).click();
    await win.getByRole('button', { name: '保存到当前路径' }).waitFor({ timeout: 300000 });
    await win.waitForFunction(() => document.querySelector('.ai-result img')?.naturalWidth > 0);
    const record = (await win.evaluate(() => window.manga.aiHistory()))[0]; assert.equal(record.status, 'ready');
    assert.deepEqual(await fs.readFile(file), original);
    await win.screenshot({ path: path.join(root, '.tools/ai-live-result.png') });
    await fs.writeFile(path.join(root, '.tools/ai-live-validation.json'), JSON.stringify({ status: record.status, profile: record.profileName, seconds: record.seconds, originalUnchanged: true, source: 'generated geometric panel' }, null, 2));
    console.log('PASS real local ComfyUI: ', record.profileName, record.seconds, 'seconds');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
