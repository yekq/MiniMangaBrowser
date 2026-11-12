const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/renderer/filmstripMath.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', output)(mod, mod.exports);
const { wrapPage, nearestPosition, visibleSlots, FILMSTRIP_DURATION } = mod.exports;

test('empty, single, two-page and long lists wrap in both directions', () => {
  assert.equal(wrapPage(-1, 24), 23);
  assert.equal(wrapPage(24, 24), 0);
  assert.equal(wrapPage(20001, 10000), 1);
  assert.equal(wrapPage(10, 0), 0);
  assert.deepEqual(visibleSlots(0, 700, 1), [0]);
  assert.deepEqual(visibleSlots(0, 700, 0), []);
});
test('boundary animation is one card, including repeated cycles and two-page direction', () => {
  assert.equal(nearestPosition(23, 0, 24), 24);
  assert.equal(nearestPosition(0, 23, 24), -1);
  assert.equal(nearestPosition(2400, 23, 24), 2399);
  assert.equal(nearestPosition(0, 1, 2, -1), -1);
  assert.equal(nearestPosition(0, 1, 2, 1), 1);
});
test('ten thousand pages render a bounded viewport; animation remains below 200 ms', () => {
  const slots = visibleSlots(9999, 780, 10000);
  assert.ok(slots.length <= 17);
  assert.equal(slots[Math.floor(slots.length / 2)], 9999);
  assert.ok(FILMSTRIP_DURATION > 0 && FILMSTRIP_DURATION < 200);
});
