/* 形态开关（机体 SP/SSP/完全达成条件；驾驶员 SP）接线冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/form_toggle_smoke.js [app.js 路径]
 *
 * 校验：勾选复选框 -> state.*.form / fullCond 更新，且请求带上 form / fullcond；
 * SP 与 SSP 同勾时以 SSP 为准；取消勾选回到默认。
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
    _listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {}, dispatchEvent() {},
    dispatch(t) { (this._listeners[t] || []).forEach((f) => f({ target: this })); },
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
    querySelector() { return makeEl('sub'); }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    focus() {}, blur() {}, click() {}, insertAdjacentHTML() {},
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

const TESTS = `(() => {
  const box = (id) => document.querySelector(id);
  const url = (prefix) => urls.filter((u) => u.startsWith(prefix)).pop() || '';
  const param = (u, k) => new URLSearchParams(u.split('?')[1] || '').get(k);
  __out = {};

  // 默认：无形态
  __out.initForm = state.units.form;
  __out.initFull = state.units.fullCond;

  // 勾 SP
  box('#unit-form-sp').checked = true;
  box('#unit-form-sp').dispatch('change');
  __out.afterSp = state.units.form;
  __out.spParam = param(url('/api/units?'), 'form');

  // 再勾 SSP（与 SP 同勾）-> 以 SSP 为准
  box('#unit-form-ssp').checked = true;
  box('#unit-form-ssp').dispatch('change');
  __out.afterSsp = state.units.form;
  __out.sspParam = param(url('/api/units?'), 'form');

  // 取消 SSP -> 回到 SP
  box('#unit-form-ssp').checked = false;
  box('#unit-form-ssp').dispatch('change');
  __out.backToSp = state.units.form;

  // 勾「完全达成条件」
  box('#unit-full-cond').checked = true;
  box('#unit-full-cond').dispatch('change');
  __out.fullCond = state.units.fullCond;
  __out.fullParam = param(url('/api/units?'), 'fullcond');

  // 驾驶员 SP
  box('#char-form-sp').checked = true;
  box('#char-form-sp').dispatch('change');
  __out.charForm = state.characters.form;
  __out.charParam = param(url('/api/characters?'), 'form');
  return true;
})()`;

sandbox.box = null;
const ctx = vm.createContext(sandbox);
sandbox.urls = urls;
vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+test' });

const o = ctx.__out || {};
const checks = [
  ['默认无形态', o.initForm === '' && o.initFull === false],
  ['勾 SP -> form=sp', o.afterSp === 'sp' && o.spParam === 'sp'],
  ['SP+SSP 同勾以 SSP 为准', o.afterSsp === 'ssp' && o.sspParam === 'ssp'],
  ['取消 SSP 回到 SP', o.backToSp === 'sp'],
  ['完全达成条件 -> fullcond=1', o.fullCond === true && o.fullParam === '1'],
  ['驾驶员 SP -> form=sp', o.charForm === 'sp' && o.charParam === 'sp'],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) bad++;
}
console.log('---');
console.log('units form:', o.initForm, '->', o.afterSp, '->', o.afterSsp, '->', o.backToSp,
            '| fullCond:', o.fullCond, '| char form:', o.charForm);
console.log(bad ? 'SMOKE_FAILED=' + bad : 'SMOKE_OK');
process.exit(bad ? 1 : 0);
