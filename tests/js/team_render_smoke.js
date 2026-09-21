/* 组队页渲染冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/team_render_smoke.js [app.js 路径]
 *   默认路径：web/app.js（相对仓库根）
 *
 * 原理：app.js 是普通脚本（非 IIFE），把 DOM 桩注入 vm 上下文后真跑一遍
 * app.js，再在同一个脚本作用域里调用 renderTeam() 等函数——因此能拿到
 * 词法作用域的 const（如 teamState），从而校验：
 *   - 渲染期没有运行时错误（拼写 / 未定义变量）
 *   - 卡片按类型输出 data-role 与 type-chip（攻/耐/援）
 *   - 跨队伍去重：usedIdsAcrossTeams 的排除集合是否正确
 *   - 历史数据中的跨队伍重复能否被检出并提示
 * 退出码 0 = 全部通过。
 */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'web/app.js';
const src = fs.readFileSync(path, 'utf8');

const els = new Map();
function makeEl(sel) {
  return {
    _sel: sel,
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', className: '', hidden: false,
    children: [],
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
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
    querySelector() { return makeEl('sub'); }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    focus() {}, blur() {}, click() {}, insertAdjacentHTML() {},
    firstChild: null, parentNode: null, scrollTop: 0, scrollHeight: 0,
  };
}
const document = {
  querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
  querySelectorAll() { return []; },
  getElementById(id) { return this.querySelector('#' + id); },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'), documentElement: makeEl('html'), hidden: false,
};
const store = new Map();
const sandbox = {
  console, document, Intl, Math, JSON, Date, Promise, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, teams: [] }) }),
  alert() {}, confirm: () => true,
  location: { href: 'http://127.0.0.1:8777/', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  URLSearchParams, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const TESTS = `
function __slot(unit, pilot) { return { unit: unit || null, star: 3, weapon: null, pilot: pilot || null }; }
teamState.teams = [
  { id: 'a', bench: 'low', customEnemy: { unit_defense: 1060, character_defense: 109 }, breakStep: 3,
    supporter: { id: 999, name: '支援A', rarity: 5 },
    slots: [
      __slot({ id: 1001000150, name: 'RX-78-2 高达', rarity: 5, role: 1, role_label: '攻击型' },
             { id: 1001000100, name: '阿姆罗', rarity: 5, role: 2, role_label: '耐久型' }),
      __slot(), __slot(), __slot(), __slot() ] },
  { id: 'b', bench: 'mid', customEnemy: { unit_defense: 25072, character_defense: 705 }, breakStep: 3,
    supporter: { id: 999, name: '支援A', rarity: 5 },
    slots: [
      __slot({ id: 2002000250, name: '扎古II', rarity: 3, role: 3, role_label: '支援型' }, null),
      __slot(), __slot(), __slot(), __slot() ] },
];
renderTeam();
__out = document.querySelector('#team-list').innerHTML;
__conflict = document.querySelector('#team-conflict').innerHTML;
__exUnitSlot0 = [...usedIdsAcrossTeams('unit', 'a', 0)];
__exUnitSlot1 = [...usedIdsAcrossTeams('unit', 'a', 1)];
__exSupA = [...usedIdsAcrossTeams('supporter', 'a', null)];
__exPilotSlot0 = [...usedIdsAcrossTeams('pilot', 'a', 0)];
__blocked = pickerBlocked('unit', 'a', 1, { id: 2002000250, name: '扎古II' });
`;

const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+test' });

const out = ctx.__out || '';
const conflict = ctx.__conflict || '';
const checks = [
  ['队伍编号', out.includes('队伍 1') && out.includes('队伍 2')],
  ['机体卡片带 data-role', /team-unit-card[^>]*data-role="1"/.test(out)],
  ['驾驶员卡片带 data-role', /team-pilot-card[^>]*data-role="2"/.test(out)],
  ['攻击型 chip', out.includes('type-chip t-atk') && out.includes('攻击型')],
  ['支援型 chip', out.includes('type-chip t-sup') && out.includes('支援型')],
  ['耐久型 chip', out.includes('type-chip t-tank')],
  ['空槽位无 data-role', /data-kind="unit">\s*<div class="team-card-empty">/.test(out)],
  ['跨队伍重复提示', conflict.includes('跨队伍重复') && conflict.includes('支援角色')],
  ['提示含队号', conflict.includes('第 1 支') && conflict.includes('第 2 支')],
  ['排除集(槽0自身不计)', ctx.__exUnitSlot0.length === 1 && ctx.__exUnitSlot0[0] === '2002000250'],
  ['排除集(槽1计入全部2台)', ctx.__exUnitSlot1.length === 2],
  ['支援排除集(本队不计, 含B队同款)', ctx.__exSupA.length === 1 && ctx.__exSupA[0] === '999'],
  ['驾驶员排除集(排除槽0自身=>空)', ctx.__exPilotSlot0.length === 0],
  ['pickerBlocked 拦截重复', ctx.__blocked === true],
  ['类型字形 攻/耐/援', out.includes('<i>攻</i>') && out.includes('<i>耐</i>') && out.includes('<i>援</i>')],
  ['终极标记(仅终极机体)', /badge ultimate/.test(out) === false],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) bad++;
}
console.log('---');
console.log('rendered html length:', out.length);
console.log('conflict text:', conflict.replace(/<[^>]+>/g, ' ').slice(0, 200));
console.log('exUnitSlot0 =', JSON.stringify(ctx.__exUnitSlot0));
console.log('exUnitSlot1 =', JSON.stringify(ctx.__exUnitSlot1));
console.log(bad ? 'SMOKE_FAILED=' + bad : 'SMOKE_OK');
process.exit(bad ? 1 : 0);
