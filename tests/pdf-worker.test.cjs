const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { samplePdf } = require('./pdf-fixture.cjs');

test('PDF worker counts, lazily renders reader and thumbnail pages, and rejects invalid pages', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-manga-pdf-worker-'));
  const file = path.join(temp, 'Generated.pdf');
  await fs.writeFile(file, samplePdf());
  const worker = new Worker(path.join(__dirname, '../out/main/pdf-worker.js'));
  let id = 0;
  const call = data => new Promise((resolve, reject) => {
    const current = ++id;
    const result = message => {
      if (message.id !== current) return;
      worker.removeListener('message', result);
      if (message.error) reject(Error(message.error)); else resolve(message.value);
    };
    worker.once('error', reject);
    worker.on('message', result);
    worker.postMessage({ id: current, file, ...data });
  });
  try {
    assert.equal(await call({ op: 'count' }), 3);
    assert.deepEqual(await fs.readdir(temp), ['Generated.pdf']);
    const reader = path.join(temp, 'reader.png');
    await call({ op: 'render', page: 1, dest: reader });
    const image = await sharp(reader).metadata();
    assert.equal(image.width, 1500);
    assert.equal(image.height, 2125);
    const thumb = path.join(temp, 'thumb.png');
    await call({ op: 'render', page: 2, dest: thumb, thumbnail: true });
    const thumbnail = await sharp(thumb).metadata();
    assert.ok(thumbnail.width <= 320 && thumbnail.height <= 480);
    await assert.rejects(call({ op: 'render', page: 99, dest: reader }), /Unknown PDF page/);
    const damaged = path.join(temp, 'Damaged.pdf');
    await fs.writeFile(damaged, 'generated invalid PDF fixture');
    await assert.rejects(call({ op: 'count', file: damaged }), /PDF/);
    assert.equal(await call({ op: 'count' }), 3, 'Invalid PDF must not stop healthy document reads');
  } finally { await worker.terminate(); }
});
