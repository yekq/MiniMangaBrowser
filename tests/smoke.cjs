const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { _electron } = require("playwright-core");
(async () => {
  const root = process.cwd(),
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "mini-manga-test-")),
    source = path.join(temp, "漫画");
  await fs.mkdir(source);
  for (let i = 1; i <= 24; i++)
    await fs.writeFile(
      path.join(source, i + ".svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850"><rect width="600" height="850" fill="hsl(${i * 20},35%,70%)"/><text x="60" y="300" font-size="150">${i}</text></svg>`,
    );
  const env = { ...process.env, MINIMANGA_DATA: path.join(temp, "data") };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: process.env.MINIMANGA_EXE || require("electron"),
    args: process.env.MINIMANGA_PACKAGED
      ? ["--disable-gpu"]
      : [root, "--disable-gpu"],
    env,
  });
  try {
    const win = await application.firstWindow();
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    win.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
    await win.getByText("故事，从这里开始").waitFor();
    await application.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [source],
      });
    }, source);
    await win.getByRole("button", { name: "＋ 添加目录" }).first().click();
    await win.waitForFunction(
      () => document.querySelectorAll(".cover").length === 1,
    );
    await win.waitForFunction(
      () => document.images.length > 0 && document.images[0].naturalWidth > 0,
    );
    await win.screenshot({ path: path.join(root, ".tools/library.png") });
    await win.locator(".cover").click();
    await win.waitForFunction(
      () => document.querySelectorAll(".pages img").length === 9,
    );
    await win.getByRole("button", { name: "四宫格", exact: true }).click();
    await win.waitForFunction(
      () => document.querySelectorAll(".pages img").length === 4,
    );
    await win.locator(".pages button").first().click();
    await win.waitForFunction(
      () => document.querySelectorAll(".spread img").length === 1,
    );
    await win.getByRole("button", { name: "›", exact: true }).first().click();
    await win.waitForFunction(
      async () => (await window.manga.list())[0].progress === 1,
    );
    const centerStrip = async (index) => {
      await win.waitForFunction((index) => {
        const selected = document.querySelector('.filmstrip-card[aria-current="page"]');
        const viewport = document.querySelector('.filmstrip-viewport');
        if (!selected || !viewport || Number(selected.dataset.page) !== index) return false;
        const a = selected.getBoundingClientRect(), b = viewport.getBoundingClientRect();
        return Math.abs(a.x + a.width / 2 - b.x - b.width / 2) < 1;
      }, index, { timeout: 5000 });
    };
    const wakeStrip = async () => {
      const stage = await win.locator('.reader-stage').boundingBox();
      await win.mouse.move(stage.x + stage.width / 2, stage.y + stage.height - 4);
      await win.mouse.move(stage.x + stage.width / 2, stage.y + stage.height - 2);
      await win.waitForFunction(() => document.querySelector('.filmstrip')?.getAttribute('aria-hidden') === 'false');
    };
    await centerStrip(1);
    await win.getByLabel('Page', { exact: true }).fill('24');
    await centerStrip(23);
    await win.evaluate(() => {
      window.__stripAnimation = new Promise((resolve) => {
        const viewport = document.querySelector('.filmstrip-viewport');
        const begin = performance.now();
        const finish = (event) => {
          if (event.propertyName === 'transform' && event.target.getAttribute('aria-current') === 'page') {
            viewport.removeEventListener('transitionend', finish);
            resolve({ elapsedMs: event.elapsedTime * 1000, wallMs: performance.now() - begin });
          }
        };
        viewport.addEventListener('transitionend', finish);
      });
    });
    await win.getByRole('button', { name: '列表下一张', exact: true }).click();
    await centerStrip(0);
    const animation = await win.evaluate(() => window.__stripAnimation);
    if (animation.elapsedMs > 200 || animation.elapsedMs <= 0) throw new Error('Animation exceeds budget: ' + JSON.stringify(animation));
    await win.getByRole('button', { name: '列表上一张', exact: true }).click();
    await centerStrip(23);
    await win.locator('.filmstrip-viewport').hover();
    await win.mouse.wheel(120, 0);
    await centerStrip(0);
    await win.mouse.wheel(0, -120);
    await centerStrip(23);
    await win.getByRole('button', { name: '列表下一张', exact: true }).click();
    await centerStrip(0);
    await win.getByRole('button', { name: '列表下一张', exact: true }).press('ArrowRight');
    await centerStrip(1); // Must not also reach the reader's global key handler.
    await win.locator('.filmstrip-card[data-page="5"]').click();
    await centerStrip(5);
    const viewportBox = await win.locator('.filmstrip-viewport').boundingBox();
    const dragX = viewportBox.x + viewportBox.width / 2, dragY = viewportBox.y + 36;
    await win.mouse.move(dragX, dragY);
    await win.mouse.down();
    await win.mouse.move(dragX - 144, dragY, { steps: 6 });
    await win.mouse.up();
    await centerStrip(7);
    await win.getByLabel('Page', { exact: true }).fill('6');
    await centerStrip(5);
    const rendered = await win.locator('.filmstrip-card').count();
    const viewportWidth = await win.locator('.filmstrip-viewport').evaluate(el => el.clientWidth);
    if (rendered > Math.ceil(viewportWidth / 72) + 6) throw new Error('Unbounded filmstrip: ' + rendered);
    await win.getByRole('button', { name: '隐藏图片列表', exact: true }).click();
    await win.locator('.filmstrip-restore').waitFor();
    await win.locator('.filmstrip-restore').click();
    await centerStrip(5);
    await win.keyboard.press('t');
    await win.locator('.filmstrip-restore').waitFor();
    await win.keyboard.press('t');
    await centerStrip(5);
    await win.getByLabel('Page', { exact: true }).fill('2');
    await centerStrip(1);
    await win.screenshot({ path: path.join(root, '.tools/filmstrip.png') });
    await win.getByRole("button", { name: "✎", exact: true }).click();
    await win.getByLabel("标签", { exact: true }).fill("测试标签");
    await win.getByLabel("作者", { exact: true }).fill("测试作者");
    await win.getByRole("button", { name: "保存", exact: true }).click();
    await win.waitForFunction(
      async () => (await window.manga.list())[0].author === "测试作者",
    );
    await win.getByRole("button", { name: "双页", exact: true }).click();
    await win.waitForFunction(
      () => document.querySelectorAll(".spread img").length === 2,
    );
    await win.getByRole("button", { name: "滚动", exact: true }).click();
    await win.waitForFunction(
      () => document.querySelector(".reading img") !== null,
    );
    // Page height changes with window/sidebar width. Wait for real image sizes,
    // then cross the third page boundary instead of assuming 1200px is a page.
    await win.waitForFunction(() => [0, 1, 2].every(index => {
      const image = document.querySelector(`.continuous-reader [data-index="${index}"] img`);
      return image?.complete && image.naturalWidth > 0;
    }));
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await win.evaluate(() => {
      const reader = document.querySelector('.continuous-reader');
      const next = reader.querySelector('[data-index="2"]');
      reader.scrollTop += next.getBoundingClientRect().top - reader.getBoundingClientRect().top + 2;
    });
    await win.waitForFunction(() => Number(document.querySelector('.toolbar input[aria-label="Page"]').value) > 2);
    const visiblePage = await win.getByLabel('Page', { exact: true }).inputValue();
    await centerStrip(Number(visiblePage) - 1);
    const archive = path.join(temp, "Fixture.cbz");
    require("node:child_process").execFileSync(
      require("7zip-bin-full").path7z,
      ["a", "-tzip", archive, "."],
      { cwd: source, windowsHide: true },
    );
    await application.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [archive],
      });
    }, archive);
    await win
      .getByRole("button", { name: "打开文件", exact: true })
      .first()
      .click();
    await win.getByRole("button", { name: "← 返回书库", exact: true }).click();
    await win.waitForFunction(
      () => document.querySelectorAll(".cover").length === 2,
    );
    await win.locator(".cover").filter({ hasText: "Fixture.cbz" }).click();
    await win.waitForFunction(
      () =>
        document.querySelectorAll(".pages img").length === 4 &&
        Array.from(document.querySelectorAll(".pages img")).every(
          (i) => i.naturalWidth > 0,
        ),
    );
    await win.locator(".tab").last().click({ button: "right" });
    await win.getByRole("button", { name: "关闭其他", exact: true }).click();
    await win.waitForFunction(
      () => document.querySelectorAll(".tab").length === 1,
    );
    await win.locator("select[aria-label=Language]").selectOption("en");
    await win.getByRole("button", { name: "← Library", exact: true }).click();
    await win.getByPlaceholder("Search title, tags, author…").waitFor();
    await win.screenshot({ path: path.join(root, ".tools/english.png") });
    // The visibility preference survives reload without modifying the library.
    await win.locator('.cover').first().click();
    await win.locator('.pages button').first().click();
    await win.getByRole('button', { name: 'Hide image strip', exact: true }).click();
    await win.reload();
    await win.getByPlaceholder('Search title, tags, author…').waitFor();
    await win.locator('.cover').first().click();
    await win.locator('.pages button').first().click();
    await win.getByRole('button', { name: 'Show image strip · T', exact: true }).waitFor();
    await win.getByRole('button', { name: 'Show image strip · T', exact: true }).click();
    await win.locator('.filmstrip').waitFor();
    for (const count of [1, 2]) {
      const small = path.join(temp, 'Small' + count);
      await fs.mkdir(small);
      for (let n = 1; n <= count; n++) await fs.copyFile(path.join(source, n + '.svg'), path.join(small, n + '.svg'));
      await application.evaluate(({ dialog }, small) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [small] });
      }, small);
      await win.getByRole('button', { name: 'Add folder', exact: false }).first().click();
      await win.getByRole('button', { name: '← Library', exact: true }).click();
      await win.locator('.cover').filter({ hasText: 'Small' + count }).click();
      await win.locator('.pages button').first().click();
      await wakeStrip();
      await centerStrip(0);
      if (count === 1) {
        if (await win.locator('.filmstrip-card').count() !== 1) throw Error('Single page duplicated');
        if (!await win.getByRole('button', { name: 'Strip next image', exact: true }).isDisabled()) throw Error('Single page navigation enabled');
      } else {
        await win.getByRole('button', { name: 'Strip previous image', exact: true }).click();
        await centerStrip(1);
        await win.getByRole('button', { name: 'Strip next image', exact: true }).click();
        await centerStrip(0);
      }
    }
    const damaged = path.join(temp, 'DamagedImage');
    await fs.mkdir(damaged);
    await fs.copyFile(path.join(source, '1.svg'), path.join(damaged, '1.svg'));
    await fs.writeFile(path.join(damaged, '2.png'), Buffer.from('generated invalid image fixture'));
    await application.evaluate(({ dialog }, damaged) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [damaged] });
    }, damaged);
    await win.getByRole('button', { name: 'Add folder', exact: false }).first().click();
    await win.getByRole('button', { name: '← Library', exact: true }).click();
    await win.locator('.cover').filter({ hasText: 'DamagedImage' }).click();
    await win.locator('.pages button').first().click();
    await centerStrip(0);
    await wakeStrip();
    await win.getByRole('button', { name: 'Strip next image', exact: true }).click();
    await centerStrip(1);
    await wakeStrip();
    await win.getByRole('button', { name: 'Strip next image', exact: true }).click();
    await centerStrip(0);
    const result = { animation, rendered, passed: true, scope: 'generated SVG pages only' };
    await fs.writeFile(path.join(root, '.tools/filmstrip-validation.json'), JSON.stringify(result, null, 2));
    console.log('PASS: cyclic filmstrip, selected-center, wheel/keyboard/click, hide/restore persistence, continuous tracking.', result);
    console.log(
      "PASS: fresh SQLite, import, sharp thumbnail, four/nine grid, single/spread/virtual scroll, Chinese/English.",
    );
    console.log(
      await application.evaluate(({ app }) => ({
        name: app.getName(),
        data: app.getPath("userData"),
      })),
    );
  } catch (error) {
    const win = await application.firstWindow();
    await win.screenshot({ path: path.join(root, '.tools/filmstrip-failure.png'), timeout: 5000 })
      .catch(diagnostic => console.error('Diagnostic screenshot unavailable:', diagnostic.message));
    await fs.writeFile(path.join(root, '.tools/filmstrip-failure.json'), JSON.stringify(await win.evaluate(() => ({
      page: document.querySelector('input[aria-label="Page"]')?.value,
      selected: document.querySelector('.filmstrip-card[aria-current="page"]')?.outerHTML,
      viewport: document.querySelector('.filmstrip-viewport')?.getBoundingClientRect().toJSON(),
      box: document.querySelector('.filmstrip-card[aria-current="page"]')?.getBoundingClientRect().toJSON()
    })), null, 2)).catch(diagnostic => console.error('Diagnostic state unavailable:', diagnostic.message));
    throw error;
  } finally {
    await application.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
