/* 筛选选项数量（facet counts）渲染冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/facet_counts_smoke.js [app.js 路径]
 *   默认路径：web/app.js（相对仓库根）
 *
 * 原理：app.js 是普通脚本（非 IIFE），注入 DOM 桩后真跑一遍（含
 * initFilterControls 的异步初始化），再在脚本作用域里调用 applyFacets()，
 * 校验：
 *   1. 静态 select（稀有度）选项文案被追加 “(数量)”，"全部" 用 __all__；
 *   2. sbox 组合框（标签 / 武器特效）展开时的选项也带 “(数量)”。
 * DOM 桩会记录 addEventListener，用 dispatch('focus') 触发组合框 open→render。
 * 退出码 0 = 全部通过。
 */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'web/app.js';
const src = fs.readFileSync(path, 'utf8');

function makeEl(sel, parent) {
  const el = {
    _sel: sel, _parent: parent || null, _listeners: {}, _kids: new Map(),
    _qa: null, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    className: '', hidden: false, children: [], firstChild: null, parentNode: null,
    scrollTop: 0, scrollHeight: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else if (f) { this._s.add(c); } else { this._s.delete(c); }
      },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {}, dispatchEvent() {},
    dispatch(t) { (this._listeners[t] || []).forEach((f) => f({ target: this })); },
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
    querySelector(s) {
      if (!this._kids.has(s)) this._kids.set(s, makeEl(s, this));
      return this._kids.get(s);
    },
    querySelectorAll(s) { return this._qa ? this._qa(s) : []; },
    closest() { return null; }, matches() { return false; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect() {
      return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
    },
    focus() {}, blur() {}, click() {}, insertAdjacentHTML() {},
  };
  return el;
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

// 给某个 select 桩元素装上若干 option 子元素；appendChild 会重排以模拟浏览器排序
function attachOptions(selSel, pairs) {
  const el = document.querySelector(selSel);
  const opts = pairs.map(([v, label]) => {
    const o = makeEl('option');
    o.value = v;
    o.textContent = label;
    return o;
  });
  el.querySelectorAll = (s) => (s === 'option' ? opts.slice() : []);
  el.appendChild = (o) => {
    const i = opts.indexOf(o);
    if (i >= 0) opts.splice(i, 1);
    opts.push(o);
    return o;
  };
}

const RESP = {
  '/api/series': [{ id: 1, name: '系列A' }, { id: 2, name: '系列B' }],
  '/api/tags?kind=unit': ['老虎', '吉翁公国军', '零标签'],
  '/api/tags?kind=character': ['新人类'],
  '/api/tags?kind=supporter': ['白色基地'],
  '/api/skillnames': ['技A'],
  '/api/support-labels': ['无条件支援攻击1次'],
  '/api/supporter-skillnames': ['主动A'],
};

const sandbox = {
  console, document, __attachOptions: attachOptions,
  Intl, Math, JSON, Date, Promise, Object, Array, String, Number,
  Boolean, Set, Map, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: (url) => Promise.resolve({
    ok: true, status: 200,
    json: async () => (RESP[url] !== undefined
      ? RESP[url]
      : { ok: true, teams: [], total: 0, items: [] }),
  }),
  alert() {}, confirm: () => true,
  location: { href: 'http://127.0.0.1:8777/', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  URLSearchParams, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const TESTS = `(async () => {
  __attachOptions('#unit-rarity', [
    ['', '全部稀有度'], ['5', 'UR'], ['4', 'SSR'], ['3', 'SR'], ['2', 'R'], ['1', 'N'],
  ]);
  __attachOptions('#unit-acq', [['', '全部获取途径'], ['1', '扭蛋']]);
  __attachOptions('#unit-type', [['', '全部类型'], ['1', '攻击型']]);

  await initFilterControls();
  applyFacets('units', {
    rarity: { '5': 10, '4': 30, '__all__': 50 },
    acq: { '1': 20, '__all__': 50 },
    type: { '1': 5, '__all__': 50 },
    series: { '1': 7, '__all__': 50 },
    tags: { '老虎': 11, '吉翁公国军': 3, '零标签': 0, '__all__': 50 },
    wfx: { 'map': 9, '__all__': 50 },
  });

  // 展开标签 / 武器特效组合框 -> 触发 render
  document.querySelector('#unit-tag-box').querySelector('.sbox-input').dispatch('focus');
  document.querySelector('#unit-wfx-box').querySelector('.sbox-input').dispatch('focus');

  __rarity = [...document.querySelector('#unit-rarity').querySelectorAll('option')]
    .map((o) => ({ v: o.value, t: o.textContent, h: !!o.hidden }));
  __tagHtml = comboboxes['#unit-tag-box'].list.innerHTML;
  __wfxHtml = comboboxes['#unit-wfx-box'].list.innerHTML;
  return true;
})()`;

const ctx = vm.createContext(sandbox);
const run = vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+test' });

run.then(() => {
  const rarity = ctx.__rarity || [];
  const tagHtml = ctx.__tagHtml || '';
  const wfxHtml = ctx.__wfxHtml || '';
  const textOf = (v) => (rarity.find((o) => o.v === v) || {}).t || '';
  const hiddenOf = (v) => !!(rarity.find((o) => o.v === v) || {}).h;
  const visibleOrder = rarity.filter((o) => !o.h).map((o) => o.t);
  const tagIdx = (name) => tagHtml.indexOf(name);
  const checks = [
    ['稀有度 UR 带数量', textOf('5') === 'UR (10)'],
    ['稀有度 全部 用 __all__', textOf('') === '全部稀有度 (50)'],
    ['稀有度 SSR 带数量', textOf('4') === 'SSR (30)'],
    ['数量为 0 的稀有度(SR/R/N)隐藏', hiddenOf('3') && hiddenOf('2') && hiddenOf('1')],
    ['稀有度按数量降序(全部>SSR>UR)', JSON.stringify(visibleOrder)
      === JSON.stringify(['全部稀有度 (50)', 'SSR (30)', 'UR (10)'])],
    ['标签 老虎 带数量', tagHtml.includes('老虎') && tagHtml.includes('(11)')],
    ['标签 吉翁公国军 带数量', tagHtml.includes('吉翁公国军') && tagHtml.includes('(3)')],
    ['标签 数量为 0 的候选隐藏', !tagHtml.includes('零标签')],
    ['标签按数量降序(老虎在吉翁前)', tagIdx('老虎') >= 0 && tagIdx('老虎') < tagIdx('吉翁公国军')],
    ['标签选项带 data-label', /data-label="老虎"/.test(tagHtml)],
    ['武器特效 MAP 带数量', wfxHtml.includes('有 MAP 武器') && wfxHtml.includes('(9)')],
    ['武器特效 数量为 0 的候选隐藏', !wfxHtml.includes('range5')],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) bad++;
  }
  console.log('---');
  console.log('rarity:', JSON.stringify(rarity));
  console.log('tagHtml sample:', tagHtml.slice(0, 200));
  console.log('wfxHtml sample:', wfxHtml.slice(0, 200));
  console.log(bad ? 'SMOKE_FAILED=' + bad : 'SMOKE_OK');
  process.exit(bad ? 1 : 0);
}).catch((e) => {
  console.error('SMOKE_ERROR', e);
  process.exit(2);
});
