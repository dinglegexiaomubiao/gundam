const $ = (sel) => document.querySelector(sel);
const state = {
  units: { q: "", rarity: "", acq: "", series: "", type: "", tags: [], tag_mode: "all", match: "and", wfx: [], wfx_mode: "any", sort: "rarity", order: "desc", page: 0, size: 25 },
  characters: { q: "", rarity: "", series: "", type: "", tags: [], tag_mode: "all", match: "and", skills: [], skill_mode: "any", sort: "rarity", order: "desc", page: 0, size: 25 },
  supporters: { q: "", tags: [], tag_mode: "any", sort: "rarity", order: "desc", page: 0, size: 25 },
  stages: { q: "", page: 0, size: 25 },
  search: { type: "skill", kind: "all", q: "", sort: "rarity", order: "desc", page: 0, size: 25 },
};
let currentSupporter = null;
const colWidths = {};
const colFlex = {};

function applyColWidths(kind) {
  const head = document.querySelector(`.list-head.${kind}`);
  if (!head || !colWidths[kind]) return;
  const flex = colFlex[kind] ?? 0;
  const tmpl = colWidths[kind].map((w, idx) =>
    idx === flex ? "minmax(180px, 1fr)" : `${Math.max(40, Math.round(w))}px`).join(" ");
  head.style.gridTemplateColumns = tmpl;
  document.querySelectorAll(`.list-row.${kind}`).forEach((r) => {
    r.style.gridTemplateColumns = tmpl;
  });
}

function initColumnResize() {
  colFlex.sr = 3;
  ["units", "chars", "sups", "stages", "sr"].forEach((kind) => {
    const head = document.querySelector(`.list-head.${kind}`);
    if (!head) return;
    [...head.children].forEach((cell, i, arr) => {
      if (i === arr.length - 1) return;
      const handle = document.createElement("div");
      handle.className = "col-resize";
      cell.appendChild(handle);
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!colWidths[kind]) {
          colWidths[kind] = [...head.children].map((c) => c.offsetWidth);
        }
        if ((colFlex[kind] ?? 0) === i) {
          colFlex[kind] = arr.length - 1;
        }
        const widths = colWidths[kind];
        const startX = e.clientX;
        const startW = widths[i];
        const onMove = (ev) => {
          widths[i] = Math.max(40, startW + (ev.clientX - startX));
          applyColWidths(kind);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function weaponEffects(w) {
  const fx = w.effects || [];
  if (!fx.length) return "—";
  return fx.map((e, i) => `
    <div class="wfx">
      <div class="wfx-name">${i + 1}.
        <button class="effect-chip" data-name="${esc(e.name || "")}" title="点击搜索该特效">${esc(e.name || "特效")}</button>
      </div>
      ${e.desc ? `<div class="wfx-desc">${esc(e.desc)}</div>` : ""}
    </div>`).join("");
}

function effectHtml(effects, fallback) {
  const list = (effects || []).filter(Boolean);
  if (!list.length) return esc(fallback || "—");
  return list.map((e) => `<div class="effect">${esc(e)}</div>`).join("");
}

function condChips(conditions) {
  const conds = conditions || [];
  if (!conds.length) return "";
  return `<div class="conds">` + conds.map((c) =>
    `<span class="chip cond" title="适用对象：${esc(c.target || "—")}">${esc(c.text)}</span>`
  ).join("") + `</div>`;
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

function rarityBadge(r) {
  const label = { 5: "UR", 4: "SSR", 3: "SR", 2: "R", 1: "N" }[r] ?? r;
  return `<span class="badge r${r}">${label}</span>`;
}

function cell(html) {
  return `<span>${html}</span>`;
}

function roleBadge(role, label) {
  return `<span class="badge role r-${role ?? 0}">${esc(label ?? "—")}</span>`;
}

function lvBadge(level) {
  return level ? `<span class="badge lv">LV${level}</span>` : "";
}

function tagChip(tag) {
  return `<button class="chip tag-chip" data-tag="${esc(tag)}" title="点击搜索该标签">${esc(tag)}</button>`;
}

function bindTagChips(root) {
  (root || document).querySelectorAll(".tag-chip").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      showTagMenu(b.dataset.tag, e.clientX, e.clientY);
    }));
}

function bindSearchLinks() {
  document.querySelectorAll(".link-name").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchByName(b.dataset.type, b.dataset.name);
    }));
}

function bindEffectChips() {
  document.querySelectorAll(".effect-chip").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchByName("weapon", b.dataset.name);
    }));
}

function bindSupporterConds() {
  document.querySelectorAll(".sup-cond").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.kind === "series") searchUnitsBySeries(Number(b.dataset.id));
      else searchTag(b.dataset.name, "units");
    }));
  const allBtn = $("#sup-all-targets");
  if (allBtn) allBtn.addEventListener("click", searchAllSupporterTargets);
}

function searchAllSupporterTargets() {
  const s = currentSupporter;
  if (!s) return;
  const conds = s.condition_tags || [];
  const seriesIds = conds.filter((c) => c.kind === "series" && c.id).map((c) => c.id);
  const tagNames = conds.filter((c) => c.kind === "tag").map((c) => c.name);
  $("#modal").classList.add("hidden");
  state.units.q = "";
  state.units.series = seriesIds.join(",");
  state.units.type = "";
  state.units.tags = tagNames;
  state.units.tag_mode = "any";
  state.units.match = "or";
  state.units.wfx = [];
  state.units.wfx_mode = "any";
  $("#unit-q").value = "";
  $("#unit-type").value = "";
  $("#unit-tag-mode").value = "any";
  $("#unit-match").value = "or";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  activateTab("units");
  loadUnits(0);
}

function searchByName(type, name) {
  $("#modal").classList.add("hidden");
  state.search.type = type;
  state.search.kind = "all";
  state.search.q = name;
  state.search.page = 0;
  $("#sr-type").value = type;
  $("#sr-kind").value = "all";
  $("#sr-q").value = name;
  activateTab("search");
  loadSearch(0);
}

function searchUnitsBySeries(seriesId) {
  $("#modal").classList.add("hidden");
  state.units.q = "";
  state.units.series = String(seriesId);
  state.units.type = "";
  state.units.tags = [];
  state.units.wfx = [];
  $("#unit-q").value = "";
  $("#unit-type").value = "";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  activateTab("units");
  loadUnits(0);
}

function activateTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "overview") loadSummary();
  if (name === "units") loadUnits();
  if (name === "characters") loadCharacters();
  if (name === "supporters") loadSupporters();
  if (name === "search") loadSearch();
  if (name === "stages") loadStages();
}

