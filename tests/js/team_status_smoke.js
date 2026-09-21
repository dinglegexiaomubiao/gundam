/* 队伍状态摘要（卡片底部）渲染冒烟校验（无需浏览器）
 *
 * 用法：
 *   node tests/js/team_status_smoke.js [app.js 路径]
 *   默认路径：web/app.js（相对仓库根）
 *
 * 用同步版 DOM 桩真跑 app.js，再直接喂一份 insights 给 renderTeamStatus()，
 * 校验渲染出的结构与关键文案：
 *   - 三段（攻击 / 支援 / 防御）分别渲染，类型色类正确
 *   - 攻击型：排除 MAP 的射程 + 最高伤害武器的伤害类型胶囊
 *   - 支援型：特效条目带射程 + 匹配结果逐项列出命中/未命中
 *   - 防御型：移动力 / 减伤含属性胶囊 / 阈值无效 / 单位技能 / 驾驶员协同状态
 *   - 缺少 role 时显示「本队缺少 X 型机体」
 *   - 无 insights 时不渲染（向后兼容旧响应）
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
  console, document, Intl, Math, JSON, Date, Promise, Object, Array, String, Number, Boolean,
  Set, Map, RegExp, Error, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  fetch: () => new Promise(() => {}),      // 同步测试：所有请求挂起
  alert() {}, confirm: () => true,
  location: { href: 'http://127.0.0.1:8765/', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  URLSearchParams, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const FULL = {
  attack: {
    unit: { id: 1200003950, name: '神高达 (EX)' },
    range: { max: 5, max_nomap: 5, weapon_count: 5, map_count: 0 },
    best_weapon: {
      id: 1967, name: '洗牌同盟拳 EX', damage: 157214, attrs: [1, 3],
      dep_label: '射击、格斗、特殊', range_min: 1, range_max: 3, map: false,
    },
  },
  support: {
    units: [{ id: 1001000400, name: '核心战机' }],
    pilot: { id: 1009000100, name: '奥利佛·梅', rarity: 5 },
    support_counts: { attack: { count: 2, conditional: false } },
    pilot_mechanics: [{ label: '无条件支援攻击2次', kind: 'support' }],
    effects: [
      { label: '物理损伤提升（1回合）LV4', kind: 'dmg_up', types: [1], value: 25,
        weapon: '空对空导弹 SSP', range_min: 2, range_max: 5 },
      { label: '防御力减少 LV3', kind: 'def_down', types: [], value: 15,
        weapon: '机关枪', range_min: 1, range_max: 3 },
    ],
    dmg_up_types: [1],
  },
  defense: {
    unit: { id: 1370005950, name: '00强化模组 (最后决战式样) (EX)' },
    pilot: { id: 1370003701, name: '刹那·F·清英' },
    movement: { base: 5, max: 5, star: 3 },
    mitigations: [
      { label: 'GN力场 LV4', value: 20, attrs: [1, 2], desc: '发起战斗的敌方使用物理、光束武装攻击时，自身受到的损伤减轻20%' },
    ],
    thresholds: [{ label: 'GN力场 LV4', value: 4500, desc: '自身受到的损伤4500以下时，损伤无效' }],
    boosts: [
      { label: '防御力提升 & EN恢复（单体）LV3', value: 15, conditional: false,
        cond_ok: true, cond_text: '' },
      { label: '（常态＆战意条件）攻击力提升 LV2', value: 10, conditional: true,
        cond_ok: null, cond_text: '自身战意为“超一击”以上时' },
      { label: '（特定机体）真实之力 LV3', value: 20, conditional: true,
        cond_ok: false, cond_text: '搭乘单位为“独角兽高达”时' },
    ],
    unit_skill: { name: '单位技能【00强化模组】', desc: '自身攻击力提升25%（1回合） 自身防御力提升15%（1回合） （每场战斗1次）' },
    pilot_mechanics: [
      { label: '无条件支援防御2次', kind: 'support' },
      { label: '反击援防', kind: 'counter_guard' },
      { label: '额外行动', kind: 'extra_action' },
    ],
    pilot_synergy: [
      { source: '能力', ability: '支援防御 LV5', unit_ok: true, status: 'counted',
        verdict: 'met', note: '条件已满足',
        desc: '搭乘单位含有类型且自身进行支援防御时，自身防御力提升25%' },
      { source: '能力', ability: 'EX角色能力', unit_ok: true, status: 'counted',
        verdict: 'met', note: '条件已满足',
        desc: '搭乘单位为“00强化模组 (最后决战式样) (EX)”且自身HP为0%时，自身HP恢复7%(1次)' },
      { source: '能力', ability: '真正的变革者 LV5', unit_ok: true, status: 'counted',
        verdict: 'met', note: '条件已满足',
        desc: '搭乘单位含有高达、机动战士高达00，自身MP提升5' },
      { source: '能力', ability: '不会生效的能力', unit_ok: false, status: 'impossible',
        verdict: 'unmet', note: '不能触发',
        desc: '搭乘单位为“其它机体”时，自身防御力提升10%' },
      { source: '技能', ability: '无条件的技能', unit_ok: true, status: 'counted',
        verdict: 'always', note: '',
        desc: '自身MP提升7' },
    ],
  },
  match: {
    attack_attrs: [1, 3],
    attack_weapon: '洗牌同盟拳 EX',
    rows: [
      { type: 1, support_hit: true, support_by: ['物理损伤提升（1回合）LV4'],
        defense_hit: true, defense_by: ['GN力场 LV4 减伤 20%'] },
      { type: 3, support_hit: false, support_by: [], defense_hit: false, defense_by: [] },
    ],
    covered: [{ type: 1, by: '物理损伤提升（1回合）LV4' }],
    missed: [{ type: 3 }],
    hit_count: 1,
    total: 2,
    support_hit_count: 1, support_total: 2,
    defense_hit_count: 1, defense_total: 2,
    missing_types: [3],
  },
  missing: { attack: false, support: false, defense: false },
  synergy: {
    level: 'partial',
    title: '部分匹配',
    detail: '支援提供 物理损伤提升，攻击武器「洗牌同盟拳 EX」为 物理、特殊；命中 物理，未命中 特殊：1/2',
    defense_detail: '防御型对 物理 有减伤，未覆盖 特殊',
    defense_state: 'partial',
    baseline: {
      passed: 3, total: 4, ok: false, bonus_count: 2,
      items: [
        { key: 'movement', label: '移动力', unit: '全队', need: 5, actual: 4, best: 5,
          ok: false, bonus: false,
          units: [{ name: '神高达 (EX)', value: 5 }, { name: '核心战机', value: 4 }],
          detail: '全队移动力 4～5，未达标：核心战机 4' },
        { key: 'support_range', label: '支援型特效射程', unit: '核心战机', need: 5, actual: 5,
          ok: true, bonus: false,
          detail: '对攻击型生效的特效「物理损伤提升（1回合）LV4」射程 5，达到及格线' },
        { key: 'support_attack', label: '支援攻击次数', unit: '奥利佛·梅', need: 2, actual: 3,
          ok: true, bonus: true, detail: '支援攻击 3 次，达到及格线（加分）' },
        { key: 'defense_support', label: 'UR 防御型（支援防御 / 反击援防）', unit: '刹那·F·清英',
          need: 2, actual: 2, ok: true, bonus: false, detail: '支援防御 2 次，达到及格线' },
      ],
      bonuses: [
        { key: 'support_extra', label: '支援额外特效', unit: '核心战机',
          detail: '攻击型之外另有 1 条：防御力减少 LV3' },
        { key: 'defense_mitigation', label: '防御减伤 / 特殊能力',
          unit: '00强化模组 (最后决战式样) (EX)',
          detail: '对 物理、光束 减伤 20%；损伤 ≤4500 无效；可触发能力：防御力提升 & EN恢复（单体）LV3'
            + '；条件能力（可达成）：（常态＆战意条件）攻击力提升 LV2 ｜ 自身战意为“超一击”以上时'
            + '；条件能力（未达成）：（特定机体）真实之力 LV3 ｜ 需 搭乘单位为“独角兽高达”时' },
      ],
    },
  },
};

// 双攻击型变体：验证「两台都要展示」+「匹配按台分组」
const TWO = JSON.parse(JSON.stringify(FULL));
TWO.attacks = [
  TWO.attack,
  {
    unit: { id: 1001003050, name: '吉翁号 (EX)' },
    range: { max: 4, max_nomap: 4, weapon_count: 3, map_count: 0 },
    best_weapon: {
      id: 501, name: '全领域攻击 EX', damage: 86148, attrs: [2, 3],
      dep_label: '射击', range_min: 1, range_max: 4, map: false,
    },
  },
];
TWO.match = Object.assign({}, TWO.match, {
  attack_count: 2,
  union_attrs: [1, 2, 3],
  total_hit_count: 1, total_types: 4,
  full_count: 0, none_count: 1,
  defense_hit_total: 2, defense_types: 3,
  groups: [
    {
      unit: { id: 1200003950, name: '神高达 (EX)' },
      weapon: '洗牌同盟拳 EX', attrs: [1, 3],
      hit_count: 1, total: 2, defense_hit_count: 1, defense_total: 2,
      rows: [
        { type: 1, support_hit: true, support_by: ['物理损伤提升（1回合）LV4'],
          defense_hit: true, defense_by: ['GN力场 LV4 减伤 20%'] },
        { type: 3, support_hit: false, support_by: [], defense_hit: false, defense_by: [] },
      ],
    },
    {
      unit: { id: 1001003050, name: '吉翁号 (EX)' },
      weapon: '全领域攻击 EX', attrs: [2, 3],
      hit_count: 0, total: 2, defense_hit_count: 1, defense_total: 2,
      rows: [
        { type: 2, support_hit: false, support_by: [], defense_hit: true,
          defense_by: ['GN力场 LV4 减伤 20%'] },
        { type: 3, support_hit: false, support_by: [], defense_hit: false, defense_by: [] },
      ],
    },
  ],
});

const FULL_ALIAS = FULL;

// 完全匹配的变体：用于校验「达标 = 绿底」，与减分项的红底区分开
const FULL_OK = JSON.parse(JSON.stringify(FULL));
FULL_OK.synergy.level = 'full';
FULL_OK.synergy.title = '完全匹配';
FULL_OK.synergy.detail =
  '支援提供 物理、特殊损伤提升，完全覆盖攻击武器「洗牌同盟拳 EX」的 物理、特殊：2/2';
FULL_OK.synergy.defense_state = 'full';
FULL_OK.synergy.defense_detail = '防御型对 物理、特殊 有减伤';

const MISSING = {
  attack: null, support: null, defense: null, match: null,
  missing: { attack: true, support: true, defense: true },
};

const TESTS = `
__full = renderTeamStatus({ insights: ${JSON.stringify(FULL)} });
__ok = renderTeamStatus({ insights: ${JSON.stringify(FULL_OK)} });
__two = renderTeamStatus({ insights: ${JSON.stringify(TWO)} });
__missing = renderTeamStatus({ insights: ${JSON.stringify(MISSING)} });
__legacy = renderTeamStatus({ pairs: [] });
__noRes = renderTeamStatus(null);
`;

const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;' + TESTS, ctx, { filename: 'app.js+status-test' });

const full = ctx.__full || '';
const okAlt = ctx.__ok || '';
const two = ctx.__two || '';
const missing = ctx.__missing || '';
const checks = [
  ['有 insights 时渲染队伍状态', full.includes('team-status') && full.includes('队伍状态')],
  ['攻击段渲染 + 类型色类', full.includes('ts-sec ts-atk') && full.includes('攻击型 · 神高达 (EX)')],
  ['攻击段显示排除 MAP 的射程', full.includes('最大射程') && full.includes('>5<')],
  ['攻击段显示最高伤害武器与数值', full.includes('洗牌同盟拳 EX') && full.includes('157,214')],
  ['攻击段伤害类型胶囊 物理/特殊', /ts-chip[^>]*>物理</.test(full) && /ts-chip[^>]*>特殊</.test(full)],
  ['支援段渲染特效与射程', full.includes('ts-sec ts-sup') && full.includes('物理损伤提升（1回合）LV4') && full.includes('射程 2-5')],
  ['支援段识别防御力减少', full.includes('ts-chip down') && full.includes('防御力减少 LV3')],
  ['匹配段渲染逐类型行', full.includes('ts-mrow') && full.includes('ts-mtype')],
  ['匹配段含支援命中列', full.includes('支援命中') && full.includes('← 物理损伤提升（1回合）LV4')],
  ['匹配段含支援未命中列与原因', full.includes('支援未命中') && full.includes('缺少「特殊损伤提升」')],
  ['匹配段含防御减伤列', full.includes('防御减伤') && full.includes('GN力场 LV4 减伤 20%')],
  ['匹配段含防御未减伤列', full.includes('防御未减伤')],
  ['匹配段双列计数', full.includes('命中 <b>1/2</b>') && full.includes('防御减伤 <b>1/2</b>')],
  ['防御段渲染移动力', full.includes('ts-sec ts-tank') && full.includes('移动力')],
  ['防御段减伤覆盖写明伤害类型', full.includes('减伤覆盖') && full.includes('>物理</span>') && full.includes('>光束</span>')],
  ['防御段逐条写明对哪些类型减伤', full.includes('「GN力场 LV4」对 物理、光束 减伤')],
  ['防御段可触发能力只列 cond_ok=true',
    (() => {
      // 只检查「可触发能力」胶囊本身（.ts-chip.mech），
      // 不能用 /可触发能力[^<]*条件/ 这类正则 —— 加分项文案里
      // 「可触发能力：…；条件能力（可达成）：（常态＆战意条件）…」会误命中。
      const chips = full.match(/ts-chip mech">[^<]*/g) || [];
      const joined = chips.join('');
      return chips.length > 0
        && joined.includes('防御力提升 &amp; EN恢复（单体）LV3')
        && !joined.includes('常态＆战意条件')
        && !joined.includes('真实之力');
    })()],
  ['防御段阈值无效', full.includes('时无效') && full.includes('4,500')],
  ['防御段单位技能', full.includes('单位技能') && full.includes('攻击力提升25%')],
  ['驾驶员协同：括号改为「条件已满足」', full.includes('（条件已满足）') && !full.includes('触发时机待定')],
  ['驾驶员协同：不能触发', full.includes('（不能触发）') && full.includes('ts-syn impossible')],
  ['驾驶员协同：恒生效条目不显示括号', /自身MP提升7<\/li>/.test(full)],
  ['驾驶员机制：支援防御次数', full.includes('驾驶员机制') && full.includes('无条件支援防御2次')],
  ['驾驶员机制：反击援防', full.includes('反击援防') && full.includes('ts-chip mech')],
  ['驾驶员协同：HP恢复标为已满足', /HP恢复7%\(1次\)<span class="ts-note">（条件已满足）/.test(full.replace('<\/span>', '</span>'))],
  ['支援段显示支援次数', full.includes('支援次数') && full.includes('支援攻击 <b>2</b> 次')],
  ['支援段显示支援机制胶囊', full.includes('无条件支援攻击2次')],
  ['匹配说明攻击武器与其类型', full.includes('伤害类型匹配 · 攻击型最高伤害武器') && full.includes('物理 · 特殊')],
  ['匹配说明支援提供了什么', full.includes('支援提供 物理损伤提升')],
  ['支援特效标出「对攻击型生效」', full.includes('ts-tag used') && full.includes('对攻击型生效')],
  ['整队协同块存在', full.includes('ts-sec ts-syn') && full.includes('整队协同 · 部分匹配')],
  ['整队协同含结论句', full.includes('1/2') && full.includes('支援提供 物理损伤提升，攻击武器')],
  ['及格线显示通过数', full.includes('及格线 <b>3/4</b>')],
  ['移动力合并为一条并写明结论', full.includes('移动力：全队移动力 4～5，未达标：核心战机 4')],
  ['移动力明细放 title（逐台）', full.includes('神高达 (EX) 5｜核心战机 4')],
  ['支援射程说明是哪个特效且注明及格', full.includes('支援型特效射程：对攻击型生效的特效「物理损伤提升（1回合）LV4」射程 5，达到及格线')],
  ['超出及格线标为加分项', full.includes('ts-chip ok bonus') && full.includes('支援攻击 3 次，达到及格线（加分）')],
  ['及格线含 UR 防御项', full.includes('UR 防御型（支援防御 / 反击援防）：支援防御 2 次，达到及格线')],
  ['协同块显示防御覆盖', full.includes('防御型对 物理 有减伤，未覆盖 特殊')],
  ['协同结论为带底条块（减分项红底 + ✗）',
    /ts-line bad">✗ 支援提供 物理损伤提升/.test(full)],
  ['防御覆盖也是带底条块（减分项红底 + ✗）',
    /ts-line bad">✗ 防御型对 物理 有减伤，未覆盖 特殊/.test(full)],
  ['完全匹配时结论为绿底（达标）',
    /ts-line ok">✓ 支援提供 物理、特殊损伤提升，完全覆盖/.test(okAlt)],
  ['完全覆盖时防御行为绿底', /ts-line ok">✓ 防御型对 物理、特殊 有减伤/.test(okAlt)],
  ['协同条块不再用旧的无底色 class',
    !full.includes('ts-syn-detail') && !full.includes('ts-syn-def')],
  ['多台攻击型：逐台都有状态段',
    two.includes('攻击型 1 · 神高达 (EX)') && two.includes('攻击型 2 · 吉翁号 (EX)')],
  ['多台攻击型：标出伤害最高的那台', two.includes('ts-tag best') && two.includes('伤害最高')],
  ['多台攻击型：两台武器与类型都展示',
    two.includes('洗牌同盟拳 EX') && two.includes('全领域攻击 EX')
    && two.includes('>光束</span>')],
  ['多台攻击型：匹配按台分组', (two.match(/ts-mgroup/g) || []).length === 2],
  ['多台攻击型：汇总标题给出台数与合计',
    two.includes('伤害类型匹配 · 2 台攻击型') && two.includes('命中 <b>1/4</b>')
    && two.includes('防御减伤 <b>2/3</b>')],
  ['多台攻击型：每组标出自己的命中数（部分=琥珀、全未命中=红）',
    two.includes('ts-mhit part') && two.includes('ts-mhit bad')
    && two.includes('命中 1/2') && two.includes('命中 0/2')],
  ['多台攻击型：逐类型仍分支援/防御两列',
    (two.match(/支援未命中/g) || []).length >= 2
    && two.includes('防御未减伤') && two.includes('防御减伤')],
  ['协同块列出加分项', full.includes('加分项 <b>2</b>') && full.includes('支援额外特效')
    && full.includes('防御减伤 / 特殊能力')],
  ['条件能力列出名称与条件（可达成）',
    full.includes('条件能力（可达成）：（常态＆战意条件）攻击力提升 LV2 ｜ 自身战意为“超一击”以上时')],
  ['条件能力注明未达成',
    full.includes('条件能力（未达成）：（特定机体）真实之力 LV3 ｜ 需 搭乘单位为“独角兽高达”时')],
  ['不再出现「另有 N 条需条件的能力」这种笼统描述',
    !/另有\s*\d+\s*条需条件的能力/.test(full)],
  ['缺少 role 时提示缺少', missing.includes('本队缺少攻击型机体')
    && missing.includes('本队缺少支援型机体') && missing.includes('本队缺少耐久型机体')],
  ['无 insights 时不渲染（向后兼容）', ctx.__legacy === '' && ctx.__noRes === ''],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) bad++;
}
console.log('---');
console.log('full html length:', full.length);
if (bad) {
  console.log('--- full html ---');
  console.log(full.slice(0, 2400));
}
console.log(bad ? 'STATUS_SMOKE_FAILED=' + bad : 'STATUS_SMOKE_OK');
process.exit(bad ? 1 : 0);
