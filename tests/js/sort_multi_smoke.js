/* 多级排序冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/sort_multi_smoke.js [app.js 路径]
 *   默认路径：web/app.js（相对仓库根）
 *
 * 原理：给 app.js 注入带「表头元素注册表」的 DOM 桩，让顶层为 .sort-th / .sort-add
 * 挂监听、生成「+」按钮的逻辑真跑一遍，再用 dispatch('click') 模拟：
 *   - 点列名 -> 设为唯一主键（再点切换升降序）
 *   - 点「+」 -> 追加为下一级 / 再次点击移除
 * 校验 state.*.sorts、表头 ①② 标号、以及请求里 sort/order 的逗号串。
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
    dispatch(t) { (this._listeners[t] || []).forEach((f) => f({ target: this, stopPropagation() {} })); },
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

// 表头注册表：让 app.js 的 .sort-th / .sort-add 查询能命中真实元素
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
  el.className = 'sort-th';
  el.dataset.kind = kind;
  el.dataset.sort = sort;
  el.textContent = label;
  el.parentNode = span;
  headers.push(el);
  return el;
}

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

// units: 名称/稀有度/类型；characters: 稀有度/类型
addHeader('units', 'name', '名称');
addHeader('units', 'rarity', '稀有度');
addHeader('units', 'role', '类型');
addHeader('characters', 'rarity', '稀有度');
addHeader('characters', 'type', '类型');
addHeader('supporters', 'rarity', '稀有度');
addHeader('supporters', 'name', '名称');

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
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => (RESP[url] !== undefined ? RESP[url]
        : { ok: true, teams: [], total: 0, items: [] }),
    });
  },
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
  const tick = () => new Promise((r) => setTimeout(r, 0));  // 让 loader 的 await 链跑完
  const hdr = (kind, sort) => headers.find((h) => h.dataset.kind === kind && h.dataset.sort === sort);
  const plus = (kind, sort) => pluses.find((p) => p.dataset.kind === kind && p.dataset.sort === sort);
  const lastSortFor = (prefix) => {
    const u = urls.filter((x) => x.startsWith(prefix)).pop() || '';
    const p = new URLSearchParams(u.split('?')[1] || '');
    return [p.get('sort'), p.get('order')];
  };
  const lastSort = () => lastSortFor('/api/units?');
  __out = {};

  __out.initial = JSON.stringify(state.units.sorts);

  // 点「类型」列名（当前未参与排序）-> 设为唯一主键
  hdr('units', 'role').dispatch('click');
  __out.afterClickInactive = JSON.stringify(state.units.sorts);
  __out.sortAfterClickInactive = JSON.stringify(lastSort());

  // 点「稀有度」列名 -> 替换为唯一主键
  hdr('units', 'rarity').dispatch('click');
  __out.afterClickRarity = JSON.stringify(state.units.sorts);

  // 点「类型」的「+」-> 追加为第二级
  plus('units', 'role').dispatch('click');
  __out.afterAddRole = JSON.stringify(state.units.sorts);
  __out.sortAfterAddRole = JSON.stringify(lastSort());
  await tick();
  __out.rarityHeader = hdr('units', 'rarity').textContent;
  __out.roleHeader = hdr('units', 'role').textContent;
  __out.rolePlus = plus('units', 'role').textContent;

  // 再点「稀有度」列名 -> 切换主键升降序（不改变级别构成）
  hdr('units', 'rarity').dispatch('click');
  __out.afterToggleRarity = JSON.stringify(state.units.sorts);

  // 再点「类型」的「+」-> 移除该级
  plus('units', 'role').dispatch('click');
  __out.afterRemoveRole = JSON.stringify(state.units.sorts);

  // 其它 Tab 独立：characters 点「类型」+ 后 = 稀有度,类型
  plus('characters', 'type').dispatch('click');
  __out.charSorts = JSON.stringify(state.characters.sorts);
  __out.charUrl = JSON.stringify(lastSortFor('/api/characters?'));

  // supporters：点「名称」列名 -> 唯一主键
  hdr('supporters', 'name').dispatch('click');
  __out.supSorts = JSON.stringify(state.supporters.sorts);
  __out.supUrl = JSON.stringify(lastSortFor('/api/supporters?'));

  // 三键：units 稀有度(升) + 类型 + 名称
  plus('units', 'role').dispatch('click');
  plus('units', 'name').dispatch('click');
  await tick();
  __out.threeKeys = JSON.stringify(state.units.sorts);
  __out.sortThree = JSON.stringify(lastSort());
  __out.nameHeader3 = hdr('units', 'name').textContent;
  return true;
})()`;

sandbox.headers = headers;
sandbox.pluses = pluses;
sandbox.urls = urls;
const ctx = vm.createContext(sandbox);
Promise.resolve(vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+test' }))
  .then(() => {
    const o = ctx.__out || {};
    const j = (s) => JSON.parse(s);
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const checks = [
      ['初始=稀有度降序', eq(j(o.initial), [{ k: 'rarity', o: 'desc' }])],
      ['点未参与列名=唯一主键', eq(j(o.afterClickInactive), [{ k: 'role', o: 'desc' }])],
      ['请求随之变 role', eq(j(o.sortAfterClickInactive), ['role', 'desc'])],
      ['点另一列名=替换主键', eq(j(o.afterClickRarity), [{ k: 'rarity', o: 'desc' }])],
      ['「+」追加第二级', eq(j(o.afterAddRole), [{ k: 'rarity', o: 'desc' }, { k: 'role', o: 'desc' }])],
      ['请求带 sort=rarity,role', eq(j(o.sortAfterAddRole), ['rarity,role', 'desc,desc'])],
      ['主键表头带箭头', /稀有度/.test(o.rarityHeader) && /[▲▼]/.test(o.rarityHeader)],
      ['第二级表头带②', o.roleHeader.includes('②')],
      ['「+」变为×', o.rolePlus === '×'],
      ['再点列名切换主键升降序', eq(j(o.afterToggleRarity), [{ k: 'rarity', o: 'asc' }, { k: 'role', o: 'desc' }])],
      ['再点「+」移除该级', eq(j(o.afterRemoveRole), [{ k: 'rarity', o: 'asc' }])],
      ['characters 独立', eq(j(o.charSorts), [{ k: 'rarity', o: 'desc' }, { k: 'type', o: 'desc' }])],
      ['characters 请求串', eq(j(o.charUrl), ['rarity,type', 'desc,desc'])],
      ['supporters 单键', eq(j(o.supSorts), [{ k: 'name', o: 'desc' }])],
      ['supporters 请求串', eq(j(o.supUrl), ['name', 'desc'])],
      ['支持三键', eq(j(o.threeKeys), [{ k: 'rarity', o: 'asc' }, { k: 'role', o: 'desc' }, { k: 'name', o: 'desc' }])],
      ['三键请求串', eq(j(o.sortThree), ['rarity,role,name', 'asc,desc,desc'])],
      ['第三级表头带③', o.nameHeader3.includes('③')],
    ];
    let bad = 0;
    for (const [name, ok] of checks) {
      console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
      if (!ok) bad++;
    }
    console.log('---');
    console.log('state.units.sorts =', o.threeKeys);
    console.log('last sort/order =', o.sortThree);
    console.log(bad ? 'SMOKE_FAILED=' + bad : 'SMOKE_OK');
    process.exit(bad ? 1 : 0);
  })
  .catch((e) => {
    console.error('SMOKE_ERROR', e);
    process.exit(2);
  });