function setSelect(selId, value) {
  const sel = $(selId);
  let opt = [...sel.options].find((o) => o.value === value);
  if (!opt) {
    opt = new Option(value, value);
    sel.add(opt);
  }
  sel.value = value;
}

function removeTagMenu() {
  const m = $("#tag-menu");
  if (m) m.remove();
}

function showTagMenu(tag, x, y) {
  removeTagMenu();
  const menu = document.createElement("div");
  menu.id = "tag-menu";
  menu.className = "tag-menu";
  menu.style.left = Math.min(x + 8, window.innerWidth - 230) + "px";
  menu.style.top = Math.min(y + 8, window.innerHeight - 150) + "px";
  menu.innerHTML = [["units", "机体"], ["characters", "驾驶员"], ["supporters", "支援角色"]]
    .map(([k, label]) => `<button data-kind="${k}">在${label}中搜索「${esc(tag)}」</button>`).join("");
  document.body.appendChild(menu);
  menu.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchTag(tag, b.dataset.kind);
      removeTagMenu();
    }));
  setTimeout(() => document.addEventListener("click", removeTagMenu, { once: true }), 0);
}

function searchTag(tag, kind) {
  $("#modal").classList.add("hidden");
  if (kind === "units") {
    $("#unit-q").value = "";
    state.units.q = "";
    state.units.tags = [tag];
    state.units.tag_mode = "all";
    state.units.series = "";
    state.units.type = "";
    state.units.wfx = [];
    state.units.wfx_mode = "any";
    $("#unit-type").value = "";
    syncCombobox("#unit-series-box");
    renderTagChips("unit");
    renderWfxChips();
    activateTab("units");
    loadUnits(0);
  } else if (kind === "characters") {
    $("#char-q").value = "";
    state.characters.q = "";
    state.characters.tags = [tag];
    state.characters.tag_mode = "all";
    state.characters.series = "";
    state.characters.type = "";
    state.characters.skills = [];
    state.characters.skill_mode = "any";
    $("#char-type").value = "";
    syncCombobox("#char-series-box");
    renderTagChips("char");
    renderSkillChips();
    activateTab("characters");
    loadCharacters(0);
  } else {
    $("#sup-q").value = "";
    state.supporters.q = "";
    state.supporters.tags = [tag];
    state.supporters.tag_mode = "any";
    renderTagChips("sup");
    activateTab("supporters");
    loadSupporters(0);
  }
}

function pager(id, total, page, size, go) {
  const pages = Math.max(1, Math.ceil(total / size));
  const el = $(`#${id}-pager`);
  el.innerHTML = `
    <button ${page <= 0 ? "disabled" : ""} data-d="-1">上一页</button>
    <span>第 ${page + 1} / ${pages} 页 · 共 ${total} 条</span>
    <button ${page >= pages - 1 ? "disabled" : ""} data-d="1">下一页</button>`;
  el.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => go(page + Number(b.dataset.d))));
}

/* ---------- 标签切换 ---------- */
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  activateTab(btn.dataset.tab);
});

/* ---------- 概览 ---------- */
async function loadSummary() {
  const d = await api("/api/summary");
  const c = d.counts;
  const cards = [
    ["机体", c.unit, d.expected.unit],
    ["驾驶员", c.character, null],
    ["支援角色", c.supporter, null],
    ["关卡", c.stage, d.expected.stage],
    ["敌方机体", c.stage_map_npc, null],
    ["敌方驾驶员", c.stage_map_npc_character, null],
    ["武器", c.unit_weapon, null],
    ["技能/能力", c.character_skill + c.character_ability, null],
  ];
  const html = cards.map(([k, v, exp]) => {
    const pct = exp ? Math.round((v / exp) * 100) : null;
    return `<div class="stat-card"><div class="k">${k}</div>
      <div class="v">${v}${exp ? `<small> / ${exp}</small>` : ""}</div>
      ${pct !== null ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ""}
    </div>`;
  }).join("");
  $("#tab-overview").innerHTML = `
    <h3>数据概览</h3>
    <div class="stat-grid">${html}</div>
    <p class="desc">数据库构建时间：${esc(d.built_at)}<br>
    数据已全量抓取完成（机体 1210 / 关卡 594）。<br>
    数据来源：soshage.com/gget（zh-CN），仅供个人研究。</p>`;
}

/* ---------- 机体 ---------- */
const comboboxes = {};

const WFX_OPTIONS = [
  { value: "map", label: "有 MAP 武器" },
  { value: "range5", label: "武器最大射程为 5" },
  { value: "range5plus", label: "武器最大射程为 5 以上" },
  { value: "range5_nomap", label: "武器最大射程为 5（不含 MAP 武装）" },
  { value: "range5plus_nomap", label: "武器最大射程为 5 以上（不含 MAP 武装）" },
  { value: "phys", label: "物理损伤提升特效" },
  { value: "beam", label: "光束损伤提升特效" },
  { value: "spec", label: "特殊损伤提升特效" },
  { value: "phys_r5", label: "物理损伤提升特效（射程 5 及以上）" },
  { value: "beam_r5", label: "光束损伤提升特效（射程 5 及以上）" },
  { value: "spec_r5", label: "特殊损伤提升特效（射程 5 及以上）" },
  { value: "defdown", label: "防御力减少" },
  { value: "defdown_r5", label: "防御力减少（射程 5 及以上）" },
];

function syncCombobox(boxId) {
  const cfg = comboboxes[boxId];
  if (!cfg) return;
  const box = $(boxId);
  const input = box.querySelector(".sbox-input");
  const clear = box.querySelector(".sbox-clear");
  const v = cfg.getVal();
  let label = "";
  if (v && String(v).includes(",")) {
    label = `多系列（${String(v).split(",").length}）`;
  } else {
    const opt = cfg.options.find((o) => String(o.value) === String(v));
    label = opt ? opt.label : "";
  }
  input.value = label;
  if (clear) clear.classList.toggle("hidden", !v);
}

function initCombobox(boxId, options, getVal, onPick, clearable) {
  const box = $(boxId);
  if (!box) return;
  const input = box.querySelector(".sbox-input");
  const list = box.querySelector(".sbox-list");
  const clear = box.querySelector(".sbox-clear");
  comboboxes[boxId] = { options, getVal };
  const render = () => {
    const kw = input.value.trim().toLowerCase();
    const opts = options.filter((o) => !kw || o.label.toLowerCase().includes(kw));
    list.innerHTML = opts.slice(0, 60).map((o) =>
      `<button class="sbox-item" data-v="${esc(String(o.value))}">${esc(o.label)}</button>`).join("")
      || '<div class="empty">无匹配</div>';
    list.querySelectorAll(".sbox-item").forEach((b) =>
      b.addEventListener("click", () => {
        onPick(b.dataset.v, b.textContent);
        if (!clearable) input.value = "";
        syncCombobox(boxId);
        list.classList.add("hidden");
      }));
  };
  input.addEventListener("focus", () => { render(); list.classList.remove("hidden"); });
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
  if (clear) clear.addEventListener("click", () => { onPick("", ""); syncCombobox(boxId); });
  syncCombobox(boxId);
}

