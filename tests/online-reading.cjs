const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sharp = require("sharp");
const { _electron } = require("playwright-core");

const eh = "https://e-hentai.org";
const nh = "https://nhentai.net";
const custom = "https://comic.example.org/chapter";
const ehBook = eh + "/g/42/deadbeef/";
const nhBook = nh + "/g/31/";
const pageImage = index => `https://images.example.org/${index}.png`;
const html = content => ({ type: "text/html", body: content });

async function launch(data) {
  const env = { ...process.env, MINIMANGA_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ executablePath: process.env.MINIMANGA_EXE || require("electron"),
    args: process.env.MINIMANGA_PACKAGED ? ["--disable-gpu"] : [process.cwd(), "--disable-gpu"], env });
}

async function mockNetwork(app, routes, delay = 0) {
  await app.evaluate((_, { routes, delay }) => {
    const { EventEmitter } = process.getBuiltinModule("node:events");
    const { Readable } = process.getBuiltinModule("node:stream");
    const https = process.getBuiltinModule("node:https");
    globalThis.__onlineRequests = [];
    globalThis.__onlineTimeline = [];
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      const routesForUrl = routes[url.href];
      const route = Array.isArray(routesForUrl) ? (routesForUrl.length > 1 ? routesForUrl.shift() : routesForUrl[0]) : routesForUrl;
      globalThis.__onlineRequests.push(url.href);
      globalThis.__onlineTimeline.push({ url: url.href, at: Date.now() });
      const timer = setTimeout(() => {
        const body = route?.type === "image/png" ? Buffer.from(route.body, "base64") : Buffer.from(route?.body || "");
        const response = Readable.from([body]);
        response.statusCode = route ? (route.status || 200) : 404;
        response.headers = { "content-type": route?.type ?? "text/plain", ...route?.headers };
        callback(response);
      }, route?.delay ?? delay);
      const abort = () => {
        clearTimeout(timer);
        request.emit("error", Error("aborted"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      request.once("error", () => options.signal?.removeEventListener("abort", abort));
      return request;
    };
  }, { routes, delay });
}

async function dragTitle(win, title, start, end) {
  const point = await title.evaluate((el, { start, end }) => {
    const node = el.firstChild;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const box = range.getBoundingClientRect();
    return { start: box.left + 0.5, end: box.right - 0.5, y: (box.top + box.bottom) / 2 };
  }, { start, end });
  await win.mouse.move(point.start, point.y);
  await win.mouse.down();
  await win.mouse.move(point.end, point.y, { steps: 8 });
  await win.mouse.up();
  const selected = await win.evaluate(() => getSelection().toString());
  await win.mouse.click((point.start + point.end) / 2, point.y, { button: "right" });
  return selected;
}

(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "mini-online-"));
  let app = await launch(data);
  try {
    let win = await app.firstWindow();
    await win.getByText("故事，从这里开始").waitFor();
    const api = (method, ...args) => win.evaluate(({ method, args }) => window.manga[method](...args), { method, args });
    if (process.env.MINIMANGA_LIVE_ONLINE === "1") {
      const generated = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#8aab92" } }).png().toBuffer();
      await app.evaluate((_, data) => {
        const https = process.getBuiltinModule("node:https");
        const http = process.getBuiltinModule("node:http");
        const { EventEmitter } = process.getBuiltinModule("node:events");
        const { Readable } = process.getBuiltinModule("node:stream");
        globalThis.__liveImageHosts = [];
        globalThis.__liveDocumentUrls = [];
        for (const client of [http, https]) {
          const get = client.get;
          client.get = (url, options, callback) => {
            if (options.headers?.Accept !== "image/*") {
              globalThis.__liveDocumentUrls.push(url.href);
              return get(url, options, callback);
            }
            globalThis.__liveImageHosts.push(url.hostname);
            const response = Readable.from([Buffer.from(data, "base64")]);
            response.statusCode = 200;
            response.headers = { "content-type": "image/png" };
            queueMicrotask(() => callback(response));
            return new EventEmitter();
          };
        }
      }, generated.toString("base64"));
      for (const site of [eh, nh]) {
        const keyword = process.env.MINIMANGA_LIVE_SEARCH ?? "";
        const listing = await api("onlineList", site + "/", keyword);
        assert.ok(listing.items.length > 0);
        const book = await api("onlineOpen", listing.items[0].url);
        const pages = await api("onlinePages", book.id);
        assert.ok(pages.length > 0);
        try {
          assert.equal(await win.evaluate(async url => {
            const image = new Image();
            image.src = url;
            await image.decode();
            return image.naturalWidth;
          }, pages[0].url), 32);
        } catch (error) {
          console.error("Reader HTTP attempts", await app.evaluate(() => globalThis.__liveDocumentUrls));
          if (site === eh) await api("thumb", pages[0].url);
          throw error;
        }
        console.log(`LIVE ${site}: ${listing.items.length} catalog entries, ${pages.length} reader pages, ${listing.items.filter(x => x.cover).length} cover URLs`);
      }
      assert.equal((await app.evaluate(() => globalThis.__liveImageHosts)).length, 2);
      console.log("Live gallery and reader HTML resolved image URLs; image bodies were replaced with generated PNGs.");
      return;
    }
    const image = await sharp({ create: { width: 60, height: 80, channels: 3, background: "#7eae91" } }).png().toBuffer();
    const png = { type: "image/png", body: image.toString("base64") };
    const ehReader = index => eh + `/s/abc/42-${index}`;
    const ehPage = (first, last) => html(`<h1 id="gn">Fixture E &amp; H</h1><p class="gpc">Showing ${first} - ${last} of 3 images</p>
      <div id="gdt">${Array.from({ length: last - first + 1 }, (_, offset) => `<a href="${ehReader(first + offset)}"></a>`).join("")}</div>`);
    const routes = {
      [eh + "/"]: html(`<table><tr><td><img src="${pageImage(0)}"></td><td><a href="${ehBook}"><div class="glink">Fixture E &amp; H</div></a></td></tr></table><a id="dnext" href="/?next=42">next</a>`),
      [eh + "/?f_search=fixture"]: html(`<a href="${ehBook}"><div class="glink">Fixture E &amp; H</div></a>`),
      [eh + "/?next=42"]: html(`<a href="${ehBook}"><div class="glink">Fixture E &amp; H</div></a><a id="dprev" href="/">prev</a>`),
      [ehBook]: ehPage(1, 2),
      [ehBook + "?p=1"]: ehPage(3, 3),
      [nh + "/"]: html(`<a href="/g/31/" class="cover"><img data-src="${pageImage(0)}"><div class="caption">Fixture N</div></a>`),
      [nhBook]: html(`<div id="info"><h1>Fixture N</h1></div><div id="thumbnail-container">
        <a href="/g/31/2/"><img src="${pageImage(0)}"></a><a href="/g/31/1/"><img src="${pageImage(0)}"></a></div>`),
      [custom]: html(`<main><h1>Fixture custom</h1><img data-src="${pageImage(3)}"><img src="${pageImage(4)}"></main>`),
      [pageImage(0)]: png, [pageImage(1)]: png, [pageImage(2)]: png, [pageImage(3)]: png,
      [pageImage(4)]: { ...png, delay: 1600 },
    };
    const limitedUrl = nh + "/g/33/";
    const heldUrl = custom + "-held";
    const cancelUrl = custom + "-cancel";
    const limitedImage = "https://limited.example.org/2.png";
    const heldFirst = "https://held.example.org/1.png";
    const heldImage = "https://held.example.org/2.png";
    const cancelImage = "https://cancel.example.org/1.png";
    const rate = value => ({ type: "text/plain", body: "Too Many Requests", status: 429, headers: { "retry-after": value } });
    routes[limitedUrl] = html(`<div id="info"><h1>Fixture throttled</h1></div><div id="thumbnail-container">
      <a href="/g/33/1/"><img src="${pageImage(0)}"></a><a href="/g/33/2/"><img src="${pageImage(0)}"></a></div>`);
    routes[nh + "/g/33/1/"] = html(`<section id="image-container"><img src="${pageImage(1)}"></section>`);
    routes[nh + "/g/33/2/"] = html(`<section id="image-container"><img src="${limitedImage}"></section>`);
    routes[limitedImage] = [rate("3"), png];
    routes[heldUrl] = html(`<main><h1>Fixture checkpoint</h1><img src="${heldFirst}"><img src="${heldImage}"></main>`);
    routes[heldFirst] = png;
    routes[heldImage] = rate(new Date(Date.now() + 3600000).toUTCString());
    routes[cancelUrl] = html(`<main><h1>Fixture cancel cooldown</h1><img src="${cancelImage}"></main>`);
    routes[cancelImage] = rate(undefined);
    for (let index = 1; index <= 3; index++) routes[ehReader(index)] = html(`<img id="img" src="${pageImage(index)}">`);
    for (let index = 1; index <= 2; index++) routes[nh + `/g/31/${index}/`] = html(`<section id="image-container"><img src="${pageImage(index)}"></section>`);
    await mockNetwork(app, routes);
    const online = () => win.getByRole("button", { name: "◎　在线阅读" }).click();
    await online();
    const cover = title => win.locator(".online-library .cover").filter({ hasText: title });
    await cover("Fixture E & H").waitFor();
    await win.getByRole("button", { name: "下一页结果" }).click();
    await win.getByRole("button", { name: "上一页结果" }).waitFor();
    await win.getByRole("textbox", { name: "搜索在线漫画" }).fill("fixture");
    await win.getByRole("textbox", { name: "搜索在线漫画" }).press("Enter");
    await cover("Fixture E & H").click();
    await win.waitForFunction(() => document.querySelectorAll(".pages button").length === 3);
    await win.getByRole("button", { name: "双页", exact: true }).click();
    await win.waitForFunction(() => [...document.querySelectorAll(".spread img")].filter(img => img.naturalWidth).length === 2);
    await win.getByRole("button", { name: "单页", exact: true }).click();
    await win.getByLabel("Page", { exact: true }).fill("3");
    await win.waitForFunction(() => document.querySelector('.spread img[src$="/2"]')?.naturalWidth > 0);
    await win.getByRole("button", { name: "滚动", exact: true }).click();
    await win.waitForFunction(() => document.querySelector(".continuous-reader img")?.naturalWidth > 0);
    await win.getByRole("button", { name: "一键缓存到本地" }).click();
    await win.getByRole("button", { name: "打开本地缓存" }).filter({ visible: true }).waitFor();
    const books = await api("list");
    assert.equal(books.length, 1);
    assert.deepEqual((await fs.readdir(books[0].path)).sort(), ["0001.png", "0002.png", "0003.png"]);
    assert.deepEqual(await fs.readFile(path.join(books[0].path, "0003.png")), image);
    const requests = await app.evaluate(() => globalThis.__onlineRequests);
    assert.ok(requests.includes(ehBook + "?p=1"), "E-Hentai page 3 must come from the second gallery listing");
    assert.ok(requests.includes(eh + "/?f_search=fixture"), "Catalog search must use the site's search URL");

    await win.getByRole("button", { name: "← 返回在线书库" }).click();
    await win.getByRole("button", { name: "nHentai", exact: true }).click();
    await cover("Fixture N").click();
    await win.waitForFunction(() => document.querySelectorAll(".pages button").length === 2);
    await win.locator(".pages button").first().click();
    await win.waitForFunction(() => document.querySelector(".spread img")?.naturalWidth > 0);
    assert.ok((await app.evaluate(() => globalThis.__onlineRequests)).includes(nh + "/g/31/1/"));
    await win.getByRole("button", { name: "← 返回在线书库" }).click();
    await win.getByRole("button", { name: "＋ 添加网址" }).click();
    await win.getByRole("textbox", { name: "来源网址" }).fill(custom);
    await win.getByRole("textbox", { name: "来源名称" }).fill("Fixture website");
    await win.getByRole("button", { name: "保存网址" }).click();
    await win.getByRole("button", { name: "读取图片页" }).click();
    await win.waitForFunction(() => document.querySelectorAll(".pages button").length === 2);
    const customBook = await api("onlineOpen", custom);
    await api("onlineCache", customBook.id);
    await api("onlineCancel", customBook.id);
    await win.waitForFunction(async id => (await window.manga.onlineTasks()).find(task => task.id === id)?.state === "cancelled", customBook.id);
    assert.equal((await api("list")).length, 1);
    await assert.rejects(api("onlineOpen", "file:///fixture.png"), /HTTP/);
    await assert.rejects(api("onlineOpen", "http://127.0.0.1"), /public website/);

    const waitTask = async (id, state, cooling = false) => {
      const deadline = Date.now() + 10000;
      let task;
      do {
        task = (await api("onlineTasks")).find(item => item.id === id);
        if (task?.state === state && (!cooling || task.retryAt)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.fail(`Expected cache task to reach ${state}, got ${JSON.stringify(task)}`);
    };
    await online();
    await win.getByLabel("漫画网址", { exact: true }).fill(limitedUrl);
    await win.getByRole("button", { name: "打开漫画网址", exact: true }).click();
    await win.getByRole("heading", { name: "Fixture throttled", exact: true }).waitFor();
    const limitedBook = await api("onlineOpen", limitedUrl);
    await win.getByRole("button", { name: "一键缓存到本地", exact: true }).click();
    await waitTask(limitedBook.id, "running", true);
    await win.getByRole("button", { name: /站点限流，\d+ 秒后继续 · 1\/2/ }).waitFor();
    await assert.rejects(api("onlineOpen", "https://limited.example.org/blocked"), /HTTP 429/);
    await waitTask(limitedBook.id, "done");
    const timeline = await app.evaluate(() => globalThis.__onlineTimeline);
    const limitedCalls = timeline.filter(entry => entry.url === limitedImage);
    assert.equal(limitedCalls.length, 2);
    assert.ok(limitedCalls[1].at - limitedCalls[0].at >= 3000);
    assert.equal(timeline.some(entry => entry.url.endsWith("/blocked")), false);

    const cancelBook = await api("onlineOpen", cancelUrl);
    await api("onlineCache", cancelBook.id);
    await waitTask(cancelBook.id, "running", true);
    const cancelTask = (await api("onlineTasks")).find(task => task.id === cancelBook.id);
    assert.ok(cancelTask.retryAt > Date.now() + 25000);
    await api("onlineCancel", cancelBook.id);
    await waitTask(cancelBook.id, "cancelled");
    assert.equal((await app.evaluate(() => globalThis.__onlineRequests)).filter(url => url === cancelImage).length, 1);

    const heldBook = await api("onlineOpen", heldUrl);
    await api("onlineCache", heldBook.id);
    await waitTask(heldBook.id, "failed");
    const heldTask = (await api("onlineTasks")).find(task => task.id === heldBook.id);
    assert.equal(heldTask.done, 1);
    assert.ok(heldTask.retryAt > Date.now() + 30 * 60_000);
    assert.ok(!(await api("list")).some(book => book.title === heldBook.title));
    // Evict the first image from the generated fixture's transient cache to prove
    // that retry actually uses the durable checkpoint.
    await fs.unlink(path.join(data, "online-images", createHash("sha256").update(heldUrl + "\n0").digest("hex") + ".image"));

    await app.close();
    app = await launch(data);
    win = await app.firstWindow();
    await mockNetwork(app, {});
    assert.ok((await api("onlineSources")).some(source => source.url === custom));
    await win.locator(".cover").filter({ hasText: "Fixture E & H" }).click();
    await win.waitForFunction(() => document.querySelectorAll(".pages img").length === 3);
    await win.locator(".pages button").first().click();
    await win.waitForFunction(() => document.querySelector(".spread img")?.naturalWidth > 0);
    assert.deepEqual(await app.evaluate(() => globalThis.__onlineRequests), []);

    await mockNetwork(app, { ...routes, [heldImage]: png });
    const reopened = await api("onlineOpen", heldUrl);
    await api("onlineCache", reopened.id);
    await waitTask(reopened.id, "failed");
    assert.equal((await api("onlineTasks")).find(task => task.id === reopened.id).done, 1);
    assert.deepEqual(await app.evaluate(() => globalThis.__onlineRequests), [heldUrl]);
    await app.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 2 * 3600000;
    });
    await api("onlineCache", reopened.id);
    await waitTask(reopened.id, "done");
    const offlineHeld = (await api("list")).find(book => book.title === reopened.title);
    assert.deepEqual((await fs.readdir(offlineHeld.path)).sort(), ["0001.png", "0002.png"]);
    assert.deepEqual(await app.evaluate(() => globalThis.__onlineRequests), [heldUrl, heldImage]);
    console.log("PASS: HTTP 429 Retry-After seconds and date, same-host cooldown, cancellable wait and restart-safe partial cache");

    assert.equal(await dragTitle(win, win.locator("h1.comic-title-text"), 8, 13), "E & H");
    let dialog = win.getByRole("dialog", { name: "搜索漫画标题" });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("搜索关键词").inputValue(), "E & H");
    const searchUrl = nh + "/search?q=E%20%26%20H";
    await mockNetwork(app, { ...routes, [searchUrl]: routes[nh + "/"] });
    await dialog.getByLabel("搜索方案", { exact: true }).selectOption("nhentai");
    await dialog.getByRole("button", { name: "在 Mini Manga 搜索" }).click();
    await cover("Fixture N").waitFor();
    assert.equal(await win.getByLabel("搜索在线漫画").inputValue(), "E & H");
    assert.ok((await app.evaluate(() => globalThis.__onlineRequests)).includes(searchUrl));
    await cover("Fixture N").click();
    await win.waitForFunction(() => document.querySelectorAll(".pages button").length === 2);
    await win.getByRole("button", { name: "← 返回在线书库" }).click();
    await cover("Fixture N").waitFor();

    const coverTitle = cover("Fixture N").locator("strong");
    assert.equal(await dragTitle(win, coverTitle, 0, 7), "Fixture");
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("搜索关键词").inputValue(), "Fixture");
    await dialog.getByRole("button", { name: "配置方案" }).click();
    const settings = win.getByRole("dialog", { name: "搜索方案" });
    await settings.getByRole("button", { name: "＋ 添加搜索方案" }).click();
    await settings.getByLabel("方案名称").fill("Fixture forum");
    await settings.getByLabel("搜索网址模板").fill("https://{query}.example.org/");
    await settings.getByRole("button", { name: "保存方案" }).click();
    await settings.getByRole("alert").waitFor();
    await settings.getByLabel("搜索网址模板").fill("https://forum.example.org/#/search?kind=manga&q={query}");
    await settings.getByRole("button", { name: "保存方案" }).click();
    await settings.getByLabel("默认搜索方案").selectOption({ label: "Fixture forum" });
    await settings.getByRole("button", { name: "返回搜索" }).click();
    await dialog.getByLabel("搜索关键词").fill("标题 & C++");
    assert.equal(await dialog.getByRole("button", { name: "在 Mini Manga 搜索" }).isDisabled(), true);
    await app.evaluate(({ shell }) => {
      globalThis.__browserSearch = "";
      shell.openExternal = async url => { globalThis.__browserSearch = url; };
    });
    await dialog.getByRole("button", { name: "在浏览器搜索" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await app.evaluate(() => globalThis.__browserSearch),
      "https://forum.example.org/#/search?kind=manga&q=%E6%A0%87%E9%A2%98%20%26%20C%2B%2B");
    await coverTitle.click({ button: "right" });
    await dialog.getByLabel("搜索关键词").fill("Fixture E");
    await dialog.getByRole("button", { name: "搜索本地书库" }).click();
    assert.equal(await win.getByLabel("搜索书库或收藏").inputValue(), "Fixture E");
    await win.locator(".cover").filter({ hasText: "Fixture E & H" }).waitFor();

    await app.close();
    app = await launch(data);
    win = await app.firstWindow();
    await win.locator(".cover").filter({ hasText: "Fixture E & H" }).click({ button: "right" });
    dialog = win.getByRole("dialog", { name: "搜索漫画标题" });
    assert.equal(await dialog.getByLabel("搜索方案", { exact: true }).locator("option:checked").innerText(), "Fixture forum");
    const ehTitleSearch = eh + "/?f_search=Fixture%20E%20%26%20H";
    await mockNetwork(app, { ...routes, [ehTitleSearch]: routes[eh + "/"] });
    await dialog.getByLabel("搜索方案", { exact: true }).selectOption("e-hentai");
    await dialog.getByRole("button", { name: "在 Mini Manga 搜索" }).click();
    await cover("Fixture E & H").waitFor();
    assert.ok((await app.evaluate(() => globalThis.__onlineRequests)).includes(ehTitleSearch));
    await win.getByLabel("搜索在线漫画").fill("missing & page");
    await win.getByLabel("搜索在线漫画").press("Enter");
    await win.locator(".online-library").getByRole("alert").waitFor();
    await app.evaluate(({ shell }) => {
      shell.openExternal = async url => { globalThis.__browserSearch = url; };
    });
    await win.getByRole("button", { name: "在浏览器打开当前页" }).click();
    await win.waitForFunction(() => !document.querySelector(".online-library [role='status']"));
    assert.equal(await app.evaluate(() => globalThis.__browserSearch), eh + "/?f_search=missing%20%26%20page");
    console.log("PASS: online reading and offline cache, selected-title search, native results, local search, encoded browser URL and saved schemes");
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
