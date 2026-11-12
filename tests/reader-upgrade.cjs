// Real-window regression using generated pages only. Build before running.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron } = require('playwright-core');

(async () => {
  const root = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-reader-'));
  const source = path.join(temp, 'Generated pages');
  await fs.mkdir(source);
  await fs.mkdir(path.join(root, '.tools'), { recursive: true });
  for (let i = 0; i < 12; i++) {
    await sharp({ create: { width: 600, height: 850, channels: 3,
      background: { r: 70 + i * 10, g: 140, b: 175 - i * 7 } } })
      .jpeg().toFile(path.join(source, `${String(i + 1).padStart(2, '0')}.jpg`));
  }
  const archive = path.join(temp, 'Generated.cbz');
  const seven = require('7zip-bin-full').path7z;
  execFileSync(seven, ['a', '-tzip', archive, '.'], { cwd: source, windowsHide: true, stdio: 'ignore' });
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: process.env.MINIMANGA_EXE || require('electron'),
    args: process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [root, '--disable-gpu'], env,
  });
  let win;
  try {
    win = await app.firstWindow();
    // This is a shared interactive desktop: real mouse movement can otherwise
    // keep waking the strip during an assertion that explicitly requires idle.
    // Block pointer movement only during the two idle waits, in this test window.
    // The normal bottom-wake/drag assertions still use real pointer events.
    const waitForIdle = async () => {
      await win.evaluate(() => {
        window.__idlePointerShield = event => event.stopImmediatePropagation();
        window.addEventListener('pointermove', window.__idlePointerShield, true);
      });
      try {
        await win.waitForFunction(() => document.querySelector('.filmstrip')?.getAttribute('aria-hidden') === 'true', null, { timeout: 4000 });
      } finally {
        await win.evaluate(() => {
          window.removeEventListener('pointermove', window.__idlePointerShield, true);
          delete window.__idlePointerShield;
        });
      }
    };
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    await win.getByText('故事，从这里开始').waitFor();
    await app.evaluate(({ shell }) => {
      globalThis.__miniMangaRevealed = [];
      shell.showItemInFolder = file => globalThis.__miniMangaRevealed.push(file);
    });
    const importPath = async (files, mode = 'files') => {
      await app.evaluate(({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      }, Array.isArray(files) ? files : [files]);
      return win.evaluate(mode => window.manga.import(mode), mode);
    };
    // Use the real import button for the initial book so the query is refreshed.
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, source);
    await win.getByRole('button', { name: '＋ 添加目录' }).first().click();
    await win.waitForFunction(() => document.querySelectorAll('.cover').length === 1);
    await win.locator('.cover').click();
    await win.locator('.pages button').first().click();
    await win.getByRole('button', { name: '双页', exact: true }).click();
    await win.waitForFunction(() => document.querySelectorAll('.spread img').length === 2);
    const geometry = async () => win.evaluate(() => {
      const stage = document.querySelector('.reader-stage').getBoundingClientRect();
      const strip = document.querySelector('.filmstrip').getBoundingClientRect();
      return { stageWidth: stage.width, stripWidth: strip.width };
    });
    const normal = await geometry();
    assert.ok(Math.abs(normal.stripWidth / normal.stageWidth - 0.9) < 0.003, JSON.stringify(normal));
    const beforePage = await win.getByLabel('Page', { exact: true }).inputValue();
    await win.getByRole('button', { name: '定位', exact: true }).click();
    const revealed = await app.evaluate(() => globalThis.__miniMangaRevealed);
    assert.equal(path.normalize(revealed.at(-1)), path.join(source, '01.jpg'));

    await win.evaluate(() => {
      window.__readerEvents = [];
      for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'fullscreenchange']) {
        document.addEventListener(type, event => {
          const target = event.target;
          window.__readerEvents.push({ type, time: performance.now(), x: event.clientX, y: event.clientY,
            buttons: event.buttons, target: target?.className, hidden: document.querySelector('.filmstrip')?.getAttribute('aria-hidden') });
        }, true);
      }
    });
    await win.getByRole('button', { name: '全屏', exact: true }).click();
    await win.waitForFunction(() => document.fullscreenElement?.classList.contains('reader-stage'));
    await win.waitForFunction(() => {
      const r = document.querySelector('.reader-stage').getBoundingClientRect();
      return Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
    });
    const fullscreenGeometry = await geometry();
    assert.ok(Math.abs(fullscreenGeometry.stripWidth / fullscreenGeometry.stageWidth - 0.9) < 0.003);
    // Chrome fullscreen paints only its fullscreen subtree, so surrounding controls
    // must not occupy layout space inside the reader canvas.
    assert.equal(await win.evaluate(() => document.fullscreenElement.querySelector('header,.toolbar,aside,.tabs,footer')), null);
    const stageSize = await win.locator('.reader-stage').boundingBox();
    await win.mouse.move(stageSize.width / 2, stageSize.height / 2);
    const idleBegin = Date.now();
    await waitForIdle();
    assert.ok(Date.now() - idleBegin < 3500, 'Idle hide exceeded two seconds plus scheduling allowance');
    await win.mouse.move(stageSize.width / 2, stageSize.height - 2);
    await win.waitForFunction(() => document.querySelector('.filmstrip')?.getAttribute('aria-hidden') !== 'true');
    // Pointer down in the strip must keep it visible until release, even after
    // the normal idle deadline. Move away afterward to exercise idle hiding again.
    const stripBox = await win.locator('.filmstrip-viewport').boundingBox();
    await win.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
    await win.mouse.down();
    await win.waitForTimeout(2200);
    assert.notEqual(await win.locator('.filmstrip').getAttribute('aria-hidden'), 'true');
    await win.mouse.up();
    await win.mouse.move(stageSize.width / 2, stageSize.height / 2);
    await waitForIdle();
    await win.keyboard.press('Escape');
    await win.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await win.locator('.spread img').count(), 2, 'Escape must preserve double-page mode');
    assert.equal(await win.getByLabel('Page', { exact: true }).inputValue(), beforePage);

    // Fullscreen is independent of layout: single and continuous reading retain
    // their own page/mode when entering and leaving through F11.
    await win.getByRole('button', { name: '单页', exact: true }).click();
    await win.keyboard.press('F11');
    await win.waitForFunction(() => !!document.fullscreenElement);
    assert.equal(await win.locator('.spread img').count(), 1);
    await win.keyboard.press('F11');
    await win.waitForFunction(() => !document.fullscreenElement);
    await win.getByRole('button', { name: '滚动', exact: true }).click();
    await win.getByRole('button', { name: '全屏', exact: true }).click();
    await win.waitForFunction(() => !!document.fullscreenElement);
    await win.waitForFunction(() => {
      const r = document.querySelector('.continuous-reader').getBoundingClientRect();
      return Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
    });
    await win.keyboard.press('Escape');
    await win.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await win.locator('.continuous-reader').count(), 1);

    const shortcutFolder = path.join(temp, 'Shortcut folder');
    await fs.mkdir(shortcutFolder);
    await fs.copyFile(path.join(source, '01.jpg'), path.join(shortcutFolder, '01.jpg'));
    const folderLink = path.join(temp, 'Folder shortcut.lnk');
    const archiveLink = path.join(temp, 'Archive shortcut.lnk');
    await app.evaluate(({ shell }, { folderLink, archiveLink, shortcutFolder, archive }) => {
      if (!shell.writeShortcutLink(folderLink, { target: shortcutFolder })) throw Error('Cannot create folder shortcut fixture');
      if (!shell.writeShortcutLink(archiveLink, { target: archive })) throw Error('Cannot create archive shortcut fixture');
    }, { folderLink, archiveLink, shortcutFolder, archive });
    const books = await importPath([folderLink, archiveLink]);
    const folderBook = books.find(book => path.normalize(book.path) === shortcutFolder);
    const archiveBook = books.find(book => path.normalize(book.path) === archive);
    assert.ok(folderBook, 'Folder shortcut target was not imported');
    assert.ok(archiveBook, 'Archive shortcut target was not imported');
    const openCount = id => win.evaluate(async id => (await window.manga.open(id)).length, id);
    assert.equal(await openCount(folderBook.id), 1);
    assert.equal(await openCount(archiveBook.id), 12);
    await win.evaluate(id => window.manga.reveal(id, 0), archiveBook.id);
    assert.equal(path.normalize((await app.evaluate(() => globalThis.__miniMangaRevealed)).at(-1)), archive);
    const roots = await win.evaluate(() => window.manga.sources());
    const archiveSource = roots.find(item => item.title === path.basename(archiveLink).replace(/\.lnk$/i, ''));
    assert.ok(archiveSource?.leaf, 'Archive shortcut must be a leaf source');
    const shortcutCollection = path.join(temp, 'Shortcut collection');
    await fs.mkdir(shortcutCollection);
    await fs.copyFile(folderLink, path.join(shortcutCollection, path.basename(folderLink)));
    await fs.copyFile(archiveLink, path.join(shortcutCollection, path.basename(archiveLink)));
    await app.evaluate(({ shell }, { link, target }) => {
      shell.writeShortcutLink(link, { target });
    }, { link: path.join(shortcutCollection, 'Broken shortcut.lnk'), target: path.join(shortcutCollection, 'Missing folder') });
    await importPath(shortcutCollection, 'folder');
    const treeChildren = await win.evaluate(async title => {
      const root = (await window.manga.sources()).find(item => item.title === title);
      return window.manga.children(root.id);
    }, path.basename(shortcutCollection));
    const archiveNode = treeChildren.find(item => item.title === 'Archive shortcut');
    const folderNode = treeChildren.find(item => item.title === 'Folder shortcut');
    assert.equal(archiveNode?.bookId, archiveBook.id, 'Directory archive shortcut must use canonical book id');
    assert.equal(archiveNode?.leaf, true);
    assert.equal(folderNode?.bookId, folderBook.id, 'Directory folder shortcut must use canonical book id');
    assert.equal(folderNode?.leaf, false);
    // Archives are generated from the same pages; verify both listing and actual
    // thumbnail decoding so recognition alone cannot masquerade as format support.
    const create = (type, dest, input, cwd) => execFileSync(seven, ['a', '-t' + type, dest, input], { cwd, windowsHide: true, stdio: 'ignore' });
    const tar = path.join(temp, 'Generated.tar');
    create('tar', tar, '.', source);
    const sevenArchive = path.join(temp, 'Generated.7z');
    create('7z', sevenArchive, '.', source);
    const formatFiles = [tar, sevenArchive];
    const { storedRar } = require('./rar-fixture.cjs');
    const rarBytes = storedRar(await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const name = `${String(index + 1).padStart(2, '0')}.jpg`;
      return { name, bytes: await fs.readFile(path.join(source, name)) };
    })));
    for (const ext of ['rar', 'cbr']) {
      const file = path.join(temp, 'Generated.' + ext);
      await fs.writeFile(file, rarBytes);
      formatFiles.push(file);
    }
    for (const [type, ext, alias] of [['gzip', 'gz', 'tgz'], ['bzip2', 'bz2', 'tbz2'], ['xz', 'xz', 'txz']]) {
      const compressed = tar + '.' + ext;
      create(type, compressed, path.basename(tar), temp);
      const aliased = path.join(temp, 'Generated.' + alias);
      await fs.copyFile(compressed, aliased);
      formatFiles.push(compressed, aliased);
    }
    const compressedImage = path.join(temp, '01.jpg.gz');
    create('gzip', compressedImage, '01.jpg', source);
    formatFiles.push(compressedImage);
    const importedFormats = await importPath(formatFiles);
    for (const file of formatFiles) {
      const book = importedFormats.find(item => path.normalize(item.path) === file);
      assert.ok(book, 'Missing archive import: ' + path.basename(file));
      assert.equal(await openCount(book.id), file === compressedImage ? 1 : 12, path.basename(file));
      assert.ok(await win.evaluate(async id => {
        const pages = await window.manga.open(id);
        const url = await window.manga.thumb(pages[0].url);
        return new Promise(resolve => {
          const image = new Image();
          image.onload = () => resolve(image.naturalWidth > 0);
          image.onerror = () => resolve(false);
          image.src = url;
        });
      }, book.id), 'Archive thumbnail failed: ' + path.basename(file));
    }
    const result = { normal, fullscreenGeometry, shortcutFolderPages: 1, shortcutArchivePages: 12, archiveFormats: formatFiles.map(file => path.basename(file)), passed: true };
    await fs.writeFile(path.join(root, '.tools/reader-upgrade-validation.json'), JSON.stringify(result, null, 2));
    console.log('PASS: strip width, immersive fullscreen, idle/bottom/pressed behavior, Escape, image/archive reveal and shortcut imports.', result);
  } catch (error) {
    if (win) {
      await win.screenshot({ path: path.join(root, '.tools/reader-upgrade-failure.png'), timeout: 3000 }).catch(() => {});
      await fs.writeFile(path.join(root, '.tools/reader-upgrade-failure.json'), JSON.stringify(await win.evaluate(() => ({
        fullscreen: !!document.fullscreenElement, bodyClass: document.querySelector('.app')?.className,
        strip: document.querySelector('.filmstrip')?.outerHTML.slice(0, 1800), events: window.__readerEvents,
      })).catch(() => ({ diagnostic: 'Test window closed before failure capture' })), null, 2)).catch(() => {});
    }
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
