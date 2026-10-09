/* 驾驶员「默认 / SP 形态」技能·能力取数冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/char_form_smoke.js [app.js 路径]
 *
 * 校验 charRowsForForm：
 *   - 默认形态：只取 is_sp=0 的行；
 *   - SP 形态：每个槽位优先取 is_sp=1，槽位无 SP 版本（SP 后未改动）则沿用默认那条；
 *   - 结果按 sort 升序。
 * 退出码 0 = 全部通过。
 */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'web/app.js';
const src = fs.readFileSync(path, 'utf8');

function makeEl(sel) {
  return {
    _sel: sel, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    className: '', hidden: false, children: [], firstChild: null, parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
    querySelector() { return makeEl('sub'); }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    focus() {}, blur() {}, click() {}, insertAdjacentHTML() {},
    scrollTop: 0, scrollHeight: 0,
  };
}
const els = new Map();
const document = {
  querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
  querySelectorAll() { return []; },
  getElementById(id) { return this.querySelector('#' + id); },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'), documentElement: makeEl('html'), hidden: false,
};

const sandbox = {
  console, document,
  Intl, Math, JSON, Date, Promise, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ ok: true, status: 200,
    json: async () => ({ ok: true, teams: [], total: 0, items: [] }) }),
  alert() {}, confirm: () => true,
  location: { href: 'http://x/', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  URLSearchParams, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const TESTS = `(() => {
  const rows = [
    { sort: 1, is_sp: 0, name: 'A2' }, { sort: 1, is_sp: 1, name: 'A3' },
    { sort: 2, is_sp: 0, name: 'B2' }, { sort: 2, is_sp: 1, name: 'B3' },
    { sort: 3, is_sp: 0, name: 'C1' },   // 该槽位 SP 后未改动：只有默认一条
  ];
  const skills = [
    { sort: 1, is_sp: 0, name: 'S2' }, { sort: 1, is_sp: 1, name: 'S3' },
    { sort: 2, is_sp: 1, name: 'T1' },   // 仅 SP 才有
  ];
  __out = {};
  charView.c = { skills, abilities: rows };

  charView.formKey = 'default';
  __out.defAb = charRowsForForm(rows).map((r) => r.name);
  __out.defSk = charRowsForForm(skills).map((r) => r.name);

  charView.formKey = 'sp';
  __out.spAb = charRowsForForm(rows).map((r) => r.name);
  __out.spSk = charRowsForForm(skills).map((r) => r.name);
  return true;
})()`;

const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+test' });

const o = ctx.__out || {};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checks = [
  ['默认形态能力=is_sp:0 三条', eq(o.defAb, ['A2', 'B2', 'C1'])],
  ['默认形态技能=仅 S2', eq(o.defSk, ['S2'])],
  ['SP 形态能力=升级项+沿用未变项', eq(o.spAb, ['A3', 'B3', 'C1'])],
  ['SP 形态技能=升级+仅SP新增', eq(o.spSk, ['S3', 'T1'])],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) bad++;
}
console.log('---');
console.log('default:', JSON.stringify(o.defAb), JSON.stringify(o.defSk));
console.log('sp     :', JSON.stringify(o.spAb), JSON.stringify(o.spSk));
console.log(bad ? 'SMOKE_FAILED=' + bad : 'SMOKE_OK');
process.exit(bad ? 1 : 0);
