/* 组队页「删除队伍」链路冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/team_delete_smoke.js [app.js 路径]
 *   默认路径：web/app.js（相对仓库根）
 *
 * 背景（回归目标）：删除按钮曾只把队伍从内存/localStorage 移除，**从不调用
 * /api/team/delete**，因此后端 team 表里的行仍在，刷新时被 /api/team/list
 * 原样复原 —— 表现为「删了但刷新后又回来了」。另外 fetchTeamFromServer 里
 * 「后端为空则迁移一次」的逻辑会把「删光所有队伍」也误判成迁移场景，把队伍
 * 重新写回后端。
 *
 * 本脚本用 DOM 桩 + 带状态的内存「假后端」真跑 app.js，校验：
 *   1. 点删除 → 确实发出 POST /api/team/delete，且 body 带 team_id
 *   2. 删除后模拟刷新（服务端已少一支）→ 本地只剩 1 支，被删的不再出现
 *   3. 服务端返回空数组（删光）→ 本地清空，且**不会**被「迁移」逻辑写回
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
  alert() {}, confirm: () => true,
  location: { href: 'http://127.0.0.1:8765/', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  URLSearchParams, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},

  // ---- 带状态的假后端 ----
  __armed: false,        // false 时所有请求挂起 —— 隔离 app.js 自身的初始化流量
  __server: [],          // 服务端 team 列表
  __calls: [],           // 记录所有请求，用于断言「确实发出了删除请求」
  __failNext: null,      // 置为 url 可让下一次该 url 请求失败（用于错误路径）
};

sandbox.fetch = function (url, opts) {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  let body = null;
  try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (_) {}
  sandbox.__calls.push({ url: u, method, body });

  // 未「武装」前一律挂起，隔离 app.js 自身初始化（它会立刻请求 /api/series、
  // /api/team/list、/api/summary…）。否则那批请求会在测试布置状态之前拿到空队伍列表，
  // 触发「后端为空→迁移」分支，反过来污染假后端。
  // 武装之后也只响应组队端点：其它请求继续挂起，避免无关模块用错字段崩掉。
  const TEAM_EPS = ['/api/team/list', '/api/team/delete', '/api/team/save', '/api/team/config'];
  if (!sandbox.__armed || !TEAM_EPS.some((p) => u.indexOf(p) === 0)) {
    return new Promise(() => {});
  }

  if (sandbox.__failNext && u.indexOf(sandbox.__failNext) === 0) {
    sandbox.__failNext = null;
    return Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) });
  }

  let payload;
  if (u.indexOf('/api/team/list') === 0) {
    payload = { ok: true, teams: sandbox.__server };
  } else if (u.indexOf('/api/team/delete') === 0) {
    const tid = (body && body.team_id) || '';
    sandbox.__server = sandbox.__server.filter((t) => t.team_id !== tid);
    payload = { ok: true, synced: true };
  } else if (u.indexOf('/api/team/save') === 0) {
    const tid = (body && body.team_id) || '';
    if (tid && !sandbox.__server.some((t) => t.team_id === tid)) {
      sandbox.__server.push({ team_id: tid, name: '', payload: body.data });
    }
    payload = { ok: true };
  } else {
    payload = { ok: true };
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => payload });
};

sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const mkTeam = (id, bench) => ({
  id, bench, customEnemy: { unit_defense: 1060, character_defense: 109 }, breakStep: 3,
  supporter: null,
  slots: [{ unit: null, star: 3, weapon: null, pilot: null },
          { unit: null, star: 3, weapon: null, pilot: null },
          { unit: null, star: 3, weapon: null, pilot: null },
          { unit: null, star: 3, weapon: null, pilot: null },
          { unit: null, star: 3, weapon: null, pilot: null }],
});

const TESTS = `
function __flush() { return new Promise((r) => setTimeout(r, 0)); }

(async () => {
  // 先把状态布置好，再「武装」mock，确保 app.js 初始化流量不参与
  teamState.teams = [ ${JSON.stringify(mkTeam('a', 'low'))}, ${JSON.stringify(mkTeam('b', 'mid'))} ];
  __server = [ { team_id: 'a', name: '', payload: {} }, { team_id: 'b', name: '', payload: {} } ];
  __armed = true;

  // ---- 1) 点「删除」（目标为队伍 b）----
  const fakeBtn = { dataset: { team: 'b' }, disabled: false };
  const ev = { target: { closest: (sel) => (sel === '.team-remove' ? fakeBtn : null) } };
  onTeamListClick(ev);
  await __flush();

  __afterDelete = teamState.teams.map((t) => t.id);
  __deleteCalls = __calls.filter((c) => c.url.indexOf('/api/team/delete') === 0)
                          .map((c) => ({ url: c.url, method: c.method, team_id: c.body && c.body.team_id }));
  __serverAfterDelete = __server.map((t) => t.team_id);

  // ---- 2) 模拟刷新（服务端已少一支）----
  await fetchTeamFromServer();
  __afterRefresh = teamState.teams.map((t) => t.id);

  // ---- 3) 服务端为空（把剩下那支也删光）----
  __server = [];
  const saveCallsBefore = __calls.filter((c) => c.url.indexOf('/api/team/save') === 0).length;
  await fetchTeamFromServer();
  __afterEmpty = teamState.teams.length;
  __saveCallsAfterEmpty = __calls.filter((c) => c.url.indexOf('/api/team/save') === 0).length;
  __saveCallsBeforeEmpty = saveCallsBefore;

  // ---- 4) 删除请求失败时不静默改本地 ----
  teamState.teams = [ ${JSON.stringify(mkTeam('a', 'low'))} ];
  __failNext = '/api/team/delete';
  const fakeBtn2 = { dataset: { team: 'a' }, disabled: false };
  onTeamListClick({ target: { closest: (sel) => (sel === '.team-remove' ? fakeBtn2 : null) } });
  await __flush();
  __afterFailedDelete = teamState.teams.map((t) => t.id);
  __btnReenabled = fakeBtn2.disabled === false;

  __done = true;
})();
`;

const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+delete-test' });

new Promise((resolve) => {
  const t0 = Date.now();
  (function poll() {
    if (ctx.__done || Date.now() - t0 > 5000) return resolve();
    setTimeout(poll, 10);
  })();
}).then(() => {
  const delCalls = ctx.__deleteCalls || [];
  const checks = [
    ['发出删除请求', delCalls.length === 1],
    ['删除用 POST', delCalls[0] && delCalls[0].method === 'POST'],
    ['请求路径为 /api/team/delete', delCalls[0] && delCalls[0].url === '/api/team/delete'],
    ['请求带 team_id', delCalls[0] && delCalls[0].team_id === 'b'],
    ['删除后本地只剩 a', JSON.stringify(ctx.__afterDelete) === JSON.stringify(['a'])],
    ['服务端已删（假后端）', JSON.stringify(ctx.__serverAfterDelete) === JSON.stringify(['a'])],
    ['刷新后仍只有 a（不再复原）', JSON.stringify(ctx.__afterRefresh) === JSON.stringify(['a'])],
    ['服务端清空时本地也清空', ctx.__afterEmpty === 0],
    ['清空不被迁移逻辑写回', ctx.__saveCallsAfterEmpty === ctx.__saveCallsBeforeEmpty],
    ['删除失败时本地不动', JSON.stringify(ctx.__afterFailedDelete) === JSON.stringify(['a'])],
    ['删除失败时按钮恢复可用', ctx.__btnReenabled === true],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) bad++;
  }
  console.log('---');
  console.log('delete calls:', JSON.stringify(delCalls));
  console.log('afterDelete =', JSON.stringify(ctx.__afterDelete),
              '| afterRefresh =', JSON.stringify(ctx.__afterRefresh),
              '| afterEmpty =', ctx.__afterEmpty,
              '| afterFailedDelete =', JSON.stringify(ctx.__afterFailedDelete));
  console.log('save 调用次数：清空前', ctx.__saveCallsBeforeEmpty, '→ 清空后', ctx.__saveCallsAfterEmpty);
  console.log(bad ? 'DELETE_SMOKE_FAILED=' + bad : 'DELETE_SMOKE_OK');
  process.exit(bad ? 1 : 0);
});
