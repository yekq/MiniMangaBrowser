// Generate original geometric sample pages and capture the actual application.
// No personal library, external images, or fixed machine paths are used.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright-core');

const titles = ['01 雾山来信', '02 海边车站', '03 星河旅人', '04 林间漫步', '05 夏日回声', '06 云上城市', '07 月光航线', '08 远方灯塔', '09 春日序曲'];
const labels = ['MISTY HILLS', 'SEASIDE STATION', 'STAR VOYAGER', 'FOREST WALK', 'SUMMER ECHO', 'SKY CITY', 'MOON ROUTE', 'DISTANT LIGHT', 'SPRING NOTES'];
const palettes = [ ['#183d48','#92b7aa','#f1c584'], ['#314b68','#a9c8d3','#efb18b'], ['#302d50','#9f9cbd','#e6c67f'], ['#2d4b3c','#a2b38b','#edcca2'], ['#60424a','#d8a49a','#f1d59d'], ['#324d56','#99bcc1','#eddfba'], ['#393f64','#a8b1cd','#eacfa2'], ['#3c5354','#9db4a6','#f2b38a'], ['#4b4d3e','#bbbe96','#e7b4a1'] ];

function art(book, page) {
  // Seeded variation keeps published screenshots reproducible.
  let seed = book * 113 + page * 37 + 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const [ink, sky, sun] = palettes[book];
  let buildings = '';
  for (let i = 0; i < 15; i++) {
    const x = i * 46 - 20, height = 30 + random() * 145;
    buildings += `<rect x="${x}" y="${650-height}" width="36" height="${height}" fill="${ink}" opacity=".85"/><rect x="${x+9}" y="${660-height}" width="7" height="12" fill="${sun}" opacity=".7"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850" viewBox="0 0 600 850">
  <rect width="600" height="850" fill="#eee8db"/>
  <rect x="24" y="24" width="552" height="644" rx="4" fill="${sky}"/>
  <circle cx="${370 + random()*75}" cy="${160+random()*70}" r="75" fill="${sun}"/>
  <path d="M24 420 L175 ${220+random()*85} L350 480 L450 310 L576 430 V668 H24Z" fill="${ink}" opacity=".3"/>
  <path d="M24 510 L215 368 L390 520 L576 414 V668 H24Z" fill="${ink}" opacity=".45"/>
  ${buildings}<path d="M24 620 Q200 560 576 635 V668 H24Z" fill="${ink}"/>
  <path d="M220 668 Q280 570 420 500" fill="none" stroke="${sun}" stroke-width="4" opacity=".7"/>
  <text x="48" y="76" font-family="sans-serif" font-size="12" letter-spacing="4" fill="${ink}">MINI MANGA / GENERATED ART</text>
  <text x="38" y="720" font-family="sans-serif" font-size="29" font-weight="700" letter-spacing="2" fill="${ink}">${labels[book]}</text>
  <text x="40" y="753" font-family="sans-serif" font-size="12" letter-spacing="4" fill="${ink}">A JOURNEY IN SHAPES AND COLOUR</text>
  <path d="M40 785 H560" stroke="${ink}" opacity=".3"/>
  <text x="40" y="815" font-family="sans-serif" font-size="12" fill="${ink}">DEMO COLLECTION · ${String(book+1).padStart(2,'0')}</text>
  <text x="525" y="815" font-family="sans-serif" font-size="14" fill="${ink}">${String(page+1).padStart(2,'0')}</text></svg>`;
}

(async () => {
  const root = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-docs-'));
  const source = path.join(temp, '示例漫画集');
  const output = path.join(root, 'docs', 'images');
  await fs.mkdir(output, { recursive: true });
  for (let b = 0; b < titles.length; b++) {
    const folder = path.join(source, titles[b]);
    await fs.mkdir(folder, { recursive: true });
    for (let p = 0; p < 16; p++) await fs.writeFile(path.join(folder, `${String(p+1).padStart(2,'0')}.svg`), art(b,p));
  }
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), args: [root, '--disable-gpu'], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1280));
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.waitForFunction(() => document.querySelectorAll('.cover').length === 9);
    await win.waitForFunction(() => document.querySelectorAll('.cover img').length === 9);
    const ready = () => win.waitForFunction(() => Array.from(document.querySelectorAll('img')).filter(i => {
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0;
    }).every(i => i.complete && i.naturalWidth > 0));
    await ready();
    await win.screenshot({ path: path.join(output, 'library.png') });
    console.log('Library captured');
    await win.evaluate(async () => {
      const books = await window.manga.list();
      await window.manga.setFavorite({ kind: 'book', bookId: books[0].id }, 5);
      await window.manga.setFavorite({ kind: 'book', bookId: books[1].id }, 4);
      await window.manga.setFavorite({ kind: 'page', bookId: books[2].id, page: 3 }, 5);
      await window.manga.setFavorite({ kind: 'book', bookId: books[4].id }, 0);
      const sources = await window.manga.sources();
      await window.manga.setFavorite({ kind: 'source', sourceId: sources[0].id }, 3);
      await window.manga.rememberSearch('雾山');
      await window.manga.rememberSearch('海边');
    });
    await win.reload();
    await win.getByRole('button', { name: /我的收藏/ }).click();
    await win.waitForFunction(() => document.querySelectorAll('.favorite-card').length === 5);
    await ready();
    await win.screenshot({ path: path.join(output, 'favorites.png') });
    await win.getByRole('button', { name: /我的书库/ }).first().click();
    await win.locator('.cover').first().click();
    await win.waitForFunction(() => document.querySelectorAll('.pages img').length === 9);
    await ready();
    await win.screenshot({ path: path.join(output, 'page-grid.png') });
    console.log('Page grid captured');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
    await win.locator('.pages button').first().click();
    await win.getByRole('button', { name: '双页', exact: true }).click();
    await win.waitForFunction(() => document.querySelectorAll('.spread img').length === 2);
    await win.waitForFunction(() => Array.from(document.querySelectorAll('.spread img')).every(i => i.complete && i.naturalWidth > 0));
    await win.waitForFunction(() => document.querySelector('.filmstrip-card[aria-current="page"] img')?.naturalWidth > 0);
    const stage = await win.locator('.reader-stage').boundingBox();
    await win.mouse.move(stage.x + stage.width / 2, stage.y + stage.height - 2);
    await win.screenshot({ path: path.join(output, 'reader.png'), animations: 'disabled' });
    await win.getByRole('button', { name: '全屏', exact: true }).click();
    await win.waitForFunction(() => document.fullscreenElement?.classList.contains('reader-stage'));
    await win.mouse.move(200, 200);
    await win.waitForFunction(() => document.querySelector('.filmstrip')?.getAttribute('aria-hidden') === 'true');
    await win.screenshot({ path: path.join(output, 'fullscreen-reader.png'), animations: 'disabled' });
    await win.keyboard.press('F11');
    await win.waitForFunction(() => !document.fullscreenElement);
    const pdf = path.join(temp, '纸上星河.pdf');
    await fs.writeFile(pdf, require('../tests/pdf-fixture.cjs').samplePdf());
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, pdf);
    await win.getByRole('button', { name: '打开文件', exact: true }).click();
    await win.locator('.source-row > button').filter({ hasText: '纸上星河.pdf' }).click();
    await win.waitForFunction(() => document.querySelectorAll('.pages img').length === 3);
    await win.getByRole('button', { name: '双页', exact: true }).click();
    await win.waitForFunction(() => document.querySelectorAll('.spread img').length === 2 && Array.from(document.querySelectorAll('.spread img')).every(i => i.complete && i.naturalWidth > 0));
    const pdfStage = await win.locator('.reader-stage').boundingBox();
    await win.mouse.move(pdfStage.x + pdfStage.width / 2, pdfStage.y + pdfStage.height - 2);
    await win.screenshot({ path: path.join(output, 'pdf-reader.png'), animations: 'disabled' });
    console.log('Created six docs/images screenshots from generated sample pages and PDF.');
  } finally {
    await app.close();
    // Temporary fixtures remain in the OS temp directory; no personal data is read.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