async function initFilterControls() {
  const series = await api("/api/series");
  const seriesOpts = series.map((s) => ({ value: s.id, label: s.name }));
  const [unitTags, charTags, supTags, skillNames] = await Promise.all([
    api("/api/tags?kind=unit"),
    api("/api/tags?kind=character"),
    api("/api/tags?kind=supporter"),
    api("/api/skillnames"),
  ]);
  const tagOpts = (list) => list.map((t) => ({ value: t, label: t }));
  initCombobox("#unit-series-box", seriesOpts, () => state.units.series,
    (v) => { state.units.series = String(v); }, true);
  initCombobox("#char-series-box", seriesOpts, () => state.characters.series,
    (v) => { state.characters.series = String(v); }, true);
  initCombobox("#unit-tag-box", tagOpts(unitTags), () => "",
    (v) => { if (v) addTagChip("unit", v); }, false);
  initCombobox("#char-tag-box", tagOpts(charTags), () => "",
    (v) => { if (v) addTagChip("char", v); }, false);
  initCombobox("#sup-tag-box", tagOpts(supTags), () => "",
    (v) => { if (v) addTagChip("sup", v); }, false);
  initCombobox("#unit-wfx-box", WFX_OPTIONS, () => "",
    (v) => addWfxChip(v), false);
  initCombobox("#char-skill-box", tagOpts(skillNames), () => "",
    (v) => addSkillChip(v), false);
}

function wfxLabel(v) {
  const o = WFX_OPTIONS.find((x) => x.value === v);
  return o ? o.label : v;
}

function renderWfxChips() {
  const box = $("#unit-wfx-chips");
  if (!box) return;
  box.innerHTML = state.units.wfx.length
    ? state.units.wfx.map((v) =>
        `<span class="chip sel-tag">${esc(wfxLabel(v))}
          <button class="chip-x" data-wfx="${esc(v)}" title="移除">×</button>
        </span>`).join("")
    : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      state.units.wfx = state.units.wfx.filter((v) => v !== b.dataset.wfx);
      renderWfxChips();
    }));
}

function addWfxChip(v) {
  if (!v || state.units.wfx.includes(v)) return;
  state.units.wfx.push(v);
  renderWfxChips();
}

function renderSkillChips() {
  const box = $("#char-skill-chips");
  if (!box) return;
  box.innerHTML = state.characters.skills.length
    ? state.characters.skills.map((v) =>
        `<span class="chip sel-tag">${esc(v)}
          <button class="chip-x" data-skill="${esc(v)}" title="移除">×</button>
        </span>`).join("")
    : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      state.characters.skills = state.characters.skills.filter((v) => v !== b.dataset.skill);
      renderSkillChips();
    }));
}

function addSkillChip(v) {
  if (!v || state.characters.skills.includes(v)) return;
  state.characters.skills.push(v);
  renderSkillChips();
}

function renderTagChips(kind) {
  const box = $({
    unit: "#unit-tag-chips",
    char: "#char-tag-chips",
    sup: "#sup-tag-chips",
  }[kind]);
  if (!box) return;
  const tags = {
    unit: state.units.tags,
    char: state.characters.tags,
    sup: state.supporters.tags,
  }[kind];
  box.innerHTML = tags.length
    ? tags.map((t) =>
        `<span class="chip sel-tag">${esc(t)}
          <button class="chip-x" data-kind="${kind}" data-tag="${esc(t)}" title="移除">×</button>
        </span>`).join("")
    : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      const arr = {
        unit: state.units.tags,
        char: state.characters.tags,
        sup: state.supporters.tags,
      }[b.dataset.kind];
      const idx = arr.indexOf(b.dataset.tag);
      if (idx >= 0) arr.splice(idx, 1);
      renderTagChips(b.dataset.kind);
    }));
}

function addTagChip(kind, name) {
  const v = name;
  if (!v) return;
  const arr = {
    unit: state.units.tags,
    char: state.characters.tags,
    sup: state.supporters.tags,
  }[kind];
  if (!arr.includes(v)) arr.push(v);
  renderTagChips(kind);
}

