/* 选择器/配对筛选 对齐列表页 冒烟校验（无需浏览器）
 *
 * 用法：node tests/js/picker_form_smoke.js [app.js 路径]
 *
 * 校验：
 *  - 多级排序基建把 picker/pp/pr 三个 kind 接上（sortStateByKind / loadersByKind）；
 *  - 配对机体选择器 ppLoad 带 form/fullcond/sort/order；
 *  - 通用选择器 loadPicker（机体）带 match/form/cond/sort/order；
 *  - 配对结果筛选 appendPairFilterParams 带 pform + 多键 sort/order；
 *  - pp 表头注入「+」并可用（写入 pairUnitState.sorts）。
 * 退出码 0 = 全部通过。
 */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'web/app.js';
const src = fs.readFileSync(path, 'utf8');

function makeEl(sel) {
  return {
    _sel: sel, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    className: '', hidden: false, checked: false, children: [],
    firstChild: null, parentNode: null, scrollTop: 0, scrollHeight: 0,
    _listeners: {}, _kids: new Map(),
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (f) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {}, dispatchEvent() {},
    dispatch(t) { (this._listeners[t] || []).forEach((f) => f({ target: this, stopPropagation() {} })); },
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
    querySelector(s) { if (!this._kids.has(s)) this._kids.set(s, makeEl(s)); return this._kids.get(s); },
    querySelectorAll(s) { return this._qa ? this._qa(s) : []; },
    closest() { return null; }, matches() { return false; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    focus() {}, blur() {}, click() {}, insertAdjacentHTML() {},
  };
}

// pp 静态表头（供「+」注入与排序断言）
const headers = [];
const pluses = [];
function addHeader(kind, sort, label) {
  const span = makeEl('span');
  span.insertBefore = (child) => {
    span.children.push(child);
    if (String(child.className).includes('sort-add')) pluses.push(child);
    return child;
  };
  const el = makeEl('button');
  el.className = 'sort-th'; el.dataset.kind = kind; el.dataset.sort = sort;
  el.textContent = label; el.parentNode = span;
  headers.push(el);
}
["name:名称", "rarity:稀有度", "role:类型", "attack:攻击", "defense:防御",
 "mobility:机动", "hp:HP", "en:EN", "movement:移动"].forEach((x) => {
  const [s, l] = x.split(":");
  addHeader("pp", s, l);
});

function matchAll(sel) {
  const m = sel.match(/^\.([\w-]+)(?:\[data-kind(?:="([^"]*)")?\])?$/);
  if (!m) return [];
  const cls = m[1], kind = m[2];
  const pool = cls === 'sort-th' ? headers : (cls === 'sort-add' ? pluses : []);
  return pool.filter((e) => kind === undefined || e.dataset.kind === kind);
}

const els = new Map();
const document = {
  querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
  querySelectorAll(sel) { return matchAll(sel); },
  getElementById(id) { return this.querySelector('#' + id); },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'), documentElement: makeEl('html'), hidden: false,
};

const RESP = {
  '/api/series': [],
  '/api/tags?kind=unit': [], '/api/tags?kind=character': [], '/api/tags?kind=supporter': [],
  '/api/skillnames': [], '/api/support-labels': [], '/api/supporter-skillnames': [],
};
const urls = [];
const sandbox = {
  console, document,
  Intl, Math, JSON, Date, Promise, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: (url) => {
    urls.push(url);
    return Promise.resolve({ ok: true, status: 200,
      json: async () => (RESP[url] !== undefined ? RESP[url]
        : { ok: true, teams: [], total: 0, items: [] }) });
  },
  alert() {}, confirm: () => true,
  location: { href: 'http://x/', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  URLSearchParams, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.headers = headers;
sandbox.pluses = pluses;
sandbox.urls = urls;

const TESTS = `(() => {
  const url = (p) => urls.filter((u) => u.startsWith(p)).pop() || '';
  const qp = (u, k) => new URLSearchParams(u.split('?')[1] || '').get(k);
  __out = {};

  // 1) 多级排序基建接通 picker/pp/pr
  __out.kindsOk = ['picker', 'pp', 'pr'].every((k) =>
    sortStateByKind(k) && Array.isArray(sortStateByKind(k).sorts));
  __out.loadersOk = ['picker', 'pp', 'pr'].every((k) => typeof loadersByKind()[k] === 'function');

  // 2) ppLoad 带 form/fullcond + 多键 sort/order
  document.querySelector('#pp-form-sp').checked = true;
  document.querySelector('#pp-full-cond').checked = true;
  ppLoad(0);
  __out.ppUrl = url('/api/units?');
  __out.ppForm = qp(url('/api/units?'), 'form');
  __out.ppFull = qp(url('/api/units?'), 'fullcond');
  __out.ppSort = qp(url('/api/units?'), 'sort');

  // 3) pp 表头「+」可用：加为次级排序
  const plusAttack = pluses.find((p) => p.dataset.kind === 'pp' && p.dataset.sort === 'attack');
  __out.ppPlusExists = !!plusAttack;
  if (plusAttack) plusAttack.dispatch('click');
  __out.ppSorts = JSON.stringify(pairUnitState.sorts);
  __out.ppSortAfterPlus = qp(url('/api/units?'), 'sort');

  // 4) 通用选择器 loadPicker（机体）带 match/form/cond + 多键 sort
  pickerState.kind = 'unit';
  pickerState.form = 'ssp';
  pickerState.match = 'or';
  loadPicker(0);
  __out.pickerUrl = url('/api/picker/units?');
  __out.pickerForm = qp(url('/api/picker/units?'), 'form');
  __out.pickerMatch = qp(url('/api/picker/units?'), 'match');
  __out.pickerSort = qp(url('/api/picker/units?'), 'sort');

  // 5) 配对结果筛选带 pform + 多键 sort/order
  pairFilterState.form = 'sp';
  const pq = new URLSearchParams();
  appendPairFilterParams(pq);
  __out.prForm = pq.get('pform');
  __out.prSort = pq.get('sort');
  __out.prOrder = pq.get('order');
  return true;
})()`;

const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+test' });

const o = ctx.__out || {};
const checks = [
  ['picker/pp/pr 已接入多级排序基建', o.kindsOk === true && o.loadersOk === true],
  ['ppLoad 带 form=sp', o.ppForm === 'sp'],
  ['ppLoad 带 fullcond=1', o.ppFull === '1'],
  ['ppLoad 带多键 sort（默认 rarity）', o.ppSort === 'rarity'],
  ['pp 表头有「+」按钮', o.ppPlusExists === true],
  ['pp「+」加入次级排序', o.ppSorts === JSON.stringify([{ k: 'rarity', o: 'desc' }, { k: 'attack', o: 'desc' }])],
  ['pp 请求串随之变 rarity,attack', o.ppSortAfterPlus === 'rarity,attack'],
  ['picker 带 form=ssp', o.pickerForm === 'ssp'],
  ['picker 带 match=or', o.pickerMatch === 'or'],
  ['picker 带 sort', o.pickerSort === 'rarity'],
  ['配对结果带 pform=sp', o.prForm === 'sp'],
  ['配对结果带 sort=score', o.prSort === 'score'],
  ['配对结果带 order=desc', o.prOrder === 'desc'],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) bad++;
}
console.log('---');
console.log('pp url:', o.ppUrl);
console.log('picker url:', o.pickerUrl);
console.log(bad ? 'SMOKE_FAILED=' + bad : 'SMOKE_OK');
process.exit(bad ? 1 : 0);