async function loadUnits(page = state.units.page) {
  state.units.page = page;
  const s = state.units;
  const q = new URLSearchParams({
    q: s.q, rarity: s.rarity, acq: s.acq, series: s.series, type: s.type,
    tags: s.tags.join(","), tag_mode: s.tag_mode,
    match: s.match, wfx: s.wfx.join(","), wfx_mode: s.wfx_mode,
    sort: s.sort, order: s.order,
    limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/units?" + q);
  $("#unit-count").textContent = `共 ${d.total} 条结果`;
  $("#unit-list").innerHTML = d.items.length
    ? d.items.map((u) => `
      <div class="list-row units" data-id="${u.id}">
        <span class="name">${esc(u.name)}</span>
        ${cell(rarityBadge(u.rarity))}
        ${cell(roleBadge(u.role, u.role_label))}
        <span class="num">${u.atk_f}</span><span class="num">${u.def_f}</span>
        <span class="num">${u.mob_f}</span><span class="num">${u.hp_f}</span>
        <span class="num">${u.en_f}</span><span class="num">${u.mov}</span>
      </div>`).join("")
    : '<div class="empty">没有匹配的机体（当前已抓取详情有限）</div>';
  $("#unit-list").querySelectorAll(".list-row").forEach((r) =>
    r.addEventListener("click", () => openUnit(r.dataset.id)));
  pager("unit", d.total, s.page, s.size, loadUnits);
  updateSortArrows("units");
  applyColWidths("units");
}

async function openUnit(id) {
  const u = await api(`/api/units/${id}`);
  const weapons = u.weapons.map((w) => `
    <tr>
      <td>${esc(w.name)} ${lvBadge(w.weapon_max_level)}</td>
      <td>${esc(w.weapon_attr_label ?? "—")}</td>
      <td>${esc(w.pilot_stat ?? "—")}</td>
      <td class="mono">${w.map_weapon_range
        ? `MAP（${w.range_min ?? "—"}~${w.range_max ?? "—"}）`
        : `${w.range_min ?? "—"}~${w.range_max ?? "—"}`}</td>
      <td class="mono">${w.power_lv5 ?? w.power}</td>
      <td class="mono">${w.en_lv5 ?? w.en}</td>
      <td class="mono">${w.hit_lv5 ?? w.hit_rate ?? "—"}%</td>
      <td class="mono">${w.crit_lv5 ?? w.critical_rate ?? "—"}%</td>
      <td>${weaponEffects(w)}</td>
    </tr>`).join("");
  const abilities = u.abilities.map((a) => `
    <tr>
      <td><button class="link-name" data-type="ability" data-name="${esc(a.name)}">${esc(a.name)}</button></td>
      <td class="desc">${effectHtml(a.effects, a.desc)}</td>
    </tr>`).join("");
  const t = u.terrain || {};
  const terrain = Object.entries({ 宇宙: t.space, 大气圈: t.atmospheric, 地面: t.ground, 水面: t.surface, 水中: t.underwater })
    .map(([k, v]) => `<span class="chip">${k} ${v ?? "—"}</span>`).join("");
  showModal(u.name,
    `<p class="desc">${roleBadge(u.role, u.role_label)} ${esc(u.desc || "暂无描述")}</p>
     <div id="unit-stats"></div>
     <h3>地形适性</h3><div class="tags">${terrain}</div>
     ${u.tags.length ? `<h3>标签（点击可搜索）</h3><div class="tags">${u.tags.map((t) => tagChip(t)).join("")}</div>` : ""}
     <h3>武器（${u.weapons.length}）</h3>
     <table><tr><th>名称</th><th>伤害类型</th><th>依赖属性</th><th>射程</th><th>威力(满级)</th><th>EN(满级)</th><th>命中(满级)</th><th>暴击(满级)</th><th>特效(满级)</th></tr>${weapons || '<tr><td colspan="9" class="empty">暂无武器数据</td></tr>'}</table>
     ${abilities ? `<h3>能力</h3><table><tr><th>名称</th><th>效果</th></tr>${abilities}</table>` : ""}`);
  renderUnitStats(u, 0, "default");
  bindTagChips();
  bindSearchLinks();
  bindEffectChips();
}

/* ---------- 驾驶员 ---------- */
async function loadCharacters(page = state.characters.page) {
  state.characters.page = page;
  const s = state.characters;
  const q = new URLSearchParams({
    q: s.q, rarity: s.rarity, series: s.series, type: s.type,
    tags: s.tags.join(","), tag_mode: s.tag_mode,
    match: s.match, skills: s.skills.join(","), skill_mode: s.skill_mode,
    sort: s.sort, order: s.order,
    limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/characters?" + q);
  $("#char-count").textContent = `共 ${d.total} 条结果`;
  $("#char-list").innerHTML = d.items.length
    ? d.items.map((c) => `
      <div class="list-row chars" data-id="${c.id}">
        <span class="name">${esc(c.name)}</span>
        ${cell(rarityBadge(c.rarity))}
        ${cell(roleBadge(c.role, c.role_label))}
        <span class="num">${c.ranged_f}</span><span class="num">${c.melee_f}</span>
        <span class="num">${c.defense_f}</span><span class="num">${c.awaken_f}</span>
        <span class="num">${c.reaction_f}</span>
      </div>`).join("")
    : '<div class="empty">没有匹配的驾驶员</div>';
  $("#char-list").querySelectorAll(".list-row").forEach((r) =>
    r.addEventListener("click", () => openCharacter(r.dataset.id)));
  pager("char", d.total, s.page, s.size, loadCharacters);
  updateSortArrows("characters");
  applyColWidths("chars");
}

async function openCharacter(id) {
  const c = await api(`/api/characters/${id}`);
  const skills = c.skills.map((sk) => `
    <tr><td><button class="link-name" data-type="skill" data-name="${esc(sk.name)}">${esc(sk.name)}</button></td>
      <td>${sk.sp ?? "—"}</td><td>${sk.duration ?? "—"}</td><td class="desc">${effectHtml(sk.effects, sk.desc)}</td></tr>`).join("");
  const abilities = c.abilities.map((a) => `
    <tr><td><button class="link-name" data-type="ability" data-name="${esc(a.name)}">${esc(a.name)}</button></td>
      <td class="desc">${effectHtml(a.effects, a.desc)}</td></tr>`).join("");
  showModal(c.name,
    `<p class="desc">${roleBadge(c.role, c.role_label)} ${esc(c.desc || "暂无描述")}</p>
     <div id="char-stats"></div>
     ${c.tags.length ? `<h3>标签（点击可搜索）</h3><div class="tags">${c.tags.map((t) => tagChip(t)).join("")}</div>` : ""}
     <h3>技能（${c.skills.length}）</h3>
     <table><tr><th>名称</th><th>SP</th><th>持续</th><th>效果</th></tr>${skills || '<tr><td colspan="4" class="empty">无</td></tr>'}</table>
     <h3>能力</h3>
     <table><tr><th>名称</th><th>效果</th></tr>${abilities || '<tr><td colspan="2" class="empty">无</td></tr>'}</table>`);
  renderCharStats(c, "default");
  bindTagChips();
  bindSearchLinks();
}

/* ---------- 支援角色 ---------- */
async function loadSupporters(page = state.supporters.page) {
  state.supporters.page = page;
  const s = state.supporters;
  const q = new URLSearchParams({
    q: s.q, tags: s.tags.join(","), tag_mode: s.tag_mode,
    sort: s.sort, order: s.order,
    limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/supporters?" + q);
  $("#sup-count").textContent = `共 ${d.total} 条结果`;
  const route = { 1: "扭蛋", 2: "活动", 3: "商店", 4: "其他" };
  $("#sup-list").innerHTML = d.items.length
    ? d.items.map((x) => `
      <div class="list-row sups" data-id="${x.id}">
        <span class="name">${esc(x.name)}</span>
        ${cell(rarityBadge(x.rarity))}
        <span class="sup-tags-cell">${(x.condition_tags || []).map((c) =>
          `<span class="chip cond">${c.kind === "series" ? "系列 · " : "标签 · "}${esc(c.name)}</span>`).join("") || "—"}</span>
        <span class="num">+${x.max_hp_addition_value}</span>
        <span class="num">+${x.max_attack_addition_value}</span>
        <span>${route[x.acquisition_route] ?? x.acquisition_route}</span>
      </div>`).join("")
    : '<div class="empty">暂无支援角色</div>';
  $("#sup-list").querySelectorAll(".list-row").forEach((r) =>
    r.addEventListener("click", () => openSupporter(r.dataset.id)));
  pager("sup", d.total, s.page, s.size, loadSupporters);
  applyColWidths("sups");
  updateSortArrows("supporters");
}

async function openSupporter(id) {
  const s = await api(`/api/supporters/${id}`);
  currentSupporter = s;
  const rows = s.skills.map((sk) => `
    <tr><td>${esc(sk.limit_break_step)}</td><td>${sk.skill_type === "leader" ? "队长技" : "主动技"}</td>
      <td>${esc(sk.name || "—")}</td>
      <td class="desc">${esc(sk.desc || "—")}${condChips(sk.conditions)}</td></tr>`).join("");
  showModal(s.name,
    `<p class="desc">${esc(s.obtained_word || s.desc || "暂无描述")}</p>
     ${s.condition_tags && s.condition_tags.length ? `<h3 class="cond-head">词条对象（点击直接在机体中搜索）<button id="sup-all-targets" class="cond-btn" title="显示该支援角色所有可加成机体（系列与标签的并集）">显示所有影响对象</button></h3><div class="tags">${s.condition_tags.map((c) =>
       `<button class="chip sup-cond" data-kind="${c.kind}" data-id="${c.id ?? ""}" data-name="${esc(c.name)}">${c.kind === "series" ? "系列 · " : "标签 · "}${esc(c.name)}</button>`).join("")}</div>` : ""}
     <h3>加成</h3>
     <table><tr><th>最大 HP 加成</th><th>最大攻击加成</th><th>稀有度</th></tr>
       <tr><td class="mono">+${s.max_hp_addition_value}</td><td class="mono">+${s.max_attack_addition_value}</td>
         <td>${rarityBadge(s.rarity)}</td></tr></table>
     <h3>技能（按突破阶段）</h3>
     <table><tr><th>突破</th><th>类型</th><th>名称</th><th>效果 / 词条对象</th></tr>${rows}</table>`);
  bindSupporterConds();
}

/* ---------- 技能 / 能力 / 武装效果 查询 ---------- */
function searchEffects(it, type) {
  if (type === "weapon") return weaponEffects(it);
  return effectHtml(it.effects, it.detail_desc);
}

async function loadSearch(page = state.search.page) {
  state.search.page = page;
  const s = state.search;
  const q = new URLSearchParams({
    type: s.type, kind: s.kind, q: s.q, limit: s.size, offset: s.page * s.size,
    sort: s.sort, order: s.order,
  });
  const d = await api("/api/search?" + q);
  $("#sr-count").textContent = s.q.trim()
    ? `共 ${d.total} 条结果`
    : `共 ${d.total} 条结果（未输入关键词，显示全部）`;
  $("#sr-result").innerHTML = d.items.length
    ? d.items.map((it) => `
      <div class="list-row sr" data-owner="${it.owner_type}" data-id="${it.owner_id}">
        <span class="sr-name">${esc(it.name)}</span>
        <span>${esc(it.owner_name)} ${rarityBadge(it.owner_rarity)}</span>
        <span>${roleBadge(it.role, it.role_label)} <span class="muted">${esc(it.series_name ?? "")}</span></span>
        <span class="sr-effect">${searchEffects(it, s.type)}</span>
      </div>`).join("")
    : '<div class="empty">没有匹配结果</div>';
  $("#sr-result").querySelectorAll(".list-row.sr").forEach((r) =>
    r.addEventListener("click", () => {
      const id = Number(r.dataset.id);
      if (r.dataset.owner === "unit") openUnit(id);
      else openCharacter(id);
    }));
  pager("sr", d.total, s.page, s.size, loadSearch);
  applyColWidths("sr");
  updateSortArrows("search");
}

$("#sr-search").addEventListener("click", () => {
  state.search.type = $("#sr-type").value;
  state.search.kind = $("#sr-kind").value;
  state.search.q = $("#sr-q").value;
  loadSearch(0);
});
$("#sr-q").addEventListener("keydown", (e) => e.key === "Enter" && $("#sr-search").click());
$("#sr-type").addEventListener("change", () => {
  const weapon = $("#sr-type").value === "weapon";
  $("#sr-kind").disabled = weapon;
  if (weapon) $("#sr-kind").value = "unit";
});

/* ---------- 星级与属性加成 ---------- */
const STAT_NAMES = {
  unit: { hp: "HP", en: "EN", attack: "攻击", defense: "防御", mobility: "机动" },
  character: { ranged: "射击", melee: "格斗", defense: "防御", reaction: "反应", awaken: "觉醒" },
};

function statCell(d, level) {
  const v = level === "max" ? d.max : d.lv1;
  const b = level === "max" ? d.max_bonus : d.lv1_bonus;
  return `<span class="stat-val">${v}</span> <span class="add">+${b}</span>`;
}

function condPanel(obj, current, kind) {
  const rows = (obj.conditional_bonuses || []).map((c) => {
    const cs = kind === "character"
      ? c.values[current]
      : c.forms[current.form][current.star];
    if (!cs) return "";
    return `<tr>
      <td class="desc">${esc(c.condition || "—")}</td>
      <td>${STAT_NAMES[kind][c.stat] ?? c.stat}</td>
      <td class="mono">+${c.pct}%</td>
      <td class="mono">${cs.lv1}</td>
      <td class="mono">${cs.max}</td>
      <td class="desc">${esc(c.name || "")}</td>
    </tr>`;
  }).join("");
  if (!rows) return "";
  const title = kind === "character"
    ? (current === "sp" ? "SP" : "默认")
    : `${current.form === "default" ? "默认" : current.form.toUpperCase()} · ${current.star}★`;
  return `<div id="cond-panel" class="cond-panel hidden">
    <h4>达成条件后的数值（${title}）</h4>
    <p class="hint">以下数值 = 当前形态基础值 ×（1 + 无条件加成% + 该条件加成%），即该条件达成后的 1级 / 满级 属性。</p>
    <table><tr><th>条件</th><th>属性</th><th>加成</th><th>1级</th><th>满级</th><th>来源能力</th></tr>
    ${rows}</table>
  </div>`;
}

function renderUnitStats(u, star, formKey) {
  if (!u.can_star) star = 0;
  const form = u.forms[formKey] || u.forms.default;
  const s = form.stars[star];
  const st = s.stats;
  const cellM = (key) => statCell(st[key], "max");
  const movM = form.movement[1] ?? u.max_movement;
  const formBtns = (u.can_star && u.has_sp)
    ? `<span class="star-label">形态</span>` + [
        ["default", `默认(${u.level_cap}级)`],
        ["sp", "SP(100级)"],
        ...(u.has_ssp ? [["ssp", "SSP"]] : []),
      ].map(([fk, label]) =>
        `<button class="form-btn ${formKey === fk ? "active" : ""}" data-form="${fk}">${label}</button>`).join("")
    : "";
  const starBtns = u.can_star
    ? `<span class="star-label">星级</span>` + form.stars.map((x) =>
        `<button class="star-btn ${x.star === star ? "active" : ""}" data-star="${x.star}">${x.star}★ ${x.label}</button>`).join("")
    : "";
  const ultNote = !u.can_star
    ? `<span class="chip ult-tag">终极标签 · 暂不能升星 / SP，仅显示 0 星数据</span>`
    : "";
  const sspNote = (formKey === "ssp" && form.fallback)
    ? '<p class="hint">SSP 数据暂未收录，暂以 SP 数值显示（后续数据更新后自动生效）。</p>'
    : "";
  const hint = u.can_star
    ? `绿色 +N 为无条件能力加成；${formKey === "default" ? `默认形态满级 ${form.level_cap}（稀有度上限）` : `${formKey.toUpperCase()} 形态满级 ${form.level_cap}`}，升星倍率 ${form.stars.map((x) => `${x.star}★=${x.label}`).join(" / ")}（HP、EN、攻击、防御、机动）。`
    : "绿色 +N 为无条件能力加成；终极标签机体暂不能升星 / SP，仅统计 0 星数据。";
  $("#unit-stats").innerHTML = `
    <h3>机体属性（满级）</h3>
    <div class="star-bar">
      ${formBtns}
      ${starBtns}
      <span class="cap-chip">满级上限 ${form.level_cap}</span>
      ${ultNote}
      <button class="cond-btn" id="cond-toggle">查看条件加成</button>
    </div>
    <table>
      <tr><th></th><th>HP</th><th>EN</th><th>攻击</th><th>防御</th><th>机动</th><th>移动</th></tr>
      <tr><th>满级</th><td>${cellM("hp")}</td><td>${cellM("en")}</td><td>${cellM("attack")}</td>
        <td>${cellM("defense")}</td><td>${cellM("mobility")}</td><td class="mono">${movM}</td></tr>
    </table>
    <p class="hint">${hint}</p>
    ${sspNote}
    ${condPanel(u, { form: formKey, star }, "unit")}`;
  bindUnitControls(u, formKey, star);
}

function renderCharStats(c, formKey) {
  const form = c.forms[formKey];
  const st = form.stats;
  const cellM = (key) => statCell(st[key], "max");
  $("#char-stats").innerHTML = `
    <h3>属性（满级）</h3>
    <div class="star-bar">
      <span class="star-label">形态：${formKey === "sp" ? "SP" : "默认"}</span>
      <span class="cap-chip">满级上限 ${form.level_cap}</span>
      ${c.has_sp ? `<button id="sp-toggle" class="cond-btn ${formKey === "sp" ? "active" : ""}">SP 解锁满级 100</button>` : ""}
      <button class="cond-btn" id="cond-toggle">查看条件加成</button>
    </div>
    <table>
      <tr><th></th><th>射击</th><th>格斗</th><th>防御</th><th>觉醒</th><th>反应</th></tr>
      <tr><th>满级</th><td>${cellM("ranged")}</td><td>${cellM("melee")}</td><td>${cellM("defense")}</td>
        <td>${cellM("awaken")}</td><td>${cellM("reaction")}</td></tr>
    </table>
    <p class="hint">绿色 +N 为无条件能力加成；驾驶员没有星级。SP 前满级 ${c.level_cap}（稀有度上限），SP 后满级 100。</p>
    ${condPanel(c, formKey, "character")}`;
  bindCharControls(c, formKey);
}

function bindUnitControls(u, formKey, star) {
  $("#unit-stats").querySelectorAll(".form-btn").forEach((b) =>
    b.addEventListener("click", () => renderUnitStats(u, star, b.dataset.form)));
  $("#unit-stats").querySelectorAll(".star-btn").forEach((b) =>
    b.addEventListener("click", () => renderUnitStats(u, Number(b.dataset.star), formKey)));
  const toggle = $("#cond-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const panel = $("#cond-panel");
    if (!panel) return;
    const hidden = panel.classList.toggle("hidden");
    toggle.textContent = hidden ? "查看条件加成" : "收起条件加成";
  });
}

function bindCharControls(c, formKey) {
  const sp = $("#sp-toggle");
  if (sp) sp.addEventListener("click", () => renderCharStats(c, formKey === "sp" ? "default" : "sp"));
  const toggle = $("#cond-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const panel = $("#cond-panel");
    if (!panel) return;
    const hidden = panel.classList.toggle("hidden");
    toggle.textContent = hidden ? "查看条件加成" : "收起条件加成";
  });
}

/* ---------- 关卡敌人 ---------- */
async function loadStages(page = state.stages.page) {
  state.stages.page = page;
  const s = state.stages;
  const d = await api(`/api/stages?q=${encodeURIComponent(s.q)}&limit=${s.size}&offset=${s.page * s.size}`);
  $("#stage-count").textContent = `共 ${d.total} 条结果`;
  $("#stage-list").innerHTML = d.items.length
    ? d.items.map((st) => `
      <div class="list-row stages" data-id="${st.id}">
        <span class="name">${st.id}</span>
        <span>${esc(st.name || "—")}</span>
        <span class="num">${st.stage_type}</span>
        <span class="num">${st.cp}</span><span class="num">${st.ap}</span>
        <span class="num">${st.enemy_count}</span>
      </div>`).join("")
    : '<div class="empty">暂无关卡数据（关卡详情仍在增量抓取）</div>';
  $("#stage-list").querySelectorAll(".list-row").forEach((r) =>
    r.addEventListener("click", () => openStage(r.dataset.id)));
  pager("stage", d.total, s.page, s.size, loadStages);
  applyColWidths("stages");
}

async function openStage(id) {
  const st = await api(`/api/stages/${id}`);
  const side = { 0: "我方", 1: "敌方", 2: "中立" };
  const npcs = st.npcs.map((n) => `
    <tr><td>${side[n.battle_side] ?? n.battle_side}</td>
      <td>${esc(n.unit_name || n.unit_id)}</td>
      <td class="mono">${n.level}</td><td class="mono">${n.hp}</td>
      <td class="mono">${n.en}</td><td class="mono">${n.attack}</td>
      <td class="mono">${n.defense}</td><td class="mono">${n.mobility}</td>
      <td class="mono">${n.movement}</td></tr>`).join("");
  const pilots = st.npc_characters.map((p) => `
    <tr><td>${esc(p.character_name || p.character_id)}</td>
      <td class="mono">${p.level}</td><td class="mono">${p.mp}</td>
      <td class="mono">${p.ranged}</td><td class="mono">${p.melee}</td>
      <td class="mono">${p.defense}</td><td class="mono">${p.reaction}</td>
      <td class="mono">${p.awaken}</td><td class="mono">${p.generalship}</td></tr>`).join("");
  showModal(`关卡 ${st.id}`,
    `<p class="desc">${esc(st.name || "未命名关卡")} · CP ${st.cp} · AP ${st.ap}</p>
     <h3>敌方机体（${st.npcs.length}）</h3>
     <table><tr><th>阵营</th><th>机体</th><th>等级</th><th>HP</th><th>EN</th><th>攻击</th><th>防御</th><th>机动</th><th>移动</th></tr>
       ${npcs || '<tr><td colspan="9" class="empty">无</td></tr>'}</table>
     <h3>敌方驾驶员（${st.npc_characters.length}）</h3>
     <table><tr><th>角色</th><th>等级</th><th>MP</th><th>射击</th><th>格斗</th><th>防御</th><th>反应</th><th>觉醒</th><th>统率</th></tr>
       ${pilots || '<tr><td colspan="9" class="empty">无</td></tr>'}</table>`);
}

/* ---------- 伤害计算 ---------- */
$("#d-calc").addEventListener("click", async () => {
  const q = new URLSearchParams({
    aua: $("#d-aua").value, aca: $("#d-aca").value,
    dud: $("#d-dud").value, dcd: $("#d-dcd").value,
    wp: $("#d-wp").value, terrain: $("#d-terrain").value,
    vigor: $("#d-vigor").value,
    buff: $("#d-buff").value, debuff: $("#d-debuff").value,
    critical: $("#d-crit").checked ? "1" : "0",
    shield: $("#d-shield").checked ? "1" : "0",
  });
  const d = await api("/api/damage?" + q);
  const names = {
    character_stat_ratio: "角色属性差比", unit_stat_ratio: "机体属性差比",
    character_sigmoid: "角色 sigmoid 修正", unit_sigmoid: "机体 sigmoid 修正",
    base_damage: "基础伤害", attacker_combined_stat: "攻击方综合值",
    target_combined_stat: "防御方综合值", damage_correction: "攻防修正",
    battle_damage: "战斗伤害（地形修正后）",
    total_damage_multiplier_percent: "总增伤倍率 %",
    scaled_damage: "倍率加成伤害", combined_damage: "合并伤害（护盾）",
    critical_correction_percent: "暴击修正 %", final_damage: "最终伤害",
  };
  $("#d-result").innerHTML =
    d.steps.map(([k, v]) => `
      <div class="step-row ${k === "final_damage" ? "final" : ""}">
        <span class="lbl">${names[k] ?? k}</span>
        <span class="val">${typeof v === "number" ? Math.round(v * 1000) / 1000 : v}</span>
      </div>`).join("");
});

/* ---------- 工具栏事件 ---------- */
$("#unit-search").addEventListener("click", () => {
  state.units.q = $("#unit-q").value;
  state.units.rarity = $("#unit-rarity").value;
  state.units.acq = $("#unit-acq").value;
  state.units.type = $("#unit-type").value;
  state.units.tag_mode = $("#unit-tag-mode").value;
  state.units.match = $("#unit-match").value;
  state.units.wfx_mode = $("#unit-wfx-mode").value;
  loadUnits(0);
});
$("#unit-q").addEventListener("keydown", (e) => e.key === "Enter" && $("#unit-search").click());
$("#char-search").addEventListener("click", () => {
  state.characters.q = $("#char-q").value;
  state.characters.rarity = $("#char-rarity").value;
  state.characters.type = $("#char-type").value;
  state.characters.tag_mode = $("#char-tag-mode").value;
  state.characters.skill_mode = $("#char-skill-mode").value;
  state.characters.match = $("#char-match").value;
  loadCharacters(0);
});
$("#char-q").addEventListener("keydown", (e) => e.key === "Enter" && $("#char-search").click());

function updateSortArrows(kind) {
  const s = {
    units: state.units,
    characters: state.characters,
    supporters: state.supporters,
    search: state.search,
  }[kind];
  if (!s) return;
  document.querySelectorAll(`.sort-th[data-kind="${kind}"]`).forEach((b) => {
    b.textContent = b.textContent.replace(/ [▲▼]$/, "");
    if (b.dataset.sort === s.sort) b.textContent += s.order === "asc" ? " ▲" : " ▼";
  });
}

document.querySelectorAll(".sort-th").forEach((b) =>
  b.addEventListener("click", () => {
    const kind = b.dataset.kind;
    const s = {
      units: state.units,
      characters: state.characters,
      supporters: state.supporters,
      search: state.search,
    }[kind];
    if (!s) return;
    if (s.sort === b.dataset.sort) {
      s.order = s.order === "asc" ? "desc" : "asc";
    } else {
      s.sort = b.dataset.sort;
      s.order = "desc";
    }
    s.page = 0;
    const loaders = {
      units: loadUnits,
      characters: loadCharacters,
      supporters: loadSupporters,
      search: loadSearch,
    };
    loaders[kind](0);
  }));

$("#sup-search").addEventListener("click", () => {
  state.supporters.q = $("#sup-q").value;
  state.supporters.tag_mode = $("#sup-tag-mode").value;
  loadSupporters(0);
});
$("#sup-q").addEventListener("keydown", (e) => e.key === "Enter" && $("#sup-search").click());
$("#stage-search").addEventListener("click", () => {
  state.stages.q = $("#stage-q").value;
  loadStages(0);
});
$("#stage-q").addEventListener("keydown", (e) => e.key === "Enter" && $("#stage-search").click());

/* ---------- 重置 ---------- */
function resetUnits() {
  Object.assign(state.units, {
    q: "", rarity: "", acq: "", series: "", type: "", tags: [], tag_mode: "all", match: "and",
    wfx: [], wfx_mode: "any",
    sort: "rarity", order: "desc", page: 0,
  });
  $("#unit-q").value = "";
  $("#unit-rarity").value = "";
  $("#unit-acq").value = "";
  $("#unit-type").value = "";
  $("#unit-tag-mode").value = "all";
  $("#unit-match").value = "and";
  $("#unit-wfx-mode").value = "any";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  loadUnits(0);
}
function resetCharacters() {
  Object.assign(state.characters, {
    q: "", rarity: "", series: "", type: "", tags: [], tag_mode: "all", match: "and",
    skills: [], skill_mode: "any",
    sort: "rarity", order: "desc", page: 0,
  });
  $("#char-q").value = "";
  $("#char-rarity").value = "";
  $("#char-type").value = "";
  $("#char-tag-mode").value = "all";
  $("#char-skill-mode").value = "any";
  $("#char-match").value = "and";
  syncCombobox("#char-series-box");
  renderTagChips("char");
  renderSkillChips();
  loadCharacters(0);
}
function resetSupporters() {
  Object.assign(state.supporters, {
    q: "", tags: [], tag_mode: "any", sort: "rarity", order: "desc", page: 0,
  });
  $("#sup-q").value = "";
  $("#sup-tag-mode").value = "any";
  renderTagChips("sup");
  loadSupporters(0);
  updateSortArrows("supporters");
}
function resetStages() {
  Object.assign(state.stages, { q: "", page: 0 });
  $("#stage-q").value = "";
  loadStages(0);
}
function resetSearch() {
  Object.assign(state.search, {
    type: "skill", kind: "all", q: "", sort: "rarity", order: "desc", page: 0,
  });
  $("#sr-type").value = "skill";
  $("#sr-kind").value = "all";
  $("#sr-q").value = "";
  $("#sr-kind").disabled = false;
  loadSearch(0);
  updateSortArrows("search");
}
$("#unit-reset").addEventListener("click", resetUnits);
$("#char-reset").addEventListener("click", resetCharacters);
$("#sup-reset").addEventListener("click", resetSupporters);
$("#stage-reset").addEventListener("click", resetStages);
$("#sr-reset").addEventListener("click", resetSearch);

/* ---------- 弹窗 ---------- */
function showModal(title, body) {
  $("#modal-title").innerHTML = title;
  $("#modal-body").innerHTML = body;
  $("#modal").classList.remove("hidden");
}
$("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) $("#modal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal").classList.add("hidden");
});

/* ---------- 配对 ---------- */
let pairSelectedUnit = null;
let pairSelectedChar = null;

function setPairMode(mode) {
  $("#pair-mode-unit").classList.toggle("active", mode === "unit");
  $("#pair-mode-char").classList.toggle("active", mode === "char");
  $("#pair-unit-form").classList.toggle("hidden", mode !== "unit");
  $("#pair-char-form").classList.toggle("hidden", mode !== "char");
  $("#pair-result").innerHTML = "";
}
$("#pair-mode-unit").addEventListener("click", () => setPairMode("unit"));
$("#pair-mode-char").addEventListener("click", () => setPairMode("char"));

async function pairSearch(what) {
  const q = what === "unit" ? $("#pair-unit-q").value.trim() : $("#pair-char-q").value.trim();
  const box = what === "unit" ? "#pair-unit-options" : "#pair-char-options";
  if (!q) { $(box).innerHTML = ""; return; }
  const path = what === "unit" ? "units" : "characters";
  const d = await api(`/api/${path}?q=${encodeURIComponent(q)}&limit=15`);
  $(box).innerHTML = d.items.length
    ? d.items.map((x) => `
      <button class="option" data-id="${x.id}">
        ${esc(x.name)}（${({ 5: "UR", 4: "SSR", 3: "SR", 2: "R", 1: "N" })[x.rarity] ?? x.rarity}）
      </button>`).join("")
    : '<div class="empty">无结果</div>';
  $(box).querySelectorAll(".option").forEach((b) =>
    b.addEventListener("click", () => {
      if (what === "unit") {
        pairSelectedUnit = { id: Number(b.dataset.id) };
        loadPairingUnit(pairSelectedUnit.id);
      } else {
        pairSelectedChar = { id: Number(b.dataset.id) };
        loadPairingChar(pairSelectedChar.id);
      }
    }));
}
$("#pair-unit-search").addEventListener("click", () => pairSearch("unit"));
$("#pair-unit-q").addEventListener("keydown", (e) => e.key === "Enter" && pairSearch("unit"));
$("#pair-char-search").addEventListener("click", () => pairSearch("char"));
$("#pair-char-q").addEventListener("keydown", (e) => e.key === "Enter" && pairSearch("char"));

function pairChips(matched) {
  if (!matched.length) return '<span>无适用加成</span>';
  return matched.map((m) =>
    `<span>${m.kind === "主动" ? "主动" : "被动"} · ${esc(m.skill_name || m.name || "")} · ${esc(m.desc || "")}</span>`
  ).join("");
}

function scoreBar(v, max) {
  const pct = Math.min(100, Math.round((v / max) * 100));
  return `<div class="score-bar"><i style="width:${pct}%"></i></div>`;
}

async function loadPairingUnit(id) {
  const d = await api(`/api/pairing/units/${id}`);
  if (d.error) {
    $("#pair-result").innerHTML = `<div class="empty">${esc(d.error)}</div>`;
    return;
  }
  const pilots = d.pilots.map((p) => `
    <div class="pair-card">
      <div class="head"><span class="name">${esc(p.name)}</span>${rarityBadge(p.rarity)}</div>
      <div class="score-line">
        <span>总评 <b>${p.total_score}</b></span>
        <span>属性 ${p.stat_score}/30</span><span>加成 ${p.bonus_score}/50</span>
        ${scoreBar(p.stat_score + p.bonus_score, 80)}
      </div>
      <div class="chips">${p.series_match ? "<span>同系列</span>" : ""}${pairChips(p.matched)}</div>
    </div>`).join("");
  const sups = d.supporters.map((s) => `
    <div class="pair-card">
      <div class="head"><span class="name">${esc(s.name)}</span>${rarityBadge(s.rarity)}</div>
      <div class="score-line">
        <span>支援评分 ${s.score}/20</span>
        <span>队长技加成 ${s.bonus}%（突破 ${s.lb ?? "?"}）</span>
      </div>
      <div class="chips"><span>${esc(s.desc)}</span></div>
    </div>`).join("");
  $("#pair-result").innerHTML = `
    <h3>${esc(d.unit.name)} 推荐驾驶员（Top ${d.pilots.length}）</h3>
    ${pilots}
    <div class="pair-section"><h3>推荐支援角色</h3>${sups || '<div class="empty">无</div>'}</div>`;
}

async function loadPairingChar(id) {
  const d = await api(`/api/pairing/characters/${id}`);
  if (d.error) {
    $("#pair-result").innerHTML = `<div class="empty">${esc(d.error)}</div>`;
    return;
  }
  const units = d.units.map((u) => `
    <div class="pair-card">
      <div class="head"><span class="name">${esc(u.unit_name)}</span>${rarityBadge(u.unit_rarity)}</div>
      <div class="score-line">
        <span>总评 <b>${u.total_score}</b></span>
        <span>属性 ${u.stat_score}/30</span><span>加成 ${u.bonus_score}/50</span><span>支援 ${u.supporter_score}/20</span>
        ${scoreBar(u.total_score, 100)}
      </div>
      <div class="chips">${u.series_match ? "<span>同系列</span>" : ""}${pairChips(u.matched)}</div>
    </div>`).join("");
  $("#pair-result").innerHTML = `
    <h3>${esc(d.pilot.name)} 推荐机体（Top ${d.units.length}）</h3>
    ${units}`;
}

/* ---------- 启动 ---------- */
initFilterControls();
initColumnResize();
loadSummary();
