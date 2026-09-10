const $ = (sel) => document.querySelector(sel);
/* P1-9: 数字千分位格式化（整数 / 小数 / null 安全） */
const fmtNum = (n, digits) => {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return n;
  const d = digits !== undefined ? digits : 0;
  try { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(Number(n)); }
  catch (_) { return String(n); }
};
const state = {
  units: { q: "", rarity: "", acq: "", series: "", type: "", tags: [], tag_mode: "all", match: "and", wfx: [], wfx_mode: "any", cond: null, sort: "rarity", order: "desc", page: 0, size: 25 },
  characters: { q: "", rarity: "", series: "", type: "", tags: [], tag_mode: "all", match: "and", skills: [], skill_mode: "any", support: "", sort: "rarity", order: "desc", page: 0, size: 25 },
  supporters: { q: "", tags: [], tag_mode: "any", skills: [], skill_mode: "any", sort: "rarity", order: "desc", page: 0, size: 25 },
  stages: { q: "", page: 0, size: 25 },
  search: { type: "skill", kind: "all", q: "", sort: "rarity", order: "desc", page: 0, size: 25 },
};
let currentSupporter = null;
const colWidths = {};
const colFlex = {};

/* ---- Step 2: HUD 状态条：时钟 + 数据量实时刷新 ---- */
(function initHudStatus() {
  const pad = (n) => String(n).padStart(2, "0");
  const timeEl = document.getElementById("hudTime");
  function tick() {
    if (!timeEl) return;
    const now = new Date();
    timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  tick();
  setInterval(tick, 1000);
})();
function updateHudDbStat(c) {
  const el = document.getElementById("hudDbStat");
  if (!el || !c) return;
  const parts = [];
  if (c.unit)                   parts.push(`${fmtNum(c.unit)} 机体`);
  if (c.character)              parts.push(`${fmtNum(c.character)} 驾驶`);
  if (c.supporter)              parts.push(`${fmtNum(c.supporter)} 支援`);
  if (c.stage)                  parts.push(`${fmtNum(c.stage)} 关卡`);
  if (c.unit_weapon)            parts.push(`${fmtNum(c.unit_weapon)} 武装`);
  el.textContent = parts.length ? parts.join(" · ") : "数据未加载";
}
const ATTACK_ATTR_KEYS = {
  1: ["ranged"], 2: ["melee"], 3: ["awaken"],
  4: ["melee", "ranged"], 5: ["ranged", "awaken"], 6: ["melee", "awaken"],
  7: ["ranged", "melee", "awaken"],
};

function pilotDepValue(pilot, attackAttr) {
  if (!pilot) return null;
  const keys = ATTACK_ATTR_KEYS[attackAttr] || [];
  const vals = keys.map((k) => pilot[k]).filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}

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

function effectHtml(effects, fallback, condEntities) {
  const list = (effects || []).filter(Boolean);
  const ents = (condEntities || []).slice().sort((a, b) => b.name.length - a.name.length);
  if (!list.length) return esc(fallback || "—");
  const body = list.map((e) => {
    let html = esc(e);
    ents.forEach((ent) => {
      const escName = esc(ent.name);
      const chip = `<button class="chip entity-chip" data-kind="${ent.kind}" data-id="${ent.id ?? ""}" data-name="${esc(ent.name)}" title="点击查询">${esc(ent.name)}</button>`;
      html = html.split(escName).join(chip);
    });
    return `<div class="effect">${html}</div>`;
  }).join("");
  const combos = (condEntities || []).filter((x) => x.kind === "combo");
  const comboHtml = combos.length ? `<div class="tags">${combos.map((c) =>
    `<button class="chip combo-chip" data-series="${esc((c.series || []).join(","))}" data-tags="${esc((c.tags || []).join(","))}" data-mode="${c.mode === "or" ? "or" : "and"}" title="${c.mode === "or" ? "并集（任一满足）" : "交集（全部满足）"}">词条对象${c.mode === "or" ? "（并集）" : "（交集）"}</button>`).join("")}</div>` : "";
  return body + comboHtml;
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

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
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

/* ============================================================
   Step 4-7 辅助函数：迷你属性条 / 雷达图 / Staggered Reveal / 分段分数条
   ============================================================ */

/* 各属性的最大参考值（用于迷你属性条宽度，HUD 配色） */
const STAT_MAX = {
  hp: 95000, en: 600, attack: 16000, defense: 13000, mobility: 13000, movement: 8,
  ranged: 16000, melee: 16000, awaken: 16000, reaction: 16000,
};
const STAT_COLOR = {
  hp: "hud-green", en: "hud-blue", attack: "hud-red", defense: "hud-amber", mobility: "hud-violet", movement: "hud-blue",
  ranged: "hud-red", melee: "hud-amber", awaken: "hud-violet", reaction: "hud-blue",
};

/* 迷你属性条单元格：数值 + 细 bar（width 按参考最大值比例） */
function statCellBar(value, key) {
  const v = Number(value) || 0;
  const max = STAT_MAX[key] || 1;
  const pct = Math.max(2, Math.min(100, (v / max) * 100));
  const color = STAT_COLOR[key] || "hud-red";
  return `<span class="stat-cell">
    <span class="stat-num">${fmtNum(v)}</span>
    <span class="mini-bar" aria-hidden="true"><i class="${color}" style="width:${pct}%"></i></span>
  </span>`;
}

/* Staggered Reveal：为列表行添加错峰淡入动画 */
function applyStagger(rootSel) {
  const root = typeof rootSel === "string" ? document.querySelector(rootSel) : rootSel;
  if (!root) return;
  const rows = root.querySelectorAll(".list-row");
  rows.forEach((r, i) => {
    r.classList.remove("stagger-in");
    void r.offsetWidth; // 强制重排以重启动画
    r.style.animationDelay = `${Math.min(i * 22, 360)}ms`;
    r.classList.add("stagger-in");
  });
}

/* 分段分数条（10 格）：score 最大参考值默认 100 */
function segScoreBar(score, max = 100, showGrade = true) {
  const v = Number(score) || 0;
  const pct = Math.max(0, Math.min(100, (v / max) * 100));
  const filled = Math.round(pct / 10);
  const tier =
    pct >= 85 ? "s" : pct >= 70 ? "a" : pct >= 55 ? "b" : pct >= 40 ? "c" : "low";
  const gradeLabel = { s: "S", a: "A", b: "B", c: "C", low: "D" }[tier];
  const bars = Array.from({ length: 10 }, (_, i) =>
    `<span class="${i < filled ? "on" : ""}"></span>`).join("");
  return `<span class="seg-score-label">${fmtNum(v)}</span>
    <span class="seg-score-bar tier-${tier}">${bars}</span>
    ${showGrade ? `<span class="seg-score-grade ${tier}">${gradeLabel}</span>` : ""}`;
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
  (root || document).querySelectorAll(".cond-tag").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchTag(b.dataset.tag, "units");
    }));
  (root || document).querySelectorAll(".entity-chip").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const kind = b.dataset.kind;
      if (kind === "unit") searchUnitsByName(b.dataset.name);
      else if (kind === "series") searchUnitsBySeries(Number(b.dataset.id));
      else if (kind === "tag") searchTag(b.dataset.name, "units");
      else if (kind === "type") searchUnitsByType(b.dataset.id);
    }));
  (root || document).querySelectorAll(".combo-chip").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchUnitsByCombo(b.dataset.series, (b.dataset.tags || "").split(","), b.dataset.mode);
    }));
}

function bindSearchLinks() {
  document.querySelectorAll(".link-name").forEach((b) => {
    if (b._linkBound) return;
    b._linkBound = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchByName(b.dataset.type, b.dataset.name);
    });
  });
}

function bindEffectChips() {
  document.querySelectorAll(".effect-chip").forEach((b) => {
    if (b._effectBound) return;
    b._effectBound = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      searchByName("weapon", b.dataset.name);
    });
  });
}

function bindSupporterConds() {
  document.querySelectorAll(".sup-cond").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = currentSupporter;
      if (!s) return;
      const g = s.cond_groups?.[Number(b.dataset.branch)];
      if (g) searchUnitsByCond([condToBranch(g)]);
    }));
  const allBtn = $("#sup-all-targets");
  if (allBtn) allBtn.addEventListener("click", searchAllSupporterTargets);
}

function weaponPowerBoost(w) {
  /* 武装POWER提升类特效：按「最高提升 X%」的默认最大加成计算。 */
  let boost = 0;
  const effects = [];
  (w.effects || []).forEach((e) => {
    const text = ((e.name || "") + (e.desc || ""));
    if (!/武装POWER(?:越为)?提升/.test(text)) return;
    const m = text.match(/最高提升(\d+)%/);
    if (m) {
      const pct = Number(m[1]);
      boost = Math.max(boost, pct);
      effects.push({ name: e.name || "武装POWER提升", pct });
    }
  });
  return { boost, effects };
}

function searchAllSupporterTargets() {
  const s = currentSupporter;
  if (!s) return;
  const branches = (s.cond_groups || []).map(condToBranch);
  if (branches.length) searchUnitsByCond(branches);
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
  state.units.cond = null;
  $("#unit-q").value = "";
  $("#unit-type").value = "";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  renderUnitCondBar();
  activateTab("units");
  loadUnits(0);
}

function searchUnitsByName(name) {
  $("#modal").classList.add("hidden");
  state.units.q = name;
  state.units.series = "";
  state.units.type = "";
  state.units.tags = [];
  state.units.wfx = [];
  state.units.cond = null;
  $("#unit-q").value = name;
  $("#unit-type").value = "";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  renderUnitCondBar();
  activateTab("units");
  loadUnits(0);
}

function searchUnitsByType(role) {
  $("#modal").classList.add("hidden");
  state.units.q = "";
  state.units.series = "";
  state.units.type = String(role);
  state.units.tags = [];
  state.units.wfx = [];
  state.units.cond = null;
  $("#unit-q").value = "";
  $("#unit-type").value = String(role);
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  renderUnitCondBar();
  activateTab("units");
  loadUnits(0);
}

function searchUnitsByCombo(series, tags, mode) {
  $("#modal").classList.add("hidden");
  state.units.q = "";
  state.units.series = series;
  state.units.tags = tags;
  state.units.tag_mode = "any";
  state.units.match = mode === "or" ? "or" : "and";
  state.units.cond = null;
  state.units.type = "";
  state.units.wfx = [];
  $("#unit-q").value = "";
  $("#unit-type").value = "";
  $("#unit-tag-mode").value = "any";
  $("#unit-match").value = mode === "or" ? "or" : "and";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  renderUnitCondBar();
  activateTab("units");
  loadUnits(0);
}

function condModeLabel(mode) {
  if (mode === "and") return "（交集）";
  if (mode === "or") return "（并集）";
  return "";
}

function condToBranch(g) {
  return {
    series: (g.series || []).map((x) => x.id),
    tags: g.tags || [],
    tag_mode: g.mode === "and" ? "all" : "any",
  };
}

function renderUnitCondBar() {
  const bar = $("#unit-cond-bar");
  if (!bar) return;
  const branches = state.units.cond || [];
  if (!branches.length) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = `<span class="chip cond">词条对象筛选（${branches.length > 1
    ? `${branches.length} 个分支的并集`
    : "单分支"}）<button class="chip-x" aria-label="清除词条对象筛选" id="unit-cond-clear" title="清除词条对象筛选">×</button></span>`;
  const btn = $("#unit-cond-clear");
  if (btn) btn.addEventListener("click", () => {
    clearUnitCond();
    loadUnits(0);
  });
}

function clearUnitCond() {
  state.units.cond = null;
  renderUnitCondBar();
}

function searchUnitsByCond(branches) {
  $("#modal").classList.add("hidden");
  state.units.q = "";
  state.units.rarity = "";
  state.units.acq = "";
  state.units.series = "";
  state.units.type = "";
  state.units.tags = [];
  state.units.tag_mode = "all";
  state.units.match = "and";
  state.units.wfx = [];
  state.units.wfx_mode = "any";
  state.units.cond = branches;
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
  renderUnitCondBar();
  activateTab("units");
  loadUnits(0);
}

function activateTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => {
    const isActive = b.dataset.tab === name;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.id === `tab-${name}`));
  announceLive(`已切换到「${({overview:"概览",units:"机体",characters:"驾驶员",supporters:"支援角色",stages:"关卡敌人",search:"技能/能力/效果",damage:"伤害计算",pairing:"配对",team:"组队",mapping:"原作映射"})[name] || name}」标签页`);
  if (name === "overview") loadSummary();
  if (name === "units") loadUnits();
  if (name === "characters") loadCharacters();
  if (name === "supporters") loadSupporters();
  if (name === "search") loadSearch();
  if (name === "stages") loadStages();
  if (name === "mapping") loadMapping();
}

function announceLive(msg) {
  const el = $("#aria-live");
  if (el) el.textContent = msg;
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
    state.units.cond = null;
    $("#unit-type").value = "";
    syncCombobox("#unit-series-box");
    renderTagChips("unit");
    renderWfxChips();
    renderUnitCondBar();
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
/* Step 3: KPI 数值从 0 计数滚到目标值的动画 */
function animateKpiCounters(root) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scope = root || document;
  scope.querySelectorAll(".kpi-value[data-target]").forEach((el) => {
    const target = Number(el.dataset.target || 0);
    const exp = el.dataset.expected ? Number(el.dataset.expected) : null;
    // 小屏 / reduced-motion 直接显示最终值
    if (reduced || target < 10) {
      el.innerHTML = fmtNum(target) + (exp ? ` <span class="kpi-expected">/ ${fmtNum(exp)}</span>` : "");
      return;
    }
    const duration = 820;
    const startTs = performance.now();
    const startVal = 0;
    function frame(ts) {
      const p = Math.min(1, (ts - startTs) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      const cur = Math.round(startVal + (target - startVal) * eased);
      el.innerHTML = fmtNum(cur) + (exp ? ` <span class="kpi-expected">/ ${fmtNum(exp)}</span>` : "");
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  // 分段刻度条逐个点亮（stagger reveal）
  scope.querySelectorAll(".segment-bar[data-pct]").forEach((bar, idx) => {
    const pct = Math.max(0, Math.min(100, Number(bar.dataset.pct || 0)));
    const countLit = Math.max(0, Math.min(10, Math.round(pct / 10)));
    const spans = bar.querySelectorAll("span");
    spans.forEach((span, i) => {
      const lit = i < countLit;
      if (reduced) {
        if (lit) span.classList.add("on");
        return;
      }
      const delay = idx * 80 + i * 42;
      setTimeout(() => { if (lit) span.classList.add("on"); }, delay);
    });
  });
}

/* Step 3: 构建 10 格刻度条 HTML（无 on 类，动画后加） */
function makeSegmentBar(pct) {
  const safe = Math.max(0, Math.min(100, pct || 0));
  let cls = "segment-bar";
  if (safe < 100 && safe >= 90) cls += " near";
  const spans = Array.from({ length: 10 }, () => `<span></span>`).join("");
  return `<div class="${cls}" data-pct="${safe}">${spans}</div>`;
}

async function loadSummary() {
  const d = await api("/api/summary");
  const c = d.counts || {};
  /* Step 3: 分离 hero KPI（前 4 个 2×2 大卡） + 次级 mini cards（后 4 个保留原有 stat-grid 风格） */
  const kpiDefs = [
    { key: "units",      label: "机体",       value: c.unit,                          expected: d.expected?.unit ?? null,       glyph: "⬢" },
    { key: "characters", label: "驾驶员",     value: c.character,                     expected: null,                            glyph: "✦" },
    { key: "supporters", label: "支援角色",   value: c.supporter,                     expected: null,                            glyph: "❁" },
    { key: "stages",     label: "关卡",       value: c.stage,                         expected: d.expected?.stage ?? null,      glyph: "⚑" },
  ];
  const miniDefs = [
    ["敌方机体",     c.stage_map_npc],
    ["敌方驾驶员",   c.stage_map_npc_character],
    ["武器",         c.unit_weapon],
    ["技能/能力",    c.character_skill + c.character_ability],
  ];
  const kpiHtml = kpiDefs.map(({ key, label, value, expected, glyph }) => {
    const rawPct = expected ? (value / expected) * 100 : Math.min(100, 60 + Math.random() * 20);
    const pct = expected ? Math.round(rawPct) : null;
    const seg = makeSegmentBar(expected ? rawPct : rawPct);
    return `
      <div class="kpi-card card-elevated" data-color="${key}">
        <div class="kpi-head">
          <div class="kpi-label">${label}</div>
          <div class="kpi-icon" aria-hidden="true">${glyph}</div>
        </div>
        <div class="kpi-value-wrap">
          <span class="kpi-value" data-target="${value}" data-expected="${expected ?? ""}">${fmtNum(0)}</span>
        </div>
        ${seg}
        <div class="kpi-foot">
          <span>${expected ? `目标 ${fmtNum(expected)}` : "数据完整度"}</span>
          ${pct !== null
            ? `<span class="kpi-pct">${pct}%</span>`
            : `<span class="kpi-pct">已收录</span>`}
        </div>
      </div>`;
  }).join("");
  const miniHtml = miniDefs.map(([k, v]) => `
    <div class="stat-card card-filled">
      <div class="k">${k}</div>
      <div class="v">${fmtNum(v)}</div>
    </div>`).join("");

  /* ---- 操作面板状态条（右上） ---- */
  let dbStatusState = "ok";
  let dbLabel = "本地数据库可用";
  let dbDetail = "";
  if (!d.db_exists) { dbStatusState = "error"; dbLabel = "数据库不存在"; dbDetail = "—"; }
  else if (!d.db_has_data) { dbStatusState = "warn"; dbLabel = "数据库为空"; dbDetail = "0 MB"; }
  else { dbDetail = `${d.db_size_mb ?? 0} MB`; }

  const builtInfo = d.db_has_data && d.built_at
    ? `<div class="op-msg" id="ov-msg">构建时间：${esc(d.built_at)}<br>数据来源：soshage.com/gget（zh-CN）</div>`
    : `<div class="op-msg" id="ov-msg">当前没有数据，可通过「导入数据库」恢复，或点击「爬取数据」全量抓取。</div>`;

  $("#tab-overview").innerHTML = `
    <div class="overview-dashboard">
      <div class="overview-hero-title">
        <h3>指挥台概览</h3>
        <span class="hero-caption">TERMINAL · v2.1 · COCKPIT MODE</span>
      </div>

      <!-- 左：2×2 KPI 大卡 -->
      <div class="kpi-grid">
        ${kpiHtml}
      </div>

      <!-- 右：操作面板 -->
      <aside class="op-panel">
        <h4>数据库操作</h4>
        <div class="op-status is-${dbStatusState}">
          <span class="stat-chip">${dbLabel}</span>
          <span class="op-size">${dbDetail}</span>
        </div>
        <div class="op-actions">
          <button id="ov-export"        class="btn btn-tonal"       title="下载当前数据库文件">
            <span class="btn-glyph">⤓</span><span>导出数据库</span>
          </button>
          <button id="ov-import"        class="btn btn-outlined"    title="导入数据库备份文件（自动保存到本地）">
            <span class="btn-glyph">⤒</span><span>导入数据库</span>
          </button>
          <button id="ov-crawl"         class="btn btn-primary"     title="从 soshage 全量抓取并构建数据库（仅手动触发）">
            <span class="btn-glyph">⟳</span><span>爬取数据</span>
          </button>
          <button id="ov-sync-up"       class="btn btn-outlined"    title="以本地数据为准，覆盖云端服务器">
            <span class="btn-glyph">▲</span><span>上传本地到服务器</span>
          </button>
          <button id="ov-sync-down"     class="btn btn-outlined"    title="以云端服务器数据为准，覆盖本地">
            <span class="btn-glyph">▼</span><span>服务器同步到本地</span>
          </button>
          <button id="ov-edit-history"  class="btn btn-text"        title="查看机体编辑的历史记录">
            <span class="btn-glyph">⌘</span><span>查看编辑历史</span>
          </button>
          <input type="file" id="ov-import-file" accept=".db" class="hidden">
        </div>
        ${builtInfo}
      </aside>

      <!-- 次级：剩余 4 个统计（小卡） -->
      <div class="overview-mini-title">衍生数据</div>
      <div class="stat-grid" style="margin-top:0;">
        ${miniHtml}
      </div>
    </div>`;

  bindOverviewActions(d);
  updateHudDbStat(c);
  animateKpiCounters($("#tab-overview"));
  const [cst, sst] = await Promise.all([
    api("/api/crawl-status"),
    api("/api/sync-status"),
  ]);
  if (cst.running || sst.running) {
    disableOverviewButtons(true);
    if (cst.running) {
      pollCrawlStatus($("#ov-crawl"), $("#ov-msg"));
    } else {
      pollSyncStatus($("#ov-msg"));
    }
  }
}

function disableOverviewButtons(disabled) {
  ["#ov-export", "#ov-import", "#ov-crawl", "#ov-sync-up", "#ov-sync-down", "#ov-edit-history"]
    .forEach((sel) => {
      const b = $(sel);
      if (b) b.disabled = disabled;
    });
}

function bindOverviewActions(d) {
  const msg = $("#ov-msg");
  const exportBtn = $("#ov-export");
  const importBtn = $("#ov-import");
  const crawlBtn = $("#ov-crawl");
  const syncUpBtn = $("#ov-sync-up");
  const syncDownBtn = $("#ov-sync-down");
  const editHistoryBtn = $("#ov-edit-history");
  const fileInput = $("#ov-import-file");
  exportBtn.addEventListener("click", () => {
    if (!d.db_exists) {
      msg.textContent = "没有可导出的数据库";
      return;
    }
    window.location.href = "/api/export";
  });
  importBtn.addEventListener("click", () => fileInput.click());
  syncUpBtn.addEventListener("click", () => openSyncDiff("upload"));
  syncDownBtn.addEventListener("click", () => openSyncDiff("download"));
  editHistoryBtn.addEventListener("click", async () => {
    let items = [];
    try {
      items = await api("/api/edit-history");
    } catch (e) {
      msg.textContent = "获取编辑历史失败：" + (e.message || e);
      return;
    }
    const rows = items.length ? items.map((x) => `
      <tr>
        <td class="mono">${esc(x.edited_at || "")}</td>
        <td><span class="muted">${esc(x.kind || "")}</span> ${esc(x.name || "")}</td>
        <td>${esc(x.field || "")}</td>
        <td class="mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.old_value || "")}">${esc(x.old_value || "")}</td>
        <td class="mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.new_value || "")}">${esc(x.new_value || "")}</td>
        <td>${esc(x.source || "")}</td>
      </tr>`).join("")
      : '<tr><td colspan="6" class="empty">暂无编辑记录</td></tr>';
    showModal("查看编辑历史",
      `<div class="sync-info"><div>共 ${items.length} 条记录（仅保存在本地）</div></div>
       <div style="max-height:55vh;overflow:auto">
       <table><tr><th>时间</th><th>对象</th><th>字段</th><th>原值</th><th>新值</th><th>来源</th></tr>${rows}</table>
       </div>
       <div class="calc-actions"><button id="edit-history-close" class="cond-btn">关闭</button></div>`);
    $("#edit-history-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
  });
  crawlBtn.addEventListener("click", async () => {
    let edits = [];
    try {
      edits = await api("/api/crawl-edits");
    } catch (e) { /* 忽略 */ }
    if (edits.length) {
      showModal("爬取数据",
        `<p class="desc">全量爬取会用原始数据重建数据库，以下机体/驾驶员有本地编辑记录。勾选需要保留的编辑，未勾选的将被新数据覆盖：</p>
         <div id="crawl-keep-list" class="tags">${edits.map((x) =>
           `<label class="chip sel-tag"><input type="checkbox" value="${x.kind === "character" ? "C" : "U"}${x.id}" checked> ${esc(x.name)}（${x.edits} 项编辑）</label>`).join("")}</div>
         <div class="calc-actions">
           <button id="crawl-keep" class="cond-btn">爬取并保留勾选编辑</button>
           <button id="crawl-overwrite" class="cond-btn">不保留，全部覆盖</button>
           <button id="crawl-cancel" class="cond-btn">取消</button>
         </div>`);
      $("#crawl-keep").addEventListener("click", () => {
        const keep = [...document.querySelectorAll("#crawl-keep-list input:checked")].map((el) => el.value);
        $("#modal").classList.add("hidden");
        doCrawl(keep);
      });
      $("#crawl-overwrite").addEventListener("click", () => {
        $("#modal").classList.add("hidden");
        doCrawl([]);
      });
      $("#crawl-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
      return;
    }
    if (!confirm("将开始全量爬取数据（耗时较长），确定继续？")) return;
    doCrawl([]);
  });
  async function doCrawl(preserve) {
    crawlBtn.disabled = true;
    msg.textContent = "正在开始爬取…";
    try {
      const r = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preserve }),
      });
      const res = await r.json();
      if (!res.ok) {
        msg.textContent = res.message || "启动爬取失败";
        crawlBtn.disabled = false;
        return;
      }
      msg.textContent = "爬取已启动";
      pollCrawlStatus(crawlBtn, msg);
    } catch (e) {
      msg.textContent = "启动爬取失败：" + (e.message || e);
      crawlBtn.disabled = false;
    }
  }
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (d.db_has_data && !confirm("导入会覆盖本地现有数据库，确定继续？")) {
      fileInput.value = "";
      return;
    }
    msg.textContent = "正在导入…";
    try {
      const r = await fetch("/api/import", { method: "POST", body: f });
      const res = await r.json();
      msg.textContent = res.message || res.error || "导入失败";
      if (res.ok) {
        fileInput.value = "";
        loadSummary();
      }
    } catch (e) {
      msg.textContent = "导入失败：" + (e.message || e);
    }
  });
}

async function openSyncDiff(direction) {
  const msg = $("#ov-msg");
  msg.textContent = "正在对比本地与服务器数据…";
  let res;
  try {
    res = await api("/api/sync-diff");
  } catch (e) {
    msg.textContent = "获取同步差异失败：" + (e.message || e);
    return;
  }
  if (!res.ok) {
    msg.textContent = res.error || "无法获取同步差异";
    return;
  }
  const rows = (res.tables || []).map((t) => `
    <tr>
      <td>${esc(t.table)}</td>
      <td class="mono">${t.local == null ? "缺失" : t.local}</td>
      <td class="mono">${t.cloud == null ? "缺失" : t.cloud}</td>
      <td>${t.same ? '<span class="chip cond">一致</span>' : '<span class="chip" style="border-color:#e05c5c;color:#ff8f8f">不同</span>'}</td>
    </tr>`).join("");
  const diffCount = (res.tables || []).filter((t) => !t.same).length;
  const localMeta = res.local_built_at ? `构建于 ${esc(res.local_built_at)}` : "无构建记录";
  const cloudMeta = res.cloud_built_at ? `构建于 ${esc(res.cloud_built_at)}` : "无构建记录";
  const identicalNote = res.identical
    ? '<p class="desc" style="color:var(--ok)">本地与服务器数据完全一致，无需同步。</p>'
    : `<p class="desc">发现 ${diffCount} 张表存在差异。同步为整体覆盖（重建目标端），不会产生重复数据。请选择以哪边数据为准：</p>`;
  showModal("同步数据",
    `<div class="sync-info">
       <div><b>本地</b>：${localMeta}${res.local_quick_check ? `（完整性：${esc(res.local_quick_check)}）` : ""}</div>
       <div><b>服务器</b>：${cloudMeta}</div>
       <div>合计：本地 ${res.total_local ?? "—"} 行 / 服务器 ${res.total_cloud ?? "—"} 行</div>
     </div>
     ${identicalNote}
     <table><tr><th>表</th><th>本地行数</th><th>服务器行数</th><th>状态</th></tr>${rows}</table>
     <div class="calc-actions">
       ${res.identical ? `<button id="sync-close" class="cond-btn">关闭</button>` : `
       <button id="sync-local" class="cond-btn" title="以本地为准，覆盖服务器">以本地为准（覆盖服务器）</button>
       <button id="sync-cloud" class="cond-btn" title="以服务器为准，覆盖本地">以服务器为准（覆盖本地）</button>
       <button id="sync-close" class="cond-btn">关闭</button>`}
     </div>`);
  const close = $("#sync-close");
  if (close) close.addEventListener("click", () => $("#modal").classList.add("hidden"));
  if (res.identical) return;
  $("#sync-local").addEventListener("click", () => runSync("upload"));
  $("#sync-cloud").addEventListener("click", () => runSync("download"));
  function runSync(dir) {
    $("#modal").classList.add("hidden");
    msg.textContent = "正在开始同步…";
    fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: dir }),
    }).then((r) => r.json()).then((res2) => {
      if (!res2.ok) {
        msg.textContent = res2.message || "启动同步失败";
        return;
      }
      disableOverviewButtons(true);
      pollSyncStatus(msg);
    }).catch((e) => {
      msg.textContent = "启动同步失败：" + (e.message || e);
    });
  }
}

function pollSyncStatus(msg) {
  const tick = async () => {
    try {
      const res = await api("/api/sync-status");
      if (res.running) {
        msg.textContent = "正在同步中（" + (res.direction === "upload" ? "上传本地到服务器" : "服务器同步到本地") + "）…";
        setTimeout(tick, 3000);
        return;
      }
      disableOverviewButtons(false);
      if (res.error) {
        msg.textContent = "同步失败：" + res.error;
      } else {
        msg.textContent = "同步完成，两边数据已保持一致";
        loadSummary();
      }
    } catch (e) {
      disableOverviewButtons(false);
      msg.textContent = "查询同步状态失败：" + (e.message || e);
    }
  };
  setTimeout(tick, 2000);
}

function pollCrawlStatus(btn, msg) {
  const tick = async () => {
    try {
      const res = await api("/api/crawl-status");
      if (res.running) {
        msg.textContent = "正在爬取中（" + (res.step === "build" ? "构建数据库" : "抓取数据") + "）…";
        setTimeout(tick, 3000);
        return;
      }
      btn.disabled = false;
      if (res.error) msg.textContent = "爬取失败：" + res.error;
      else {
        msg.textContent = "爬取完成，数据库已更新";
        loadSummary();
      }
    } catch (e) {
      btn.disabled = false;
      msg.textContent = "查询爬取状态失败：" + (e.message || e);
    }
  };
  setTimeout(tick, 2000);
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
  { value: "has_unit_skill", label: "有单位技能" },
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
  const clear = box.querySelector(".sbox-clear");
  const prev = comboboxes[boxId];
  // 下拉首次挂到 body 后就不在 box 里了，重入时复用缓存引用（幂等）
  let list = prev && prev.list ? prev.list : box.querySelector(".sbox-list");
  if (!list) return;
  if (list.parentNode !== document.body) {
    document.body.appendChild(list);
    list.style.position = "fixed";
  }
  comboboxes[boxId] = { options, getVal, list, input, clear, onPick, clearable };

  const cur = () => comboboxes[boxId];
  const render = () => {
    const c = cur();
    const kw = c.input.value.trim().toLowerCase();
    const opts = c.options.filter((o) => !kw || o.label.toLowerCase().includes(kw));
    c.list.innerHTML = opts.slice(0, 60).map((o) =>
      `<button class="sbox-item" data-v="${esc(String(o.value))}">${esc(o.label)}</button>`).join("")
      || '<div class="empty">无匹配</div>';
    c.list.querySelectorAll(".sbox-item").forEach((b) =>
      b.addEventListener("click", () => {
        c.onPick(b.dataset.v, b.textContent);
        if (!c.clearable) c.input.value = "";
        syncCombobox(boxId);
        c.list.classList.add("hidden");
      }));
  };
  const close = () => cur().list.classList.add("hidden");
  const position = () => {
    const c = cur();
    const r = c.input.getBoundingClientRect();
    const w = Math.max(r.width, 220);
    c.list.style.left = Math.min(r.left, window.innerWidth - w - 8) + "px";
    c.list.style.width = w + "px";
    const h = c.list.offsetHeight || 0;
    if (window.innerHeight - r.bottom < h + 8 && r.top > h + 8) {
      c.list.style.top = Math.max(8, r.top - h - 4) + "px";
    } else {
      c.list.style.top = r.bottom + 4 + "px";
    }
  };
  const open = () => {
    render();
    cur().list.classList.remove("hidden");
    position();
  };

  if (!prev) {
    input.addEventListener("focus", open);
    input.addEventListener("click", () => { if (cur().list.classList.contains("hidden")) open(); });
    input.addEventListener("input", () => { render(); position(); });
    input.addEventListener("blur", () => setTimeout(close, 150));
    window.addEventListener("scroll", () => { const c = cur(); if (c && !c.list.classList.contains("hidden")) position(); }, true);
    window.addEventListener("resize", () => { const c = cur(); if (c && !c.list.classList.contains("hidden")) position(); });
    if (clear) clear.addEventListener("click", () => { onPick("", ""); syncCombobox(boxId); });
  }
  syncCombobox(boxId);
}

async function initFilterControls() {
  const series = await api("/api/series");
  const seriesOpts = [{ value: "", label: "全部系列" }].concat(
    series.map((s) => ({ value: s.id, label: s.name }))
  );
  const [unitTags, charTags, supTags, skillNames, supportLabels, supSkillNames] = await Promise.all([
    api("/api/tags?kind=unit"),
    api("/api/tags?kind=character"),
    api("/api/tags?kind=supporter"),
    api("/api/skillnames"),
    api("/api/support-labels"),
    api("/api/supporter-skillnames"),
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
  initCombobox("#sup-skill-box", tagOpts(supSkillNames), () => "",
    (v) => addSupSkillChip(v), false);
  pairFilterData = { seriesOpts, charTags: tagOpts(charTags),
    skillNames: tagOpts(skillNames), supportLabels };
  $("#char-support").innerHTML = '<option value="">全部支援次数</option>' +
    supportLabels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  initCombobox("#picker-series-box", seriesOpts, () => pickerState.series,
    (v) => { pickerState.series = String(v); }, true);
  initCombobox("#picker-wfx-box", WFX_OPTIONS, () => pickerState.wfx,
    (v) => { pickerState.wfx = String(v); }, true);
  initCombobox("#picker-skill-box", tagOpts(skillNames), () => pickerState.skills,
    (v) => { pickerState.skills = String(v); }, true);
  $("#picker-support").innerHTML = '<option value="">全部支援次数</option>' +
    supportLabels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  initCombobox("#pp-series-box", seriesOpts, () => pairUnitState.series,
    (v) => { pairUnitState.series = String(v); ppLoad(0); }, true);
  initCombobox("#pp-tag-box", tagOpts(unitTags), () => "",
    (v) => { if (v) { pairUnitState.tags.push(v); renderPairTagChips(); ppLoad(0); } }, false);
  initCombobox("#pp-wfx-box", WFX_OPTIONS, () => "",
    (v) => { pairUnitState.wfx.push(v); renderPairWfxChips(); ppLoad(0); }, false);
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
          <button class="chip-x" aria-label="移除" data-wfx="${esc(v)}" title="移除">×</button>
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
          <button class="chip-x" aria-label="移除" data-skill="${esc(v)}" title="移除">×</button>
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

function renderSupSkillChips() {
  const box = $("#sup-skill-chips");
  if (!box) return;
  box.innerHTML = state.supporters.skills.length
    ? state.supporters.skills.map((v) =>
        `<span class="chip sel-tag">${esc(v)}
          <button class="chip-x" aria-label="移除" data-skill="${esc(v)}" title="移除">×</button>
        </span>`).join("")
    : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      state.supporters.skills = state.supporters.skills.filter((v) => v !== b.dataset.skill);
      renderSupSkillChips();
    }));
}

function addSupSkillChip(v) {
  if (!v || state.supporters.skills.includes(v)) return;
  state.supporters.skills.push(v);
  renderSupSkillChips();
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
          <button class="chip-x" aria-label="移除" data-kind="${kind}" data-tag="${esc(t)}" title="移除">×</button>
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
    cond: s.cond ? JSON.stringify(s.cond) : "",
    sort: s.sort, order: s.order,
    limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/units?" + q);
  $("#unit-count").textContent = `共 ${d.total} 条结果`;
  announceLive(`搜索完成，共找到 ${d.total} 条机体结果`);
  $("#unit-list").innerHTML = d.items.length
    ? d.items.map((u) => `
      <div class="list-row units" data-id="${u.id}">
        <span class="name">${esc(u.name)}</span>
        ${cell(rarityBadge(u.rarity))}
        ${cell(roleBadge(u.role, u.role_label))}
        ${statCellBar(u.atk_f, "attack")}${statCellBar(u.def_f, "defense")}
        ${statCellBar(u.mob_f, "mobility")}${statCellBar(u.hp_f, "hp")}
        ${statCellBar(u.en_f, "en")}${statCellBar(u.mov, "movement")}
      </div>`).join("")
    : '<div class="empty">没有匹配的机体（当前已抓取详情有限）</div>';
  $("#unit-list").querySelectorAll(".list-row").forEach((r) =>
    r.addEventListener("click", () => openUnit(r.dataset.id)));
  pager("unit", d.total, s.page, s.size, loadUnits);
  updateSortArrows("units");
  applyColWidths("units");
  applyStagger("#unit-list");
}

/* ---------- 机体详情：形态切换（地形/武器/能力） ---------- */

// 取得当前形态下的武器/能力/地形（优先取 form_content，fallback 到顶层旧字段）
function formContent(u, formKey) {
  const fc = u.form_content || {};
  if (fc[formKey]) return fc[formKey];
  if (fc.default) return fc.default;
  return { weapons: u.weapons, abilities: u.abilities, terrain: u.terrain || {} };
}

function renderUnitTerrain(u, formKey) {
  const wrap = $("#unit-terrain");
  if (!wrap) return;
  const t = formContent(u, formKey).terrain || {};
  wrap.innerHTML = Object.entries({ 宇宙: t.space, 大气圈: t.atmospheric, 地面: t.ground, 水面: t.surface, 水中: t.underwater })
    .map(([k, v]) => `<span class="chip">${k} ${v ?? "—"}</span>`).join("");
  bindEffectChips();
}

function renderUnitWfx(u, formKey) {
  const wrap = $("#unit-wfx-wrap");
  if (!wrap) return;
  const ws = formContent(u, formKey).weapons || [];
  const abs = formContent(u, formKey).abilities || [];
  // 收集每个武器的 effects 文本
  const hasEffect = (w, text) => (w.effects || []).some((e) => (e.desc || "").includes(text) || (e.name || "").includes(text));
  const nonMapWeps = ws.filter((w) => !w.map_weapon_range || ["", "null", "0"].includes(String(w.map_weapon_range)));
  const maxRange = Math.max(0, ...ws.map((w) => Number(w.range_max) || 0));
  const mapWeps = ws.filter((w) => w.map_weapon_range && !["", "null", "0"].includes(String(w.map_weapon_range)));
  const match = new Set();
  if (mapWeps.length) match.add("map");
  if (maxRange === 5) match.add("range5");
  if (maxRange > 5) match.add("range5plus");
  // 非MAP的射程
  const nonMapMax = Math.max(0, ...nonMapWeps.map((w) => Number(w.range_max) || 0));
  if (nonMapMax === 5) match.add("range5_nomap");
  if (nonMapMax > 5) match.add("range5plus_nomap");
  // 特效相关
  if (ws.some((w) => hasEffect(w, "物理损伤"))) match.add("phys");
  if (ws.some((w) => hasEffect(w, "光束损伤"))) match.add("beam");
  if (ws.some((w) => hasEffect(w, "特殊损伤"))) match.add("spec");
  if (ws.some((w) => hasEffect(w, "防御力减少"))) match.add("defdown");
  // 特效+射程
  const r5Weps = ws.filter((w) => Number(w.range_max) >= 5);
  if (r5Weps.some((w) => hasEffect(w, "物理损伤"))) match.add("phys_r5");
  if (r5Weps.some((w) => hasEffect(w, "光束损伤"))) match.add("beam_r5");
  if (r5Weps.some((w) => hasEffect(w, "特殊损伤"))) match.add("spec_r5");
  if (r5Weps.some((w) => hasEffect(w, "防御力减少"))) match.add("defdown_r5");
  // 技能
  if ((u.skills || []).length) match.add("has_unit_skill");
  // 按 WFX_SPECIFIC_REMOVE 规则移除笼统项
  const remove = { range5_nomap: "range5", range5plus_nomap: "range5plus", phys_r5: "phys", beam_r5: "beam", spec_r5: "spec", defdown_r5: "defdown" };
  for (const [specific, general] of Object.entries(remove)) {
    if (match.has(specific)) match.delete(general);
  }
  const chips = WFX_OPTIONS.filter((o) => match.has(o.value));
  wrap.innerHTML = chips.length
    ? `<h3 class="ds-sec">机体备注（点击可搜索）</h3><div class="tags">${chips.map((o) => `<button class="chip wfx-chip" data-wfx="${esc(o.value)}">${esc(o.label)}</button>`).join("")}</div>`
    : "";
  bindEffectChips();
  bindUnitInfoChips();
}

function renderUnitWeapons(u, formKey) {
  const ws = formContent(u, formKey).weapons || [];
  const title = $("#unit-weapons-title");
  const wrap = $("#unit-weapons-wrap");
  if (title) title.textContent = `武器（${ws.length}）`;
  if (!wrap) return;
  const rows = ws.map((w) => `
    <tr>
      <td>${esc(w.name)} ${lvBadge(w.weapon_max_level)}</td>
      <td>${esc(`${w.attack_attr_label ?? "—"}/${w.attrs_label ?? w.weapon_attr_label ?? "—"}`)}</td>
      <td>${esc(w.pilot_stat ?? "—")}</td>
      <td class="mono">${w.map_weapon_range
        ? `MAP（${w.range_min ?? "—"}~${w.range_max ?? "—"}）`
        : `${w.range_min ?? "—"}~${w.range_max ?? "—"}`}</td>
      <td class="mono">${w.power_lv9 ?? w.power_lv5 ?? w.power}</td>
      <td class="mono">${w.en_lv9 ?? w.en_lv5 ?? w.en}</td>
      <td class="mono">${w.hit_lv9 ?? w.hit_lv5 ?? w.hit_rate ?? "—"}%</td>
      <td class="mono">${w.crit_lv9 ?? w.crit_lv5 ?? w.critical_rate ?? "—"}%</td>
      <td>${weaponEffects(w)}</td>
    </tr>`).join("");
  wrap.innerHTML = `<table><tr><th>名称</th><th>类型</th><th>依赖属性</th><th>射程</th><th>威力(满级)</th><th>EN(满级)</th><th>命中(满级)</th><th>暴击(满级)</th><th>特效(满级)</th></tr>${rows || '<tr><td colspan="9" class="empty">暂无武器数据</td></tr>'}</table>`;
  bindEffectChips();
  bindSearchLinks();
}

function renderUnitAbilities(u, formKey) {
  const abs = formContent(u, formKey).abilities || [];
  const wrap = $("#unit-abilities-wrap");
  if (!wrap) return;
  if (!abs.length) {
    wrap.innerHTML = '<div class="empty">暂无能力数据</div>';
    return;
  }
  const rows = abs.map((a) => `
    <tr>
      <td><button class="link-name" data-type="ability" data-name="${esc(a.name)}">${esc(a.name)}</button></td>
      <td class="desc">${effectHtml(a.effects, a.desc, a.cond_entities)}</td>
    </tr>`).join("");
  wrap.innerHTML = `<h3>能力</h3><table><tr><th>名称</th><th>效果</th></tr>${rows}</table>`;
  bindEffectChips();
  bindSearchLinks();
}

async function openUnit(id) {
  const [u, canonical] = await Promise.all([
    api(`/api/units/${id}`),
    api(`/api/canonical?unit_id=${id}`),
  ]);
  const unitSkills = (u.skills || []).map((s) => `
    <tr>
      <td>${esc(s.name || "单位技能")}</td>
      <td class="desc">${esc(s.desc || "—")}</td>
      <td>${s.duration ? `${s.duration} 回合` : "—"}</td>
    </tr>`).join("");
  unitEdit = null;
  unitView.u = u;
  unitView.formKey = "default";
  unitView.star = (u.can_star && u.forms?.default?.stars?.length)
    ? u.forms.default.stars.length - 1 : 0;
  unitView.on.clear();

  const seriesHtml = (u.series_names || []).length
    ? `<div class="tags" style="margin-bottom:12px">${u.series_names.map((s) =>
        `<button class="chip series-chip" data-series-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : "";
  const tagsHtml = u.tags.length
    ? `<div class="tags" style="margin-bottom:12px">${u.tags.map((t) => tagChip(t)).join("")}</div>` : "";

  /* 左列：角色 + desc + 系列 + 标签 + 机体备注(wfx) + 交互属性(#unit-attr) + 地形适性 */
  const canonicalHtml = canonical && canonical.pilot ? canonicalJumpHtml("unit", canonical.pilot, id) : "";
  const summaryHtml = `
    <div class="ds-role-row">${roleBadge(u.role, u.role_label)} ${rarityBadge(u.rarity)}</div>
    ${canonicalHtml}
    <div class="ds-desc">${esc(u.desc || "暂无描述")}</div>
    ${seriesHtml}${tagsHtml}
    <div id="unit-wfx-wrap"></div>
    <div id="unit-attr"></div>
    <h3 class="ds-sec">地形适性</h3>
    <div id="unit-terrain" class="tags"></div>`;

  /* 右列：无 tab，直接堆叠武器 / 能力 / 单位技能 */
  const contentHtml = `
    <h3 id="unit-weapons-title">武器（0）</h3>
    <div id="unit-weapons-wrap"></div>
    <div id="unit-abilities-wrap"></div>
    <div id="unit-skills-wrap"></div>`;

  showModal(
    `${esc(u.name)}<span class="unit-edit-btns">
       <button id="unit-edit-btn" class="cond-btn" title="进入编辑模式">修改机体数据</button>
       <button id="unit-save-btn" class="cond-btn" title="保存修改到本地">保存修改到本地</button>
       <button id="unit-sync-btn" class="cond-btn" title="同步该机体数据到服务器">同步机体数据到服务器</button>
       <button id="unit-refetch-btn" class="cond-btn" title="重新从网站爬取该机体数据并对比差异，确认后以网页数据覆盖本地">重新爬取</button>
     </span>`,
    `<div class="detail-summary">${summaryHtml}</div><div class="detail-content">${contentHtml}</div>`);
  /* 启用双栏布局 */
  const box = $("#modal .modal-box");
  if (box) box.classList.add("modal-detail");

  renderUnitAttr();
  renderUnitTerrain(u, unitView.formKey);
  renderUnitWeapons(u, unitView.formKey);
  renderUnitAbilities(u, unitView.formKey);
  renderUnitWfx(u, unitView.formKey);
  const sw = $("#unit-skills-wrap");
  if (sw) sw.innerHTML = unitSkills
    ? `<h3>单位技能（${(u.skills || []).length}）</h3><table><tr><th>名称</th><th>效果</th><th>持续</th></tr>${unitSkills}</table>`
    : "";
  bindUnitAttr();
  bindTagChips();
  bindUnitInfoChips();
  bindUnitEditButtons(u);
}

/* ---------- 机体详情状态：形态(default/sp/ssp) · 星级 · 达成条件 开关 ---------- */
const UNIT_STAT_LABELS = { hp: "HP", en: "EN", attack: "攻击", defense: "防御", mobility: "机动", movement: "移动" };
const unitView = { u: null, formKey: "default", star: 0, on: new Set() };

function unitForm() {
  return unitView.u.forms[unitView.formKey] || unitView.u.forms.default;
}

function unitMoveVal() {
  const f = unitForm();
  return f.movement?.[1] ?? unitView.u.max_movement ?? 0;
}

/* 当前形态/星级下可用的条件加成行（按 forms[form][star] 过滤） */
function unitCondRows() {
  const u = unitView.u;
  return (u.conditional_bonuses || []).filter((c) => {
    if (c._ssp_only && unitView.formKey !== "ssp") return false;
    return c.forms?.[unitView.formKey]?.[unitView.star] != null;
  });
}

/* 一条达成条件能力可能同时作用于多个 stat（同 name 多行），按 name 去重为一个开关 */
function unitCondNames(rows) {
  const out = [];
  for (const r of rows) if (!out.includes(r.name)) out.push(r.name);
  return out;
}

/* 形态/星级变化后，清理已不可用的选中项 */
function unitPruneCond() {
  const avail = new Set(unitCondNames(unitCondRows()));
  for (const name of [...unitView.on]) if (!avail.has(name)) unitView.on.delete(name);
}

/* 某 stat 当前选中的加成%；同 stat HP 区间互斥取最大，否则求和 */
function unitCondPct(stat) {
  const sel = unitCondRows().filter((c) => c.stat === stat && unitView.on.has(c.name));
  if (!sel.length) return 0;
  let compat = true;
  outer:
  for (let i = 0; i < sel.length; i++) {
    for (let j = i + 1; j < sel.length; j++) {
      const a = sel[i], b = sel[j];
      if (!a.has_hp_cond || !b.has_hp_cond) continue;
      const au = a.hp_lte > 0 ? a.hp_lte : 100;
      const bu = b.hp_lte > 0 ? b.hp_lte : 100;
      if ((a.hp_gte || 0) > bu || (b.hp_gte || 0) > au) { compat = false; break outer; }
    }
  }
  if (compat) return sel.reduce((s, c) => s + (c.pct || 0), 0);
  return Math.max(...sel.map((c) => c.pct || 0));
}

function unitStatVal(key) {
  const st = unitForm().stars[unitView.star].stats[key];
  const starBase = st.max - (st.max_bonus || 0);
  const basePct = (unitView.u.stat_bonuses || {})[key] || 0;
  const condPct = unitCondPct(key);
  const final = Math.floor(starBase * (100 + basePct + condPct) / 100);
  return { final, delta: final - starBase };
}

function condRowHtml(rows, names) {
  const chips = names.map((name) => {
    const rs = rows.filter((r) => r.name === name);
    const effect = rs.map((r) => `${UNIT_STAT_LABELS[r.stat] || r.stat} +${r.pct}%`).join("，");
    const conds = [...new Set(rs.map((r) => r.condition).filter(Boolean))].join("；");
    const tip = [
      conds ? `条件：${conds}` : "",
      effect ? `效果：${effect}` : "",
      name ? `能力：${name}` : "",
    ].filter(Boolean).join("\n");
    return `<button class="chip cond-chip${unitView.on.has(name) ? " on" : ""}" data-name="${esc(name)}" title="${esc(tip)}">${esc(name)}</button>`;
  }).join("");
  return `<div class="cond-row"><span class="star-label">达成条件</span><div class="tags">${chips}</div></div>`;
}

/* 左侧属性区：形态/星级/达成条件按钮 + 六格数值（就地更新） */
function renderUnitAttr() {
  const wrap = $("#unit-attr");
  if (!wrap) return;
  const u = unitView.u;
  const form = unitForm();
  const formBtns = (u.can_star && u.has_sp)
    ? `<span class="star-label">形态</span>` + [
        ["default", `默认(${u.forms.default.level_cap}级)`],
        ["sp", "SP(100级)"],
        ...(u.has_ssp ? [["ssp", "SSP"]] : []),
      ].map(([fk, label]) =>
        `<button class="form-btn ${unitView.formKey === fk ? "active" : ""}" data-form="${fk}">${label}</button>`).join("")
    : "";
  const starBtns = u.can_star
    ? `<span class="star-label">星级</span>` + form.stars.map((x) =>
        `<button class="star-btn ${x.star === unitView.star ? "active" : ""}" data-star="${x.star}">${x.star}★ ${x.label}</button>`).join("")
    : "";
  const ultNote = !u.can_star ? `<span class="chip ult-tag">终极标签 · 暂不能升星 / SP</span>` : "";
  const rows = unitCondRows();
  const names = unitCondNames(rows);
  const notes = [];
  if (unitView.formKey === "ssp" && form.fallback) notes.push("SSP 数据暂未收录，暂以 SP 数值显示。");
  if (!u.can_star) notes.push("终极标签机体暂不能升星 / SP，仅统计 0 星数据。");
  notes.push(names.length ? "绿色 +N 为能力加成；点选「达成条件」会将对应加成并入数值。" : "绿色 +N 为无条件能力加成。");
  const cells = [
    ["HP", unitStatVal("hp")],
    ["EN", unitStatVal("en")],
    ["攻击", unitStatVal("attack")],
    ["防御", unitStatVal("defense")],
    ["机动", unitStatVal("mobility")],
    ["移动", { final: unitMoveVal(), delta: 0 }],
  ].map(([k, v]) => `<div class="ds-stat">
    <span class="ds-k">${k}</span>
    <span class="ds-v">${fmtNum(v.final)}${v.delta ? `<small>+${fmtNum(v.delta)}</small>` : ""}</span>
  </div>`).join("");
  wrap.innerHTML = `
    <h3 class="ds-sec">机体属性（满级）</h3>
    ${formBtns ? `<div class="star-bar">${formBtns}</div>` : ""}
    <div class="star-bar">${starBtns ? `${starBtns} ` : ""}<span class="cap-chip">满级上限 ${form.level_cap}</span>${ultNote ? ` ${ultNote}` : ""}</div>
    ${names.length ? condRowHtml(rows, names) : ""}
    <div class="ds-stats">${cells}</div>
    <p class="hint">${notes.map(esc).join(" ")}</p>`;
}

/* 属性区子元素每次整体重建，委托只需在 #unit-attr 上挂一次 */
function bindUnitAttr() {
  const box = $("#unit-attr");
  if (!box || box._uvBound) return;
  box._uvBound = true;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".form-btn,.star-btn,.cond-chip");
    if (!btn || !box.contains(btn)) return;
    if (btn.classList.contains("form-btn")) return unitSetForm(btn.dataset.form);
    if (btn.classList.contains("star-btn")) return unitSetStar(Number(btn.dataset.star));
    return unitToggleCond(btn.dataset.name);
  });
}

function unitSetForm(fk) {
  const u = unitView.u;
  if (!u.forms[fk]) return;
  unitView.formKey = fk;
  if (!u.can_star) unitView.star = 0;
  else if (u.forms[fk].stars.length) {
    unitView.star = Math.min(unitView.star, u.forms[fk].stars.length - 1);
  }
  unitPruneCond();
  renderUnitView("form");
}

function unitSetStar(n) {
  if (unitView.u.can_star) {
    const f = unitForm();
    unitView.star = Math.max(0, Math.min(f.stars.length - 1, Number(n) || 0));
  } else {
    unitView.star = 0;
  }
  unitPruneCond();
  renderUnitView("star");
}

function unitToggleCond(name) {
  if (unitView.on.has(name)) unitView.on.delete(name); else unitView.on.add(name);
  renderUnitView("cond");
}

/* scope: form 才更新右侧武器/能力与左列地形/机体备注；star/cond 只重算左列数值 */
function renderUnitView(scope) {
  renderUnitAttr();
  if (scope === "form") {
    renderUnitTerrain(unitView.u, unitView.formKey);
    renderUnitWfx(unitView.u, unitView.formKey);
    renderUnitWeapons(unitView.u, unitView.formKey);
    renderUnitAbilities(unitView.u, unitView.formKey);
  }
}

function bindUnitInfoChips() {
  document.querySelectorAll(".series-chip").forEach((b) => {
    if (b._seriesBound) return;
    b._seriesBound = true;
    b.addEventListener("click", () => searchUnitsBySeries(Number(b.dataset.seriesId)));
  });
  document.querySelectorAll(".wfx-chip").forEach((b) => {
    if (b._wfxBound) return;
    b._wfxBound = true;
    b.addEventListener("click", () => searchUnitsByWfx(b.dataset.wfx));
  });
}

function searchUnitsByWfx(value) {
  $("#modal").classList.add("hidden");
  state.units.q = "";
  state.units.series = "";
  state.units.type = "";
  state.units.tags = [];
  state.units.cond = null;
  state.units.wfx = [value];
  state.units.wfx_mode = "any";
  $("#unit-q").value = "";
  $("#unit-type").value = "";
  syncCombobox("#unit-series-box");
  renderTagChips("unit");
  renderWfxChips();
  renderUnitCondBar();
  activateTab("units");
  loadUnits(0);
}

/* ---------- 机体数据编辑 ---------- */
let unitEdit = null;

function bindUnitEditButtons(u) {
  const editBtn = $("#unit-edit-btn");
  const saveBtn = $("#unit-save-btn");
  const syncBtn = $("#unit-sync-btn");
  const refetchBtn = $("#unit-refetch-btn");
  if (editBtn) editBtn.addEventListener("click", () => enterUnitEdit(u));
  if (saveBtn) saveBtn.addEventListener("click", () => saveUnitEdit());
  if (syncBtn) syncBtn.addEventListener("click", () => {
    openUnitSync(u.id);
  });
  if (refetchBtn) refetchBtn.addEventListener("click", () => {
    refetchCurrentUnit(u.id);
  });
}

const EDIT_STAT_KEYS = ["hp", "en", "attack", "defense", "mobility", "movement"];
const EDIT_STAT_LABELS = { hp: "HP", en: "EN", attack: "攻击", defense: "防御", mobility: "机动", movement: "移动" };
const EDIT_TERRAIN = [["space", "宇宙"], ["atmospheric", "大气圈"], ["ground", "地面"], ["surface", "水面"], ["underwater", "水中"]];

function enterUnitEdit(u) {
  const canSp = (u.rarity || 5) < 5 && !(u.tags || []).includes("终极");
  unitEdit = {
    id: u.id,
    role: u.role,
    canSp,
    stats: {
      base: {},
      sp: canSp ? {} : null,
      ssp: canSp ? {} : null,
    },
    terrain: Object.assign({}, u.terrain || {}),
    tags: (u.tags || []).slice(),
    weapons: (u.weapons || []).map((w) => ({
      weapon_id: w.weapon_id, name: w.name, weapon_max_level: w.weapon_max_level,
      attack_attr: w.attack_attr, weapon_attr: w.weapon_attr,
      weapon_attrs: (w.attrs || []).slice(),
      range_min: w.range_min, range_max: w.range_max,
      power_lv5: w.power_lv5, en_lv5: w.en_lv5, hit_lv5: w.hit_lv5, crit_lv5: w.crit_lv5,
      power_lv9: w.power_lv9, en_lv9: w.en_lv9, hit_lv9: w.hit_lv9, crit_lv9: w.crit_lv9,
      effects: (w.effects || []).map((e) => ({ name: e.name, desc: e.desc })),
    })),
    abilities: (u.abilities || []).map((a) => ({
      ability_id: a.ability_id, name: a.name, desc: a.desc,
      ability_type: a.ability_type, traits: a.traits,
    })),
  };
  EDIT_STAT_KEYS.forEach((k) => {
    unitEdit.stats.base[k] = u[`max_${k}`] || 0;
    if (canSp) {
      unitEdit.stats.sp[k] = u[`sp_max_${k}`] || 0;
      unitEdit.stats.ssp[k] = u[`ssp_max_${k}`] || 0;
    }
  });
  renderUnitEditForm();
}

function renderUnitEditForm() {
  /* 编辑模式回单栏全宽，避免被详情弹窗的两栏网格挤压 */
  const _box = $("#modal .modal-box");
  if (_box) _box.classList.remove("modal-detail");
  const s = unitEdit;
  const roleOpts = [[1, "攻击型"], [2, "耐久型"], [3, "支援型"]];
  const attrOpts = [[1, "射击"], [2, "格斗"], [3, "特殊"], [7, "EX"]];
  const dmgOpts = [[1, "实弹"], [2, "光束"], [3, "特殊"], [4, "特殊招式"], [6, "EX"]];
  const statCell = (prefix) => (k) =>
    `<td><input class="edit-input" data-stat="${prefix}" data-k="${k}" value="${s.stats[prefix][k] ?? ""}"></td>`;
  const statRow = (prefix, label) =>
    `<tr><th>${label}</th>${EDIT_STAT_KEYS.map(statCell(prefix)).join("")}</tr>`;
  const tagHtml = s.tags.map((t, i) =>
    `<span class="chip sel-tag">${esc(t)}${t === "终极" ? "" : `<button class="chip-x" aria-label="移除" data-tag-i="${i}" title="删除">×</button>`}</span>`).join("")
    || '<span class="muted">无标签</span>';
  const weaponRows = s.weapons.map((w, wi) => {
    const lv9 = (w.weapon_max_level || 5) >= 9;
    const num = (k, val) => `<input class="edit-input" data-wi="${wi}" data-f="${k}" value="${val ?? ""}">`;
    const attrVal = w.attack_attr in { 4: 1, 5: 1, 6: 1 } ? 3 : w.attack_attr;
    return `<tr>
      <td>${esc(w.name)}</td>
      <td><select class="edit-select" data-wi="${wi}" data-f="attack_attr">${attrOpts.map(([v, lb]) => `<option value="${v}" ${v == (attrVal || 1) ? "selected" : ""}>${lb}</option>`).join("")}</select></td>
      <td><select class="edit-select" data-wi="${wi}" data-f="weapon_attr">${dmgOpts.map(([v, lb]) => `<option value="${v}" ${v == (w.weapon_attr in { 5: 1 } ? 4 : w.weapon_attr) ? "selected" : ""}>${lb}</option>`).join("")}</select></td>
      <td class="edit-row">${[1, 2, 3].map((a) => `<label class="chip sel-tag"><input type="checkbox" data-wi="${wi}" data-a="${a}" ${w.weapon_attrs.includes(a) ? "checked" : ""}>${({1:"实弹",2:"光束",3:"特殊"})[a]}</label>`).join("")}</td>
      <td>${num("range_min", w.range_min)}~${num("range_max", w.range_max)}</td>
      <td>${num("power_lv5", w.power_lv5)}${lv9 ? `<br>lv9 ${num("power_lv9", w.power_lv9)}` : ""}</td>
      <td>${num("en_lv5", w.en_lv5)}${lv9 ? `<br>lv9 ${num("en_lv9", w.en_lv9)}` : ""}</td>
      <td>${num("hit_lv5", w.hit_lv5)}${lv9 ? `<br>lv9 ${num("hit_lv9", w.hit_lv9)}` : ""}</td>
      <td>${num("crit_lv5", w.crit_lv5)}${lv9 ? `<br>lv9 ${num("crit_lv9", w.crit_lv9)}` : ""}</td>
      <td><div class="tags">${w.effects.map((e, ei) => `<span class="chip sel-tag">${esc(e.name)}<button class="chip-x" aria-label="移除" data-wi="${wi}" data-ei="${ei}" title="移除特效">×</button></span>`).join("") || '<span class="muted">无</span>'}</div>
          <button class="cond-btn" data-add-effect="${wi}" style="margin-left:0">添加特效</button></td>
    </tr>`;
  }).join("");
  const abilityHtml = s.abilities.map((a, i) =>
    `<div class="edit-row"><span class="chip cond">${esc(a.name)}</span>
     <button class="edit-remove" aria-label="删除" data-ability-i="${i}" title="删除能力">×</button></div>`).join("")
    || '<span class="muted">无能力</span>';
  const body = `
    <p class="desc">${esc("编辑基础值后，1~3星按公式自动重算；显示值为 基础值 × 星级倍率 × (1+能力加成%)。")}</p>
    <h3>类型</h3>
    <div class="edit-row"><select id="edit-role" class="edit-select">${roleOpts.map(([v, lb]) => `<option value="${v}" ${v == s.role ? "selected" : ""}>${lb}</option>`).join("")}</select></div>
    <h3>属性（0星满级）</h3>
    <table><tr><th></th><th>HP</th><th>EN</th><th>攻击</th><th>防御</th><th>机动</th><th>移动</th></tr>
      ${statRow("base", "0星满级")}
      ${s.stats.sp ? statRow("sp", "SP 满级") : ""}
      ${s.stats.ssp ? statRow("ssp", "SSP 满级") : ""}
    </table>
    ${s.canSp ? "" : '<p class="edit-hint">UR / 终极标签机体不开放 SP、SSP 编辑。</p>'}
    <h3>地形适性</h3>
    <div class="edit-row">${EDIT_TERRAIN.map(([k, lb]) => `<label>${lb} <input class="edit-input" data-terrain="${k}" value="${s.terrain[k] ?? 0}"></label>`).join("")}</div>
    <h3>标签</h3>
    <div class="tags" id="edit-tags">${tagHtml}</div>
    <button id="edit-add-tag" class="cond-btn" style="margin-left:0">添加标签</button>
    <h3>武器（${s.weapons.length}）</h3>
    <table><tr><th>名称</th><th>类别</th><th>伤害</th><th>多伤害集合</th><th>射程</th><th>威力</th><th>EN</th><th>命中</th><th>暴击</th><th>特效</th></tr>${weaponRows}</table>
    <h3>能力（${s.abilities.length}）</h3>
    <div id="edit-abilities">${abilityHtml}</div>
    <button id="edit-add-ability" class="cond-btn" style="margin-left:0">添加能力</button>
    <div class="calc-actions"><button id="edit-cancel" class="cond-btn">取消修改</button></div>
    <span id="edit-msg" class="muted"></span>`;
  $("#modal-body").innerHTML = body;
  bindUnitEditForm();
}

function bindUnitEditForm() {
  const body = $("#modal-body");
  body.querySelectorAll("input[data-stat]").forEach((el) =>
    el.addEventListener("input", () => {
      unitEdit.stats[el.dataset.stat][el.dataset.k] = Number(el.value) || 0;
    }));
  body.querySelectorAll("input[data-terrain]").forEach((el) =>
    el.addEventListener("input", () => {
      unitEdit.terrain[el.dataset.terrain] = Number(el.value) || 0;
    }));
  body.querySelectorAll("input[data-wi][data-a]").forEach((el) =>
    el.addEventListener("change", () => {
      const w = unitEdit.weapons[Number(el.dataset.wi)];
      const a = Number(el.dataset.a);
      if (el.checked) { if (!w.weapon_attrs.includes(a)) w.weapon_attrs.push(a); }
      else w.weapon_attrs = w.weapon_attrs.filter((x) => x !== a);
    }));
  body.querySelectorAll("input[data-wi][data-f]").forEach((el) =>
    el.addEventListener("input", () => {
      unitEdit.weapons[Number(el.dataset.wi)][el.dataset.f] =
        el.value === "" ? null : Number(el.value);
    }));
  body.querySelectorAll("select[data-wi][data-f]").forEach((el) =>
    el.addEventListener("change", () => {
      unitEdit.weapons[Number(el.dataset.wi)][el.dataset.f] = Number(el.value);
    }));
  body.querySelectorAll("[data-ei]").forEach((el) =>
    el.addEventListener("click", () => {
      const w = unitEdit.weapons[Number(el.dataset.wi)];
      w.effects.splice(Number(el.dataset.ei), 1);
      renderUnitEditForm();
    }));
  body.querySelectorAll("[data-add-effect]").forEach((el) =>
    el.addEventListener("click", () => openUnitEffectPicker(Number(el.dataset.addEffect))));
  body.querySelectorAll("[data-ability-i]").forEach((el) =>
    el.addEventListener("click", () => {
      unitEdit.abilities.splice(Number(el.dataset.abilityI), 1);
      renderUnitEditForm();
    }));
  body.querySelectorAll("[data-tag-i]").forEach((el) =>
    el.addEventListener("click", () => {
      unitEdit.tags.splice(Number(el.dataset.tagI), 1);
      renderUnitEditForm();
    }));
  $("#edit-role").addEventListener("change", (e) => { unitEdit.role = Number(e.target.value); });
  $("#edit-cancel").addEventListener("click", () => {
    const uid = unitEdit.id;
    unitEdit = null;
    openUnit(uid);
  });
  $("#edit-add-tag").addEventListener("click", openUnitTagPicker);
  $("#edit-add-ability").addEventListener("click", openUnitAbilityPicker);
}

function currentUnitId() {
  return unitEdit ? unitEdit.id : 0;
}

function buildEditPayload() {
  const s = unitEdit;
  return {
    unit_id: s.id,
    role: s.role,
    max_stats: Object.assign({}, s.stats.base),
    ...(s.stats.sp ? { sp_stats: Object.assign({}, s.stats.sp) } : {}),
    ...(s.stats.ssp ? { ssp_stats: Object.assign({}, s.stats.ssp) } : {}),
    terrain: Object.assign({}, s.terrain),
    tags: s.tags.slice(),
    weapons: s.weapons.map((w) => ({
      weapon_id: w.weapon_id, attack_attr: w.attack_attr,
      weapon_attr: w.weapon_attr, weapon_attrs: w.weapon_attrs.slice(),
      range_min: w.range_min, range_max: w.range_max,
      power_lv5: w.power_lv5, en_lv5: w.en_lv5, hit_lv5: w.hit_lv5, crit_lv5: w.crit_lv5,
      power_lv9: w.power_lv9, en_lv9: w.en_lv9, hit_lv9: w.hit_lv9, crit_lv9: w.crit_lv9,
      weapon_effects: w.effects.slice(),
    })),
    abilities: s.abilities.map((a) => ({
      ability_id: a.ability_id, name: a.name, desc: a.desc,
      ability_type: a.ability_type, traits: a.traits,
    })),
  };
}

async function saveUnitEdit() {
  const msg = $("#edit-msg");
  if (!unitEdit) return;
  const payload = buildEditPayload();
  try {
    const r = await fetch("/api/unit-edit?preview=1", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await r.json();
    if (!res.ok) { if (msg) msg.textContent = res.error || "校验失败"; return; }
    if (!res.changed) { if (msg) msg.textContent = "没有修改"; return; }
    showModal("确认保存修改",
      `<p class="desc">以下为本次修改与本地数据库的差异，确认后将写入本地数据库并记录编辑历史：</p>
       <table><tr><th>项目</th><th>字段</th><th>原值</th><th>新值</th></tr>
       ${(res.diff || []).map((x) => `<tr><td>${esc(x.section)}</td><td>${esc(x.field)}</td><td class="desc">${esc(x.old)}</td><td class="desc">${esc(x.new)}</td></tr>`).join("")}</table>
       <div class="calc-actions"><button id="edit-confirm" class="cond-btn">确认保存</button>
       <button id="edit-confirm-cancel" class="cond-btn">取消</button></div>`);
    $("#edit-confirm").addEventListener("click", async () => {
      $("#modal").classList.add("hidden");
      const r2 = await fetch("/api/unit-edit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const res2 = await r2.json();
      if (!res2.ok) { showModal("保存失败", `<p class="desc">${esc(res2.error || "未知错误")}</p>`); return; }
      const uid = unitEdit.id;
      unitEdit = null;
      openUnit(uid);
    });
    $("#edit-confirm-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  } catch (e) {
    if (msg) msg.textContent = "保存失败：" + (e.message || e);
  }
}

async function openUnitSync(unitId) {
  if (unitEdit) {
    $("#modal").classList.add("hidden");
    showModal("提示", '<p class="desc">还有未保存的修改，请先「保存修改到本地」再同步到服务器。</p>');
    return;
  }
  let d;
  try {
    d = await api(`/api/unit-sync-diff?unit_id=${unitId}`);
  } catch (e) {
    showModal("同步失败", `<p class="desc">${esc(e.message || e)}</p>`);
    return;
  }
  if (!d.ok) {
    showModal("无法同步", `<p class="desc">${esc(d.error || "云端不可用")}</p>`);
    return;
  }
  if (d.identical) {
    showModal("同步机体数据到服务器",
      '<p class="desc" style="color:var(--ok)">本地与服务器该机体数据一致，无需同步。</p>');
    return;
  }
  showModal("同步机体数据到服务器",
    `<p class="desc">以下为本地与服务器该机体的差异。确认后会把本地数据覆盖到服务器（仅这一台机体，其他数据不变）：</p>
     <table><tr><th>项目</th><th>字段</th><th>服务器</th><th>本地</th></tr>
     ${(d.diff || []).map((x) => `<tr><td>${esc(x.section)}</td><td>${esc(x.field)}</td><td class="desc">${esc(x.old)}</td><td class="desc">${esc(x.new)}</td></tr>`).join("")}</table>
     <div class="calc-actions"><button id="unit-sync-confirm" class="cond-btn">确认同步到服务器</button>
     <button id="unit-sync-cancel" class="cond-btn">取消</button></div>`);
  $("#unit-sync-confirm").addEventListener("click", async () => {
    $("#modal").classList.add("hidden");
    try {
      const r = await fetch("/api/unit-sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit_id: unitId }),
      });
      const res = await r.json();
      showModal("同步结果", `<p class="desc">${esc(res.message || res.error || "完成")}</p>`);
    } catch (e) {
      showModal("同步失败", `<p class="desc">${esc(e.message || e)}</p>`);
    }
  });
  $("#unit-sync-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

/* 重新爬取单个机体：抓网页最新 → 对比本地差异 → 确认后以网页数据覆盖本地 → 刷新详情 */
async function refetchCurrentUnit(unitId) {
  if (unitEdit) {
    $("#modal").classList.add("hidden");
    showModal("提示", '<p class="desc">还有未保存的修改，请先「保存修改到本地」再重新爬取。</p>');
    return;
  }
  showModal("正在爬取", '<p class="desc">正在从网站获取最新数据并对比差异，请稍候…</p>');
  let d;
  try {
    d = await api(`/api/refetch-unit-diff?unit_id=${unitId}`);
  } catch (e) {
    showModal("爬取失败", `<p class="desc">${esc(e.message || e)}</p>`);
    return;
  }
  if (!d.ok) {
    showModal("无法爬取", `<p class="desc">${esc(d.error || "未知错误")}</p>`);
    return;
  }
  if (d.identical) {
    showModal("重新爬取机体数据",
      '<p class="desc" style="color:var(--ok)">网页数据与本地完全一致，无需覆盖。</p>');
    return;
  }
  const diffRows = (d.diff || []).map((x) =>
    `<tr><td>${esc(x.section)}</td><td>${esc(x.field)}</td><td class="desc">${esc(x.old)}</td><td class="desc">${esc(x.new)}</td></tr>`).join("");
  showModal("重新爬取机体数据",
    `<p class="desc">以下为网页最新数据与本地数据库的差异（共 ${d.diff.length} 处）。确认后将以网页数据覆盖本地（仅这一台机体，其他数据不变）：</p>
     <table><tr><th>项目</th><th>字段</th><th>本地</th><th>网页</th></tr>${diffRows}</table>
     <div class="calc-actions"><button id="refetch-confirm" class="cond-btn">确认以网页数据覆盖本地</button>
     <button id="refetch-cancel" class="cond-btn">取消</button></div>`);
  $("#refetch-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#refetch-confirm").addEventListener("click", async () => {
    const btn = $("#refetch-confirm");
    btn.disabled = true;
    btn.textContent = "覆盖中…";
    try {
      const r = await api(`/api/refetch-unit-apply?unit_id=${unitId}`);
      if (r.ok) {
        await openUnit(unitId);  /* 刷新详情（详情本身即覆盖成功的反馈） */
        announceLive(`已用网页数据覆盖机体 ${r.name || unitId}`);
      } else {
        showModal("覆盖失败", `<p class="desc">${esc(r.error || "未知错误")}</p>`);
      }
    } catch (e) {
      showModal("覆盖失败", `<p class="desc">${esc(e.message || e)}</p>`);
    }
  });
}

async function openUnitTagPicker() {
  const all = await api("/api/tags?kind=unit");
  showModal("添加标签",
    `<p class="desc">当前机体已有标签：${esc(unitEdit.tags.join("、") || "无")}</p>
     <input id="tag-pick-q" class="edit-input wide" placeholder="搜索标签…">
     <div id="tag-pick-list" class="tags"></div>
     <div class="calc-actions"><button id="tag-pick-ok" class="cond-btn">确定</button>
     <button id="tag-pick-close" class="cond-btn">关闭</button></div>`);
  const list = $("#tag-pick-list");
  const render = () => {
    const kw = $("#tag-pick-q").value.trim();
    list.innerHTML = all.filter((t) => !kw || t.includes(kw)).map((t) =>
      `<label class="chip sel-tag"><input type="checkbox" value="${esc(t)}" ${unitEdit.tags.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")
      || '<div class="empty">无匹配</div>';
  };
  render();
  $("#tag-pick-q").addEventListener("input", render);
  $("#tag-pick-ok").addEventListener("click", () => {
    list.querySelectorAll("input:checked").forEach((el) => {
      const t = el.value;
      if (!unitEdit.tags.includes(t)) unitEdit.tags.push(t);
    });
    renderUnitEditForm();
  });
  $("#tag-pick-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

async function openUnitEffectPicker(wi) {
  const all = await api("/api/weapon-effects");
  showModal("添加武器特效",
    `<input id="eff-pick-q" class="edit-input wide" placeholder="搜索特效…">
     <div id="eff-pick-list" class="tags"></div>
     <div class="calc-actions"><button id="eff-pick-ok" class="cond-btn">确定</button>
     <button id="eff-pick-close" class="cond-btn">关闭</button></div>`);
  const list = $("#eff-pick-list");
  const render = () => {
    const kw = $("#eff-pick-q").value.trim();
    const w = unitEdit.weapons[wi];
    const have = new Set((w.effects || []).map((e) => e.name));
    list.innerHTML = all.filter((x) => !kw || x.name.includes(kw)).map((x) =>
      `<label class="chip sel-tag"><input type="checkbox" value="${esc(x.name)}" ${have.has(x.name) ? "checked" : ""}> ${esc(x.name)}</label>`).join("")
      || '<div class="empty">无匹配</div>';
  };
  render();
  $("#eff-pick-q").addEventListener("input", render);
  $("#eff-pick-ok").addEventListener("click", () => {
    const w = unitEdit.weapons[wi];
    list.querySelectorAll("input:checked").forEach((el) => {
      const item = all.find((x) => x.name === el.value);
      if (item && !w.effects.some((e) => e.name === item.name)) {
        w.effects.push({ name: item.name, desc: item.desc });
      }
    });
    renderUnitEditForm();
  });
  $("#eff-pick-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

async function openUnitAbilityPicker() {
  const all = await api("/api/abilities");
  showModal("添加能力",
    `<input id="ab-pick-q" class="edit-input wide" placeholder="搜索能力…">
     <div id="ab-pick-list" class="tags"></div>
     <div class="calc-actions"><button id="ab-pick-ok" class="cond-btn">确定</button>
     <button id="ab-pick-close" class="cond-btn">关闭</button></div>`);
  const list = $("#ab-pick-list");
  const render = () => {
    const kw = $("#ab-pick-q").value.trim();
    const have = new Set(unitEdit.abilities.map((a) => String(a.ability_id)));
    list.innerHTML = all.filter((x) => !kw || x.name.includes(kw)).map((x) =>
      `<label class="chip sel-tag" ${have.has(String(x.ability_id)) ? 'style="opacity:.5"' : ""}><input type="checkbox" value="${x.ability_id}" ${have.has(String(x.ability_id)) ? "disabled" : ""}> ${esc(x.name)}</label>`).join("")
      || '<div class="empty">无匹配</div>';
  };
  render();
  $("#ab-pick-q").addEventListener("input", render);
  $("#ab-pick-ok").addEventListener("click", () => {
    list.querySelectorAll("input:checked").forEach((el) => {
      const item = all.find((x) => String(x.ability_id) === el.value);
      if (item && !unitEdit.abilities.some((a) => String(a.ability_id) === el.value)) {
        unitEdit.abilities.push({
          ability_id: item.ability_id, name: item.name, desc: item.desc,
          ability_type: item.ability_type, traits: item.traits,
        });
      }
    });
    renderUnitEditForm();
  });
  $("#ab-pick-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

/* ---------- 驾驶员 ---------- */
async function loadCharacters(page = state.characters.page) {
  state.characters.page = page;
  const s = state.characters;
  const q = new URLSearchParams({
    q: s.q, rarity: s.rarity, series: s.series, type: s.type,
    tags: s.tags.join(","), tag_mode: s.tag_mode,
    match: s.match, skills: s.skills.join(","), skill_mode: s.skill_mode,
    support: s.support, sort: s.sort, order: s.order,
    limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/characters?" + q);
  $("#char-count").textContent = `共 ${d.total} 条结果`;
  announceLive(`搜索完成，共找到 ${d.total} 条驾驶员结果`);
  $("#char-list").innerHTML = d.items.length
    ? d.items.map((c) => `
      <div class="list-row chars" data-id="${c.id}">
        <span class="name">${esc(c.name)}</span>
        ${cell(rarityBadge(c.rarity))}
        ${cell(roleBadge(c.role, c.role_label))}
        ${statCellBar(c.ranged_f, "ranged")}${statCellBar(c.melee_f, "melee")}
        ${statCellBar(c.defense_f, "defense")}${statCellBar(c.awaken_f, "awaken")}
        ${statCellBar(c.reaction_f, "reaction")}
        <span class="num">${esc(c.support_label || "")}</span>
      </div>`).join("")
    : '<div class="empty">没有匹配的驾驶员</div>';
  $("#char-list").querySelectorAll(".list-row").forEach((r) =>
    r.addEventListener("click", () => openCharacter(r.dataset.id)));
  pager("char", d.total, s.page, s.size, loadCharacters);
  updateSortArrows("characters");
  applyColWidths("chars");
  applyStagger("#char-list");
}

async function openCharacter(id) {
  charEdit = null;
  const [c, canonical] = await Promise.all([
    api(`/api/characters/${id}`),
    api(`/api/canonical?pilot_id=${id}`),
  ]);
  charView.c = c;
  charView.formKey = "default";
  charView.on.clear();
  const skills = c.skills.map((sk) => `
    <tr><td><button class="link-name" data-type="skill" data-name="${esc(sk.name)}">${esc(sk.name)}</button></td>
      <td>${sk.sp ?? "—"}</td><td>${sk.duration ?? "—"}</td><td class="desc">${effectHtml(sk.effects, sk.desc, sk.cond_entities)}</td></tr>`).join("");
  const abilities = c.abilities.map((a) => `
    <tr><td><button class="link-name" data-type="ability" data-name="${esc(a.name)}">${esc(a.name)}</button></td>
      <td class="desc">${effectHtml(a.effects, a.desc, a.cond_entities)}</td></tr>`).join("");
  const seriesHtml = (c.series_names || []).length
    ? `<div class="tags" style="margin-bottom:10px">${c.series_names.map((s) => `<button class="chip series-chip" data-series-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : "";
  const tagsHtml = (c.tags || []).length
    ? `<div class="tags" style="margin-bottom:10px">${c.tags.map((t) => tagChip(t)).join("")}</div>` : "";
  const noteChips = [
    c.support_label ? `<button class="chip support-chip" data-support="${esc(c.support_label)}">${esc(c.support_label)}</button>` : "",
    c.counter_guard ? `<button class="chip support-chip" data-support="反击援防">反击援防</button>` : "",
  ].filter(Boolean);
  const noteHtml = noteChips.length
    ? `<h3 class="ds-sec">支援 / 备注（点击可搜索）</h3><div class="tags">${noteChips.join("")}</div>` : "";
  const canonicalHtml = canonical && canonical.unit ? canonicalJumpHtml("pilot", canonical.unit, id) : "";
  const summaryHtml = `
    <div class="ds-role-row">${roleBadge(c.role, c.role_label)} ${rarityBadge(c.rarity)}</div>
    ${canonicalHtml}
    <div class="ds-desc">${esc(c.desc || "暂无描述")}</div>
    ${seriesHtml}${tagsHtml}
    <div id="char-attr"></div>
    ${noteHtml}`;
  const contentHtml = `
    <h3>技能（${c.skills.length}）</h3>
    <table><tr><th>名称</th><th>SP</th><th>持续</th><th>效果</th></tr>${skills || '<tr><td colspan="4" class="empty">无</td></tr>'}</table>
    <h3>能力（${c.abilities.length}）</h3>
    <table><tr><th>名称</th><th>效果</th></tr>${abilities || '<tr><td colspan="2" class="empty">无</td></tr>'}</table>`;
  showModal(`${esc(c.name)}<span class="char-edit-btns">
       <button id="char-edit-btn" class="cond-btn" title="进入编辑模式">修改驾驶员数据</button>
       <button id="char-save-btn" class="cond-btn" title="保存修改到本地">保存修改到本地</button>
       <button id="char-sync-btn" class="cond-btn" title="同步该驾驶员数据到服务器">同步驾驶员数据到服务器</button>
       <button id="char-refetch-btn" class="cond-btn" title="重新从网站爬取该驾驶员数据并对比差异，确认后以网页数据覆盖本地">重新爬取</button>
     </span>`,
    `<div class="detail-summary">${summaryHtml}</div><div class="detail-content">${contentHtml}</div>`);
  const box = $("#modal .modal-box");
  if (box) box.classList.add("modal-detail");
  renderCharAttr();
  bindCharAttr();
  bindTagChips();
  bindSearchLinks();
  bindEffectChips();
  bindCharInfoChips();
  bindCharacterEditButtons(c);
}

/* ---------- 驾驶员详情属性区：默认/SP 切换 + 达成条件开关（与机体一致） ---------- */
const charView = { c: null, formKey: "default", on: new Set() };

function charForm() {
  return charView.c.forms[charView.formKey] || charView.c.forms.default;
}

/* 当前形态下可用的条件加成行（角色的条件加成按 values 区分形态） */
function charCondRows() {
  const fk = charView.formKey;
  return (charView.c.conditional_bonuses || []).filter((r) => r.values?.[fk] != null);
}

function charCondNames(rows) {
  const out = [];
  for (const r of rows) if (!out.includes(r.name)) out.push(r.name);
  return out;
}

function charPruneCond() {
  const avail = new Set(charCondNames(charCondRows()));
  for (const name of [...charView.on]) if (!avail.has(name)) charView.on.delete(name);
}

/* 某属性当前选中的加成%；同 stat 有 HP 区间冲突时取最大，否则求和 */
function charCondPct(stat) {
  const sel = charCondRows().filter((r) => r.stat === stat && charView.on.has(r.name));
  if (!sel.length) return 0;
  let compat = true;
  outer:
  for (let i = 0; i < sel.length; i++) {
    for (let j = i + 1; j < sel.length; j++) {
      const a = sel[i], b = sel[j];
      if (!a.has_hp_cond || !b.has_hp_cond) continue;
      const au = a.hp_lte > 0 ? a.hp_lte : 100;
      const bu = b.hp_lte > 0 ? b.hp_lte : 100;
      if ((a.hp_gte || 0) > bu || (b.hp_gte || 0) > au) { compat = false; break outer; }
    }
  }
  if (compat) return sel.reduce((s, r) => s + (r.pct || 0), 0);
  return Math.max(...sel.map((r) => r.pct || 0));
}

function charStatVal(key) {
  const st = charForm().stats[key];
  const base = st.max - (st.max_bonus || 0);
  const basePct = (charView.c.stat_bonuses || {})[key] || 0;
  const condPct = charCondPct(key);
  const final = Math.floor(base * (100 + basePct + condPct) / 100);
  return { final, delta: final - base };
}

function charCondRowHtml(rows, names) {
  const chips = names.map((name) => {
    const rs = rows.filter((r) => r.name === name);
    const effect = rs.map((r) => `${CHAR_STAT_LABELS[r.stat] || r.stat} +${r.pct}%`).join("，");
    const conds = [...new Set(rs.map((r) => r.condition).filter(Boolean))].join("；");
    const tip = [
      conds ? `条件：${conds}` : "",
      effect ? `效果：${effect}` : "",
      name ? `能力：${name}` : "",
    ].filter(Boolean).join("\n");
    return `<button class="chip cond-chip${charView.on.has(name) ? " on" : ""}" data-name="${esc(name)}" title="${esc(tip)}">${esc(name)}</button>`;
  }).join("");
  return `<div class="cond-row"><span class="star-label">达成条件</span><div class="tags">${chips}</div></div>`;
}

const CHAR_STAT_ORDER = ["ranged", "melee", "defense", "awaken", "reaction"];

function renderCharAttr() {
  const wrap = $("#char-attr");
  if (!wrap) return;
  const c = charView.c;
  const form = charForm();
  const formBtns = c.has_sp
    ? `<span class="star-label">形态</span>` + [
        ["default", `默认(${c.forms.default.level_cap}级)`],
        ["sp", "SP(100级)"],
      ].map(([fk, label]) =>
        `<button class="form-btn ${charView.formKey === fk ? "active" : ""}" data-form="${fk}">${label}</button>`).join("")
    : "";
  const rows = charCondRows();
  const names = charCondNames(rows);
  const notes = [];
  if (!c.has_sp) notes.push("驾驶员没有星级；UR 驾驶员暂不开放 SP 形态。");
  else notes.push("驾驶员没有星级；默认形态为稀有度等级上限，SP 后满级 100。");
  notes.push(names.length ? "绿色 +N 为能力加成；点选「达成条件」会将对应加成并入数值。" : "绿色 +N 为能力加成。");
  const cells = CHAR_STAT_ORDER.map((key) => {
    const v = charStatVal(key);
    return `<div class="ds-stat">
      <span class="ds-k">${CHAR_STAT_LABELS[key]}</span>
      <span class="ds-v">${fmtNum(v.final)}${v.delta ? `<small>+${fmtNum(v.delta)}</small>` : ""}</span>
    </div>`;
  }).join("");
  wrap.innerHTML = `
    <h3 class="ds-sec">属性（满级）</h3>
    ${formBtns ? `<div class="star-bar">${formBtns}</div>` : ""}
    <div class="star-bar"><span class="cap-chip">满级上限 ${form.level_cap}</span></div>
    ${names.length ? charCondRowHtml(rows, names) : ""}
    <div class="ds-stats">${cells}</div>
    <p class="hint">${notes.map(esc).join(" ")}</p>`;
}

/* 属性区整体重建，委托只需在 #char-attr 上挂一次 */
function bindCharAttr() {
  const box = $("#char-attr");
  if (!box || box._cvBound) return;
  box._cvBound = true;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".form-btn,.cond-chip");
    if (!btn || !box.contains(btn)) return;
    if (btn.classList.contains("form-btn")) return charSetForm(btn.dataset.form);
    return charToggleCond(btn.dataset.name);
  });
}

function charSetForm(fk) {
  if (!charView.c.forms[fk]) return;
  charView.formKey = fk;
  charPruneCond();
  renderCharAttr();
}

function charToggleCond(name) {
  if (charView.on.has(name)) charView.on.delete(name); else charView.on.add(name);
  renderCharAttr();
}

function bindCharInfoChips() {
  document.querySelectorAll(".series-chip").forEach((b) =>
    b.addEventListener("click", () => searchCharactersBySeries(Number(b.dataset.seriesId))));
  document.querySelectorAll(".support-chip").forEach((b) =>
    b.addEventListener("click", () => searchCharactersBySupport(b.dataset.support)));
}

/* ---------- 驾驶员数据编辑 ---------- */
let charEdit = null;
const CHAR_ROLE_OPTS = [[1, "攻击型"], [2, "耐久型"], [3, "支援型"]];
const CHAR_RARITY_OPTS = [[5, "UR"], [4, "SSR"], [3, "SR"], [2, "R"], [1, "N"]];
const CHAR_STAT_KEYS = ["ranged", "melee", "defense", "reaction", "awaken"];
const CHAR_STAT_LABELS = { ranged: "射击", melee: "格斗", defense: "防御", reaction: "反应", awaken: "觉醒" };
const CHAR_SKILL_FIELDS = ["character_skill_id", "level", "name", "desc", "sp", "duration", "is_auto_usage", "auto_usage_priority", "traits"];
const CHAR_ABILITY_FIELDS = ["ability_id", "level", "name", "desc", "ability_type", "traits"];
const _pickKeys = (o, ks) => { const r = {}; for (const k of ks) if (o[k] !== undefined) r[k] = o[k]; return r; };

function bindCharacterEditButtons(c) {
  const editBtn = $("#char-edit-btn");
  const saveBtn = $("#char-save-btn");
  const syncBtn = $("#char-sync-btn");
  const refetchBtn = $("#char-refetch-btn");
  if (editBtn) editBtn.addEventListener("click", () => enterCharacterEdit(c));
  if (saveBtn) saveBtn.addEventListener("click", () => saveCharacterEdit());
  if (syncBtn) syncBtn.addEventListener("click", () => openCharSync(c.id));
  if (refetchBtn) refetchBtn.addEventListener("click", () => refetchCurrentChar(c.id));
}

function enterCharacterEdit(c) {
  const hasSp = (c.rarity || 5) < 5;
  charEdit = {
    id: c.id,
    name: c.name,
    role: c.role || 1,
    rarity: c.rarity || 5,
    desc: c.desc || "",
    tags: (c.tags || []).slice(),
    stats: {
      default: {
        ranged: c.max_ranged || 0, melee: c.max_melee || 0, defense: c.max_defense || 0,
        reaction: c.max_reaction || 0, awaken: c.max_awaken || 0,
      },
      sp: hasSp ? {
        ranged: c.sp_max_ranged || 0, melee: c.sp_max_melee || 0, defense: c.sp_max_defense || 0,
        reaction: c.sp_max_reaction || 0, awaken: c.sp_max_awaken || 0,
      } : null,
    },
    skills: (c.skills || []).map((s) => _pickKeys(s, CHAR_SKILL_FIELDS)),
    abilities: (c.abilities || []).map((a) => _pickKeys(a, CHAR_ABILITY_FIELDS)),
  };
  renderCharacterEditForm();
}

function charNum(el) {
  return el.value === "" ? null : Number(el.value) || 0;
}

function renderCharacterEditForm() {
  /* 编辑模式回单栏全宽，避免被详情弹窗的两栏网格挤压 */
  const _box = $("#modal .modal-box");
  if (_box) _box.classList.remove("modal-detail");
  const s = charEdit;
  const statCell = (prefix) => (k) =>
    `<td><input class="edit-input" data-stat="${prefix}" data-k="${k}" type="number" value="${s.stats[prefix][k] ?? ""}"></td>`;
  const statRow = (prefix, label) =>
    `<tr><th>${label}</th>${CHAR_STAT_KEYS.map(statCell(prefix)).join("")}</tr>`;
  const tagHtml = s.tags.map((t, i) =>
    `<span class="chip sel-tag">${esc(t)}<button class="chip-x" aria-label="移除" data-tag-i="${i}" title="删除">×</button></span>`).join("")
    || '<span class="muted">无标签</span>';
  const skillRows = s.skills.map((sk, i) => `
    <tr>
      <td><input class="edit-input" style="width:150px" data-skill="${i}" data-f="name" value="${esc(sk.name ?? "")}"></td>
      <td><input class="edit-input" data-skill="${i}" data-f="sp" type="number" value="${sk.sp ?? ""}"></td>
      <td><input class="edit-input" data-skill="${i}" data-f="duration" type="number" value="${sk.duration ?? ""}"></td>
      <td><textarea class="edit-input" rows="2" data-skill="${i}" data-f="desc">${esc(sk.desc ?? "")}</textarea></td>
      <td><button class="edit-remove" aria-label="删除技能" data-skill-del="${i}" title="删除技能">×</button></td>
    </tr>`).join("");
  const abilityRows = s.abilities.map((a, i) => `
    <tr>
      <td><input class="edit-input" style="width:150px" data-ability="${i}" data-f="name" value="${esc(a.name ?? "")}"></td>
      <td><textarea class="edit-input" rows="2" data-ability="${i}" data-f="desc">${esc(a.desc ?? "")}</textarea></td>
      <td><button class="edit-remove" aria-label="删除能力" data-ability-del="${i}" title="删除能力">×</button></td>
    </tr>`).join("");
  const body = `
    <p class="desc">${esc("正在编辑驾驶员「" + s.name + "」。修改完成后点标题上的「保存修改到本地」提交，会先预览差异。")}</p>
    <h3>类型 / 稀有度</h3>
    <div class="edit-row">
      <label>类型
        <select id="edit-role" class="edit-select">${CHAR_ROLE_OPTS.map(([v, lb]) => `<option value="${v}" ${v == s.role ? "selected" : ""}>${lb}</option>`).join("")}</select>
      </label>
      <label>稀有度
        <select id="edit-rarity" class="edit-select">${CHAR_RARITY_OPTS.map(([v, lb]) => `<option value="${v}" ${v == s.rarity ? "selected" : ""}>${lb}</option>`).join("")}</select>
      </label>
    </div>
    <h3>属性（满级）</h3>
    <table><tr><th></th>${CHAR_STAT_KEYS.map((k) => `<th>${CHAR_STAT_LABELS[k]}</th>`).join("")}</tr>
      ${statRow("default", "默认")}
      ${s.stats.sp ? statRow("sp", "SP 满级") : ""}
    </table>
    ${s.stats.sp ? "" : '<p class="edit-hint">UR 驾驶员不开放 SP 形态属性编辑。</p>'}
    <h3>标签</h3>
    <div class="tags" id="edit-tags">${tagHtml}</div>
    <button id="edit-add-tag" class="cond-btn" style="margin-left:0">添加标签</button>
    <h3>描述</h3>
    <textarea id="edit-desc" class="edit-input wide" style="width:100%;min-height:60px" rows="3">${esc(s.desc)}</textarea>
    <h3>技能（${s.skills.length}）</h3>
    ${s.skills.length ? `<table><tr><th>名称</th><th>SP</th><th>持续</th><th>效果描述</th><th></th></tr>${skillRows}</table>` : '<div class="empty">无技能</div>'}
    <button id="edit-add-skill" class="cond-btn" style="margin-left:0">添加技能</button>
    <h3>能力（${s.abilities.length}）</h3>
    ${s.abilities.length ? `<table><tr><th>名称</th><th>描述</th><th></th></tr>${abilityRows}</table>` : '<div class="empty">无能力</div>'}
    <button id="edit-add-ability" class="cond-btn" style="margin-left:0">从全库能力选择…</button>
    <button id="edit-add-ability-manual" class="cond-btn" style="margin-left:0">添加空能力</button>
    <div class="calc-actions"><button id="edit-cancel" class="cond-btn">取消修改</button></div>
    <span id="edit-msg" class="muted"></span>`;
  $("#modal-body").innerHTML = body;
  bindCharacterEditForm();
}

function bindCharacterEditForm() {
  const body = $("#modal-body");
  body.querySelectorAll("input[data-stat]").forEach((el) =>
    el.addEventListener("input", () => {
      charEdit.stats[el.dataset.stat][el.dataset.k] = charNum(el) || 0;
    }));
  body.querySelectorAll("[data-tag-i]").forEach((el) =>
    el.addEventListener("click", () => {
      charEdit.tags.splice(Number(el.dataset.tagI), 1);
      renderCharacterEditForm();
    }));
  body.querySelectorAll("[data-skill]").forEach((el) =>
    el.addEventListener("input", () => {
      const sk = charEdit.skills[Number(el.dataset.skill)];
      const f = el.dataset.f;
      if (["sp", "duration", "level"].includes(f)) sk[f] = charNum(el);
      else sk[f] = el.value;
    }));
  body.querySelectorAll("[data-ability]").forEach((el) =>
    el.addEventListener("input", () => {
      const a = charEdit.abilities[Number(el.dataset.ability)];
      a[el.dataset.f] = el.value;
    }));
  body.querySelectorAll("[data-skill-del]").forEach((el) =>
    el.addEventListener("click", () => {
      charEdit.skills.splice(Number(el.dataset.skillDel), 1);
      renderCharacterEditForm();
    }));
  body.querySelectorAll("[data-ability-del]").forEach((el) =>
    el.addEventListener("click", () => {
      charEdit.abilities.splice(Number(el.dataset.abilityDel), 1);
      renderCharacterEditForm();
    }));
  const roleEl = $("#edit-role");
  if (roleEl) roleEl.addEventListener("change", (e) => {
    charEdit.role = Number(e.target.value);
  });
  const rarityEl = $("#edit-rarity");
  if (rarityEl) rarityEl.addEventListener("change", (e) => {
    charEdit.rarity = Number(e.target.value);
    if (charEdit.rarity < 5 && !charEdit.stats.sp) {
      charEdit.stats.sp = {};
      CHAR_STAT_KEYS.forEach((k) => { charEdit.stats.sp[k] = charEdit.stats.default[k]; });
    } else if (charEdit.rarity >= 5) {
      charEdit.stats.sp = null;
    }
    renderCharacterEditForm();
  });
  const descEl = $("#edit-desc");
  if (descEl) descEl.addEventListener("input", (e) => { charEdit.desc = e.target.value; });
  const cancel = $("#edit-cancel");
  if (cancel) cancel.addEventListener("click", () => {
    const cid = charEdit.id;
    charEdit = null;
    openCharacter(cid);
  });
  const addTag = $("#edit-add-tag");
  if (addTag) addTag.addEventListener("click", openCharTagPicker);
  const addSkill = $("#edit-add-skill");
  if (addSkill) addSkill.addEventListener("click", () => {
    charEdit.skills.push({ name: "", desc: "", traits: "[]" });
    renderCharacterEditForm();
  });
  const addAbility = $("#edit-add-ability");
  if (addAbility) addAbility.addEventListener("click", openCharAbilityPicker);
  const addAbilityManual = $("#edit-add-ability-manual");
  if (addAbilityManual) addAbilityManual.addEventListener("click", () => {
    charEdit.abilities.push({ name: "", desc: "", traits: "[]" });
    renderCharacterEditForm();
  });
}

function buildCharacterEditPayload() {
  const s = charEdit;
  return {
    character_id: s.id,
    role: s.role,
    rarity: s.rarity,
    desc: s.desc || "",
    tags: s.tags.slice(),
    stats: {
      default: Object.assign({}, s.stats.default),
      sp: s.stats.sp ? Object.assign({}, s.stats.sp) : null,
    },
    skills: s.skills.map((sk) => _pickKeys(sk, CHAR_SKILL_FIELDS)),
    abilities: s.abilities.map((a) => _pickKeys(a, CHAR_ABILITY_FIELDS)),
  };
}

async function saveCharacterEdit() {
  const msg = $("#edit-msg");
  if (!charEdit) return;
  const payload = buildCharacterEditPayload();
  try {
    const r = await fetch("/api/char-edit?preview=1", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await r.json();
    if (!res.ok) { if (msg) msg.textContent = res.error || "校验失败"; return; }
    if (!res.changed) { if (msg) msg.textContent = "没有修改"; return; }
    showModal("确认保存修改",
      `<p class="desc">以下为本次修改与本地数据库的差异，确认后将写入本地数据库并记录编辑历史：</p>
       <table><tr><th>项目</th><th>字段</th><th>原值</th><th>新值</th></tr>
       ${(res.diff || []).map((x) => `<tr><td>${esc(x.section)}</td><td>${esc(x.field)}</td><td class="desc">${esc(x.old)}</td><td class="desc">${esc(x.new)}</td></tr>`).join("")}</table>
       <div class="calc-actions"><button id="edit-confirm" class="cond-btn">确认保存</button>
       <button id="edit-confirm-cancel" class="cond-btn">取消</button></div>`);
    $("#edit-confirm").addEventListener("click", async () => {
      $("#modal").classList.add("hidden");
      const r2 = await fetch("/api/char-edit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const res2 = await r2.json();
      if (!res2.ok) { showModal("保存失败", `<p class="desc">${esc(res2.error || "未知错误")}</p>`); return; }
      const cid = charEdit.id;
      charEdit = null;
      openCharacter(cid);
    });
    $("#edit-confirm-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  } catch (e) {
    if (msg) msg.textContent = "保存失败：" + (e.message || e);
  }
}

async function openCharSync(charId) {
  if (charEdit) {
    $("#modal").classList.add("hidden");
    showModal("提示", '<p class="desc">还有未保存的修改，请先「保存修改到本地」再同步到服务器。</p>');
    return;
  }
  let d;
  try {
    d = await api(`/api/char-sync-diff?char_id=${charId}`);
  } catch (e) {
    showModal("同步失败", `<p class="desc">${esc(e.message || e)}</p>`);
    return;
  }
  if (!d.ok) {
    showModal("无法同步", `<p class="desc">${esc(d.error || "云端不可用")}</p>`);
    return;
  }
  if (d.identical) {
    showModal("同步驾驶员数据到服务器",
      '<p class="desc" style="color:var(--ok)">本地与服务器该驾驶员数据一致，无需同步。</p>');
    return;
  }
  showModal("同步驾驶员数据到服务器",
    `<p class="desc">以下为本地与服务器该驾驶员的差异。确认后会把本地数据覆盖到服务器（仅这一个驾驶员，其他数据不变）：</p>
     <table><tr><th>项目</th><th>字段</th><th>服务器</th><th>本地</th></tr>
     ${(d.diff || []).map((x) => `<tr><td>${esc(x.section)}</td><td>${esc(x.field)}</td><td class="desc">${esc(x.old)}</td><td class="desc">${esc(x.new)}</td></tr>`).join("")}</table>
     <div class="calc-actions"><button id="char-sync-confirm" class="cond-btn">确认同步到服务器</button>
     <button id="char-sync-cancel" class="cond-btn">取消</button></div>`);
  $("#char-sync-confirm").addEventListener("click", async () => {
    $("#modal").classList.add("hidden");
    try {
      const r = await fetch("/api/char-sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ char_id: charId }),
      });
      const res = await r.json();
      showModal("同步结果", `<p class="desc">${esc(res.message || res.error || "完成")}</p>`);
    } catch (e) {
      showModal("同步失败", `<p class="desc">${esc(e.message || e)}</p>`);
    }
  });
  $("#char-sync-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

/* 重新爬取单驾驶员：抓网页最新 → 对比本地差异 → 确认后以网页数据覆盖本地 → 刷新详情 */
async function refetchCurrentChar(charId) {
  if (charEdit) {
    $("#modal").classList.add("hidden");
    showModal("提示", '<p class="desc">还有未保存的修改，请先「保存修改到本地」再重新爬取。</p>');
    return;
  }
  showModal("正在爬取", '<p class="desc">正在从网站获取最新数据并对比差异，请稍候…</p>');
  let d;
  try {
    d = await api(`/api/refetch-char-diff?char_id=${charId}`);
  } catch (e) {
    showModal("爬取失败", `<p class="desc">${esc(e.message || e)}</p>`);
    return;
  }
  if (!d.ok) {
    showModal("无法爬取", `<p class="desc">${esc(d.error || "未知错误")}</p>`);
    return;
  }
  if (d.identical) {
    showModal("重新爬取驾驶员数据",
      '<p class="desc" style="color:var(--ok)">网页数据与本地完全一致，无需覆盖。</p>');
    return;
  }
  const diffRows = (d.diff || []).map((x) =>
    `<tr><td>${esc(x.section)}</td><td>${esc(x.field)}</td><td class="desc">${esc(x.old)}</td><td class="desc">${esc(x.new)}</td></tr>`).join("");
  showModal("重新爬取驾驶员数据",
    `<p class="desc">以下为网页最新数据与本地数据库的差异（共 ${d.diff.length} 处）。确认后将以网页数据覆盖本地（仅这一个驾驶员，其他数据不变）：</p>
     <table><tr><th>项目</th><th>字段</th><th>本地</th><th>网页</th></tr>${diffRows}</table>
     <div class="calc-actions"><button id="refetch-confirm" class="cond-btn">确认以网页数据覆盖本地</button>
     <button id="refetch-cancel" class="cond-btn">取消</button></div>`);
  $("#refetch-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#refetch-confirm").addEventListener("click", async () => {
    const btn = $("#refetch-confirm");
    btn.disabled = true;
    btn.textContent = "覆盖中…";
    try {
      const r = await api(`/api/refetch-char-apply?char_id=${charId}`);
      if (r.ok) {
        await openCharacter(charId);  /* 刷新详情（详情本身即覆盖成功的反馈） */
        announceLive(`已用网页数据覆盖驾驶员 ${r.name || charId}`);
      } else {
        showModal("覆盖失败", `<p class="desc">${esc(r.error || "未知错误")}</p>`);
      }
    } catch (e) {
      showModal("覆盖失败", `<p class="desc">${esc(e.message || e)}</p>`);
    }
  });
}

async function openCharTagPicker() {
  const all = await api("/api/tags?kind=character");
  showModal("添加标签",
    `<p class="desc">当前驾驶员已有标签：${esc(charEdit.tags.join("、") || "无")}</p>
     <input id="tag-pick-q" class="edit-input wide" placeholder="搜索标签…">
     <div id="tag-pick-list" class="tags"></div>
     <div class="calc-actions"><button id="tag-pick-ok" class="cond-btn">确定</button>
     <button id="tag-pick-close" class="cond-btn">关闭</button></div>`);
  const list = $("#tag-pick-list");
  const render = () => {
    const kw = $("#tag-pick-q").value.trim();
    list.innerHTML = all.filter((t) => !kw || t.includes(kw)).map((t) =>
      `<label class="chip sel-tag"><input type="checkbox" value="${esc(t)}" ${charEdit.tags.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")
      || '<div class="empty">无匹配</div>';
  };
  render();
  $("#tag-pick-q").addEventListener("input", render);
  $("#tag-pick-ok").addEventListener("click", () => {
    list.querySelectorAll("input:checked").forEach((el) => {
      const t = el.value;
      if (!charEdit.tags.includes(t)) charEdit.tags.push(t);
    });
    renderCharacterEditForm();
  });
  $("#tag-pick-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

async function openCharAbilityPicker() {
  const all = await api("/api/abilities");
  showModal("添加能力",
    `<p class="desc">从全库能力中选择（该库为全库能力汇总，驾驶员专属能力若不在其中可用「添加空能力」手动录入）。</p>
     <input id="ab-pick-q" class="edit-input wide" placeholder="搜索能力…">
     <div id="ab-pick-list" class="tags"></div>
     <div class="calc-actions"><button id="ab-pick-ok" class="cond-btn">确定</button>
     <button id="ab-pick-close" class="cond-btn">关闭</button></div>`);
  const list = $("#ab-pick-list");
  const render = () => {
    const kw = $("#ab-pick-q").value.trim();
    const have = new Set(charEdit.abilities.map((a) => String(a.ability_id)).filter(Boolean));
    list.innerHTML = all.filter((x) => !kw || x.name.includes(kw)).map((x) =>
      `<label class="chip sel-tag" ${have.has(String(x.ability_id)) ? 'style="opacity:.5"' : ""}><input type="checkbox" value="${x.ability_id}" ${have.has(String(x.ability_id)) ? "disabled" : ""}> ${esc(x.name)}</label>`).join("")
      || '<div class="empty">无匹配</div>';
  };
  render();
  $("#ab-pick-q").addEventListener("input", render);
  $("#ab-pick-ok").addEventListener("click", () => {
    list.querySelectorAll("input:checked").forEach((el) => {
      const item = all.find((x) => String(x.ability_id) === el.value);
      if (item && !charEdit.abilities.some((a) => String(a.ability_id) === String(item.ability_id))) {
        charEdit.abilities.push(_pickKeys(item, CHAR_ABILITY_FIELDS));
      }
    });
    renderCharacterEditForm();
  });
  $("#ab-pick-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

function searchCharactersBySeries(seriesId) {
  $("#modal").classList.add("hidden");
  state.characters.q = "";
  state.characters.series = String(seriesId);
  state.characters.type = "";
  state.characters.tags = [];
  state.characters.skills = [];
  state.characters.support = "";
  $("#char-q").value = "";
  $("#char-type").value = "";
  $("#char-support").value = "";
  syncCombobox("#char-series-box");
  renderTagChips("char");
  renderSkillChips();
  activateTab("characters");
  loadCharacters(0);
}

function searchCharactersBySupport(label) {
  $("#modal").classList.add("hidden");
  state.characters.q = "";
  state.characters.series = "";
  state.characters.type = "";
  state.characters.tags = [];
  state.characters.skills = [];
  state.characters.support = label;
  $("#char-q").value = "";
  $("#char-type").value = "";
  $("#char-support").value = label;
  syncCombobox("#char-series-box");
  renderTagChips("char");
  renderSkillChips();
  activateTab("characters");
  loadCharacters(0);
}

/* ---------- 支援角色 ---------- */
async function loadSupporters(page = state.supporters.page) {
  state.supporters.page = page;
  const s = state.supporters;
  const q = new URLSearchParams({
    q: s.q, tags: s.tags.join(","), tag_mode: s.tag_mode,
    skills: s.skills.join(","), skill_mode: s.skill_mode,
    sort: s.sort, order: s.order,
    limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/supporters?" + q);
  $("#sup-count").textContent = `共 ${d.total} 条结果`;
  announceLive(`搜索完成，共找到 ${d.total} 条支援角色结果`);
  const route = { 1: "扭蛋", 2: "活动", 3: "商店", 4: "其他" };
  renderSupSkillChips();
  $("#sup-list").innerHTML = d.items.length
    ? d.items.map((x) => `
      <div class="list-row sups" data-id="${x.id}">
        <span class="name">${esc(x.name)}</span>
        ${cell(rarityBadge(x.rarity))}
        <span class="sup-tags-cell">${(x.condition_tags || []).map((c) =>
          `<span class="chip cond">${esc(c.text)}${condModeLabel(c.mode)}</span>`).join("") || "—"}</span>
        <span>${esc(x.active_skill || "—")}</span>
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
  applyStagger("#sup-list");
}

async function openSupporter(id) {
  const s = await api(`/api/supporters/${id}`);
  currentSupporter = s;
  const maxStep = s.leader_skills.length
    ? s.leader_skills[s.leader_skills.length - 1].step
    : 0;
  showModal(s.name,
    `<p class="desc">${esc(s.obtained_word || s.desc || "暂无描述")}</p>
     <h3>加成</h3>
     <table><tr><th>最大 HP 加成</th><th>最大攻击加成</th><th>稀有度</th></tr>
       <tr id="sup-add-row"><td class="mono" id="sup-add-hp">+${(s.add_by_step && s.add_by_step.length) ? s.add_by_step[s.add_by_step.length-1].hp : (s.max_hp_addition_value||0)}</td>
         <td class="mono" id="sup-add-atk">+${(s.add_by_step && s.add_by_step.length) ? s.add_by_step[s.add_by_step.length-1].atk : (s.max_attack_addition_value||0)}</td>
         <td>${rarityBadge(s.rarity)}</td></tr></table>
     <h3>主动技能</h3>
     ${(s.active_skills || []).length ? `<div class="skills">${s.active_skills.map((a) => `
       <div class="skill-block">
         <div class="skill-name">${esc(a.name)}${a.is_auto_usage ? '<span class="chip">自动使用</span>' : ""}</div>
         <div class="skill-desc">${esc(a.desc || "—")}</div>
       </div>`).join("")}</div>` : '<div class="empty">暂无主动技能</div>'}
     <h3>队长技能</h3>
     <div class="star-bar" id="sup-lb-bar">
       <span class="star-label">突破</span>
       ${s.leader_skills.map((ls) =>
         `<button class="star-btn ${ls.step === maxStep ? "active" : ""}" data-step="${ls.step}">突破 ${ls.step}</button>`).join("")}
       <span class="cap-chip">默认显示满突破</span>
     </div>
     <div id="sup-leader-body"></div>
     <h3 class="cond-head">词条对象（点击直接在机体中搜索）<button id="sup-all-targets" class="cond-btn" title="显示该支援角色所有可加成机体（各分支的并集）">显示所有影响对象</button></h3>
     <div class="tags">${(s.cond_groups || []).map((g, i) =>
       `${i ? '<span class="cond-or">或</span>' : ""}<button class="chip sup-cond" data-branch="${i}" title="点击搜索该分支的机体">${esc(g.text)}${condModeLabel(g.mode)}</button>`).join("") || '<span class="muted">无条件</span>'}</div>`);
  renderSupporterLeaderStep(maxStep);
  bindSupporterLeaderBar();
  bindSupporterConds();
}

function renderSupporterLeaderStep(step) {
  const s = currentSupporter;
  if (!s) return;
  const ls = s.leader_skills.find((x) => x.step === Number(step))
    || s.leader_skills[s.leader_skills.length - 1];
  const body = $("#sup-leader-body");
  if (!ls) {
    body.innerHTML = '<div class="empty">暂无队长技能</div>';
    return;
  }
  body.innerHTML = ls.branches.map((b, i) => {
    const subs = (b.subs && b.subs.length)
      ? b.subs
      : [{ text: b.text, mode: b.mode, series: b.series, tags: b.tags }];
    const chips = subs.map((sd, si) =>
      `<button class="chip sup-branch" data-branch="${i}" data-sub="${si}" title="点击搜索该分支的机体">${esc(sd.text)}${condModeLabel(sd.mode)}</button>`
    ).join('<span class="cond-or">或</span>');
    return `<div class="effect-block">
      <div class="effect">${esc(b.desc)}</div>
      <div class="tags">${chips}</div>
    </div>`;
  }).join("") || '<div class="empty">暂无加成分支</div>';
  body.querySelectorAll(".sup-branch").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const br = ls.branches[Number(b.dataset.branch)];
      const g = (br && br.subs && br.subs.length)
        ? br.subs[Number(b.dataset.sub)]
        : br;
      if (g) searchUnitsByCond([condToBranch(g)]);
    }));
}

function bindSupporterLeaderBar() {
  document.querySelectorAll("#sup-lb-bar .star-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#sup-lb-bar .star-btn").forEach((x) =>
        x.classList.toggle("active", x === b));
      const step = Number(b.dataset.step);
      renderSupporterLeaderStep(step);
      renderSupporterAddRow(step);
    }));
}

function renderSupporterAddRow(step) {
  const s = currentSupporter;
  if (!s || !s.add_by_step || !s.add_by_step.length) return;
  const rec = s.add_by_step.find((x) => x.step === step)
    || s.add_by_step[s.add_by_step.length - 1];
  const hpEl = $("#sup-add-hp");
  const atkEl = $("#sup-add-atk");
  if (hpEl) hpEl.textContent = `+${rec.hp}`;
  if (atkEl) atkEl.textContent = `+${rec.atk}`;
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
  announceLive(`搜索完成，共找到 ${d.total} 条结果`);
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
  applyStagger("#sr-result");
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

/* ---------- 关卡敌人 ---------- */
async function loadStages(page = state.stages.page) {
  state.stages.page = page;
  const s = state.stages;
  const d = await api(`/api/stages?q=${encodeURIComponent(s.q)}&limit=${s.size}&offset=${s.page * s.size}`);
  $("#stage-count").textContent = `共 ${d.total} 条结果`;
  announceLive(`搜索完成，共找到 ${d.total} 条关卡结果`);
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
  applyStagger("#stage-list");
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
const calcSel = {
  atkUnit: null, atkPilot: null, defUnit: null, defPilot: null,
  atkSkills: [], defSkills: [], atkUSkills: [], defUSkills: [],
  atkSupport: null, defSupport: null, atkOP: null, defOP: null,
  atkUOn: [], atkPOn: [], defUOn: [], defPOn: [],
  abInit: { atkU: false, atkP: false, defU: false, defP: false },
};
const calcSeq = { n: 0 };
const pickerState = { kind: "", side: "", q: "", source: "library", rarity: "", type: "", series: "", tags: "", tag_mode: "any", acq: "", wfx: "", wfx_mode: "any", skills: "", skill_mode: "any", support: "", affectedTags: "", sort: "rarity", order: "desc", page: 0, size: 20, onPick: null };

async function initPickerTagBox(kind) {
  if (kind !== "unit" && kind !== "pilot" && kind !== "supporter") return;
  if (kind === "supporter") {
    // 支援角色：标签框搜索「影响词条对象」（队长技能条件标签）
    const t = await api("/api/tags?kind=supporter_cond");
    initCombobox("#picker-tag-box", t.map((x) => ({ value: x, label: x })),
      () => pickerState.affectedTags, (v) => { pickerState.affectedTags = String(v); }, true);
    return;
  }
  const t = await api(`/api/tags?kind=${kind === "unit" ? "unit" : "character"}`);
  initCombobox("#picker-tag-box", t.map((x) => ({ value: x, label: x })),
    () => pickerState.tags, (v) => { pickerState.tags = String(v); }, true);
}

function togglePickerFilters() {
  const isUnit = pickerState.kind === "unit" && pickerState.source === "library";
  const isPilot = pickerState.kind === "pilot" && pickerState.source === "library";
  const isSupporter = pickerState.kind === "supporter" && pickerState.source === "library";
  const show = isUnit || isPilot || isSupporter;
  // 通用：稀有度 + 标签 + 多标签模式（机体/驾驶员/支援角色都显示）
  ["#picker-rarity", "#picker-tag-box", "#picker-tag-mode"].forEach((sel) => {
    $(sel).classList.toggle("hidden", !show);
  });
  // 机体/驾驶员专属
  ["#picker-type", "#picker-series-box"].forEach((sel) => $(sel).classList.toggle("hidden", !isUnit && !isPilot));
  ["#picker-acq", "#picker-wfx-box"].forEach((sel) => $(sel).classList.toggle("hidden", !isUnit));
  ["#picker-skill-box", "#picker-support"].forEach((sel) => $(sel).classList.toggle("hidden", !isPilot));
  // 支援角色不显示类型/系列（无意义）
  if (isSupporter) {
    ["#picker-type", "#picker-series-box"].forEach((sel) => $(sel).classList.add("hidden"));
  }
}

async function openPicker(kind, onPick, side, weaponUnit, opts) {
  opts = opts || {};
  Object.assign(pickerState, {
    kind, side: side || "", q: "", source: "library",
    rarity: "", type: "", series: "", tags: "",
    tag_mode: "any", acq: "", wfx: "", wfx_mode: "any",
    skills: "", skill_mode: "any", support: "", affectedTags: "",
    sort: "rarity", order: "desc", page: 0, onPick,
    weaponUnit: weaponUnit || null,
  });
  // 组队页：已选支援角色时，默认按该支援角色的词条（标签）过滤机体
  if (kind === "unit" && opts.defaultTags && opts.defaultTags.length) {
    pickerState.tags = opts.defaultTags.join(",");
    pickerState.tag_mode = opts.tag_mode || "any";
  }
  $("#picker-title").textContent =
    kind === "unit" ? "选择机体" : kind === "pilot" ? "选择驾驶员"
    : kind === "weapon" ? "选择武器"
    : kind === "uskill" ? "选择机体单位技能"
    : kind === "supporter" ? "选择支援角色"
    : kind === "unitability" ? "选择单位能力"
    : kind === "charability" ? "选择角色能力" : "选择技能";
  $("#picker-source").style.display =
    (kind === "weapon" || kind === "uskill" || kind === "supporter" || kind === "skill" || kind === "unitability" || kind === "charability") ? "none" : "";
  $("#picker-source").value = "library";
  $("#picker-q").value = "";
  $("#picker-rarity").value = "";
  $("#picker-type").value = "";
  $("#picker-tag-mode").value = pickerState.tag_mode;
  $("#picker-acq").value = "";
  $("#picker-support").value = "";
  syncCombobox("#picker-series-box");
  $("#picker-modal").classList.remove("hidden");
  await initPickerTagBox(kind);
  syncCombobox("#picker-tag-box");
  syncCombobox("#picker-wfx-box");
  syncCombobox("#picker-skill-box");
  togglePickerFilters();
  loadPicker();
}

function showPickerHint(text) {
  pickerState.kind = "";
  $("#picker-title").textContent = "提示";
  $("#picker-source").style.display = "none";
  $("#picker-list").innerHTML = `<div class="empty">${esc(text)}</div>`;
  $("#picker-pager").innerHTML = "";
  $("#picker-modal").classList.remove("hidden");
}

async function loadPicker(page = pickerState.page) {
  pickerState.page = page;
  const s = pickerState;
  if (s.kind === "weapon") {
    if (s.weaponUnit) {
      const d = await api(`/api/units/${s.weaponUnit.id}`);
      const weapons = d.weapons || [];
      $("#picker-list").innerHTML = weapons.length ? weapons.map((w) => `
        <div class="picker-row" data-w="${w.id}">
          <span class="name">${esc(w.name)}</span>
          <span class="muted">威力 ${w.power_lv5 ?? w.power}</span>
          <span class="muted">${esc(`${w.attack_attr_label ?? ""}/${w.attrs_label ?? w.weapon_attr_label ?? ""}`)} ${esc(w.pilot_stat ?? "")}</span>
        </div>`).join("") : '<div class="empty">该机体暂无武器数据</div>';
      $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
        r.addEventListener("click", () => {
          const w = weapons.find((x) => String(x.id) === r.dataset.w);
          $("#picker-modal").classList.add("hidden");
          if (s.onPick) s.onPick(w);
        }));
      $("#picker-pager").innerHTML = "";
      return;
    }
    const u = calcSel.atkUnit;
    if (!u || u.source !== "library") {
      $("#picker-list").innerHTML = '<div class="empty">请先在攻击方「选择机体」选一台机体库中的机体</div>';
      $("#picker-pager").innerHTML = "";
      return;
    }
    const d = await api(`/api/units/${u.id}`);
    const weapons = d.weapons || [];
    $("#picker-list").innerHTML = weapons.length ? weapons.map((w) => `
      <div class="picker-row" data-w="${w.id}">
        <span class="name">${esc(w.name)}</span>
        <span class="muted">威力 ${w.power_lv5 ?? w.power}</span>
        <span class="muted">${esc(`${w.attack_attr_label ?? ""}/${w.attrs_label ?? w.weapon_attr_label ?? ""}`)} ${esc(w.pilot_stat ?? "")}</span>
      </div>`).join("") : '<div class="empty">该机体暂无武器数据</div>';
    $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
      r.addEventListener("click", () => {
    const w = weapons.find((x) => String(x.id) === r.dataset.w);
    calcSel.atkWeapon = w;
    const pb = weaponPowerBoost(w);
    const basePow = w.power_lv9 ?? w.power_lv5 ?? w.power;
    $("#d-wp").value = pb.boost
      ? Math.ceil(basePow * (100 + pb.boost) / 100)
      : basePow;
    $("#d-wfx-power").textContent = pb.effects.length
      ? pb.effects.map((e) => `${e.name}（+${e.pct}%）`).join("；")
      : "—";
        $("#d-weapon-name").textContent = w.name || "—";
        $("#d-wtype").textContent = w.weapon_attr_label ?? "—";
        $("#d-wstat").textContent = w.pilot_stat ?? "—";
        $("#d-wcrit").textContent = (w.crit_lv5 ?? w.critical_rate ?? 0) + "%";
        const dep = pilotDepValue(calcSel.atkPilot, w.attack_attr);
        if (dep != null) $("#d-aca").value = dep;
        $("#picker-modal").classList.add("hidden");
        resetAbInit();
        autoCalcBonuses();
      }));
    $("#picker-pager").innerHTML = "";
    return;
  }
  if (s.kind === "uskill") {
    const owner = s.side === "atk" ? calcSel.atkUnit : calcSel.defUnit;
    if (!owner || owner.source !== "library") {
      $("#picker-list").innerHTML = `<div class="empty">请先${s.side === "atk" ? "在攻击方" : "在防御方"}「选择机体」选一台机体库中的机体</div>`;
      $("#picker-pager").innerHTML = "";
      return;
    }
    const d = await api(`/api/units/${owner.id}`);
    const list = d.skills || [];
    $("#picker-list").innerHTML = list.length ? list.map((sk) => `
      <div class="picker-row" data-sk="${esc(sk.name)}">
        <span class="name">${esc(sk.name)}</span>
        <span class="muted">${esc((sk.desc || "").slice(0, 60))}</span>
      </div>`).join("") : '<div class="empty">该机体暂无单位技能</div>';
    $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
      r.addEventListener("click", () => {
        const sk = list.find((x) => x.name === r.dataset.sk);
        $("#picker-modal").classList.add("hidden");
        s.onPick(sk);
      }));
    $("#picker-pager").innerHTML = "";
    return;
  }
  if (s.kind === "skill" || s.kind === "unitability" || s.kind === "charability") {
    const owner = s.kind === "unitability"
      ? (s.side === "atk" ? calcSel.atkUnit : calcSel.defUnit)
      : (s.side === "atk" ? calcSel.atkPilot : calcSel.defPilot);
    const what = s.kind === "unitability" ? "机体" : "驾驶员";
    if (!owner || owner.source !== "library") {
      $("#picker-list").innerHTML = `<div class="empty">请先${s.side === "atk" ? "在攻击方" : "在防御方"}「选择${what}」选${what === "机体" ? "一台" : "一位"}机体库${what}</div>`;
      $("#picker-pager").innerHTML = "";
      return;
    }
    const ep = s.kind === "unitability" ? "units" : "characters";
    const d = await api(`/api/${ep}/${owner.id}`);
    const list = s.kind === "skill" ? (d.skills || []) : (d.abilities || []);
    $("#picker-list").innerHTML = list.length ? list.map((sk) => `
      <div class="picker-row" data-s="${sk.id}">
        <span class="name">${esc(sk.name)}</span>
        <span class="muted">${esc((sk.effects || []).join("；").slice(0, 80))}</span>
      </div>`).join("") : '<div class="empty">该驾驶员暂无技能</div>';
    $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
      r.addEventListener("click", () => {
        const sk = list.find((x) => String(x.id) === r.dataset.s);
        if (pickerState.onPick) pickerState.onPick(sk);
        $("#picker-modal").classList.add("hidden");
      }));
    $("#picker-pager").innerHTML = "";
    return;
  }
  // 机体/驾驶员走 /api/picker/*（返回 tags 数组、支持机体库/关卡敌人），支援角色走 /api/supporters
  const ep = s.kind === "supporter" ? "supporters" : `picker/${s.kind === "unit" ? "units" : "pilots"}`;
  const params = new URLSearchParams({
    q: s.q, limit: s.size, offset: s.page * s.size,
  });
  if (s.kind === "supporter") {
    // 支援角色选择器：按名称 + 影响词条对象 + 稀有度 过滤（走 /api/supporters）
    if (s.rarity) params.set("rarity", s.rarity);
    params.set("affected_tags", s.affectedTags);
    params.set("tag_mode", s.tag_mode);
  } else {
    params.set("source", s.source);
  }
  if (s.kind !== "supporter" && s.source === "library") {
    params.set("rarity", s.rarity);
    params.set("type", s.type);
    params.set("series", s.series);
    params.set("tags", s.tags);
    params.set("tag_mode", s.tag_mode);
    if (s.kind === "unit") {
      params.set("acq", s.acq);
      params.set("wfx", s.wfx);
      params.set("wfx_mode", s.wfx_mode);
    } else {
      params.set("skills", s.skills);
      params.set("skill_mode", s.skill_mode);
      params.set("support", s.support);
    }
  }
  params.set("sort", s.sort);
  params.set("order", s.order);
  const d = await api(`/api/${ep}?` + params);
  const isEntity = s.kind === "unit" || s.kind === "pilot";
  const isSupporter = s.kind === "supporter";
  const statLabel = { ranged: "射击值", melee: "格斗值", awaken: "觉醒值" };
  const body = d.items.map((it) => {
    if (isSupporter) {
      const bonus = [];
      if (it.leader_pct) bonus.push(`队长技 +${it.leader_pct}%`);
      if (it.atk_add) bonus.push(`攻击 +${it.atk_add}`);
      if (it.hp) bonus.push(`HP +${it.hp}`);
      const conds = (it.condition_tags || []).map((c) => c.text || "").filter(Boolean);
      return `<div class="picker-row picker-row-sup" data-i="${it.id}">
        <div class="row-line"><span class="name">${rarityBadge(it.rarity)} ${esc(it.name)}</span></div>
        ${bonus.length ? `<div class="row-line muted">${bonus.map(esc).join(" · ")}</div>` : ""}
        ${it.active_skill ? `<div class="row-line"><span class="muted">主动：</span><span>${esc(it.active_skill)}</span></div>` : ""}
        ${conds.length ? `<div class="row-line"><span class="muted">影响词条：</span><span>${esc(conds.join(" / "))}</span></div>` : ""}
      </div>`;
    }
    if (!isEntity) {
      return `<div class="picker-row" data-i="${it.id}">
        <span class="name">${esc(it.name)}</span>
        <span class="muted">${it.level ? "Lv." + it.level : ""}</span>
      </div>`;
    }
    let atk = it.attack ?? "";
    if (s.kind === "pilot") {
      const st = { ranged: it.ranged, melee: it.melee, awaken: it.awaken };
      const best = Object.keys(st).reduce((a, b) => (st[a] >= st[b] ? a : b), "ranged");
      atk = `${st[best]}（${statLabel[best]}）`;
    } else if (it.attack_bonus) {
      atk = `${it.attack} (+${it.attack_bonus})`;
    }
    const tags = (it.tags || []).slice(0, 3).join("、") || "—";
    const extra = (s.kind === "pilot" && it.support_label) ? ` · ${esc(it.support_label)}` : "";
    return `<div class="picker-row picker-grid" data-i="${it.id}">
      <span class="name">${esc(it.name)}</span>
      ${it.rarity ? rarityBadge(it.rarity) : "<span>—</span>"}
      <span>${it.role_label ? roleBadge(it.role, it.role_label) : "—"}</span>
      <span class="muted">${esc(tags)}${extra}</span>
      <span class="muted">${esc(it.series_name || "—")}</span>
      <span class="num">${atk}</span>
      <span class="num">${it.defense ?? "—"}${it.defense_bonus ? ` <span class="add">(+${it.defense_bonus})</span>` : ""}</span>
    </div>`;
  }).join("");
  const head = isEntity
    ? '<div class="picker-grid picker-head">' + [
        ["name", "名称"], ["rarity", "稀有度"], ["type", "类型"], ["tags", "标签"],
        ["series", "系列"], ["attack", "攻击力"], ["defense", "防御力"],
      ].map(([k, label]) =>
        `<span><button class="sort-th picker-sort" data-sort="${k}">${label}${pickerState.sort === k ? (pickerState.order === "asc" ? " ▲" : " ▼") : ""}</button></span>`).join("") + '</div>'
    : "";
  $("#picker-list").innerHTML = d.items.length ? head + body : '<div class="empty">无结果</div>';
  $("#picker-list").querySelectorAll(".picker-sort").forEach((b) =>
    b.addEventListener("click", () => {
      if (pickerState.sort === b.dataset.sort) {
        pickerState.order = pickerState.order === "asc" ? "desc" : "asc";
      } else {
        pickerState.sort = b.dataset.sort;
        pickerState.order = "desc";
      }
      loadPicker(0);
    }));
  $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
    r.addEventListener("click", () => {
      const it = d.items.find((x) => String(x.id) === r.dataset.i);
      if (pickerState.onPick) pickerState.onPick(it);
      $("#picker-modal").classList.add("hidden");
    }));
  pager("picker", d.total, s.page, s.size, loadPicker);
}

function pickInfoText(it) {
  const role = it.role_label && it.role_label !== "—" ? " · " + it.role_label : "";
  return it.name
    ? `${rarityBadge(it.rarity)} <span class="name">${esc(it.name)}</span>${roleBadge(it.role, it.role_label)}`
    : "";
}

async function autoCalcBonuses() {
  const seq = ++calcSeq.n;
  const au = calcSel.atkUnit, ap = calcSel.atkPilot;
  const du = calcSel.defUnit, dp = calcSel.defPilot;
  const w = calcSel.atkWeapon;
  const skillStats = calcSel.atkSkills.reduce((a, x) => {
    a.ranged += (x.stats && x.stats.ranged) || 0;
    a.melee += (x.stats && x.stats.melee) || 0;
    a.awaken += (x.stats && x.stats.awaken) || 0;
    return a;
  }, { ranged: 0, melee: 0, awaken: 0 });
  const atkUSkill = calcSel.atkUSkills.reduce((a, x) => ({
    atk: a.atk + (x.atk || 0), buff: a.buff + (x.buff || 0),
    crit: a.crit + (x.crit || 0),
  }), { atk: 0, buff: 0, crit: 0 });
  const defUSkill = calcSel.defUSkills.reduce((a, x) => ({
    def: a.def + (x.def || 0), debuff: a.debuff + (x.debuff || 0),
  }), { def: 0, debuff: 0 });
  const opVal = (p, k) => Number($(`#${p}-op-${k}`).value) || 0;
  const opMode = (p, k) => $(`#${p}-op-${k}-mode`).value;
  const atkOpPct = opMode("atk", "atk") === "pct" ? opVal("atk", "atk") : 0;
  const atkOpFixed = opMode("atk", "atk") === "num" ? opVal("atk", "atk") : 0;
  const defOpPct = opMode("def", "def") === "pct" ? opVal("def", "def") : 0;
  const defOpFixed = opMode("def", "def") === "num" ? opVal("def", "def") : 0;
  const hpOpPct = opMode("def", "hp") === "pct" ? opVal("def", "hp") : 0;
  const hpOpFixed = opMode("def", "hp") === "num" ? opVal("def", "hp") : 0;
  const q = new URLSearchParams({
    atk_uid: au ? au.id : "", atk_usrc: au ? au.source : "",
    atk_pid: ap ? ap.id : "", atk_psrc: ap ? ap.source : "",
    def_uid: du ? du.id : "", def_usrc: du ? du.source : "",
    def_pid: dp ? dp.id : "", def_psrc: dp ? dp.source : "",
    weapon_attr: w ? ((w.attrs && w.attrs.length) ? w.attrs.join(",") : (w.weapon_attr ?? "")) : "",
    attack_attr: w ? w.attack_attr : "",
    attr_nullify: w && (w.effects || []).some((e) =>
      ((e.name || "") + (e.desc || "")).includes("武装属性损伤减轻无效")) ? "1" : "0",
    atk_u_on: calcSel.atkUOn.join(","), atk_p_on: calcSel.atkPOn.join(","),
    def_u_on: calcSel.defUOn.join(","), def_p_on: calcSel.defPOn.join(","),
    atk_star: au ? (au.star || 0) : 0, def_star: du ? (du.star || 0) : 0,
    atk_skill_ranged: skillStats.ranged,
    atk_skill_melee: skillStats.melee,
    atk_skill_awaken: skillStats.awaken,
    atk_unit_skill: atkUSkill.atk,
    def_unit_skill: defUSkill.def,
    atk_support: $("#atk-support").value || 0,
    atk_op: atkOpPct,
    atk_fixed: (Number($("#atk-fixed").value) || 0) + atkOpFixed,
    atk_vigor: $("#d-vigor-atk").value,
    def_support: $("#def-support").value || 0,
    def_op: defOpPct,
    def_fixed: defOpFixed,
    def_vigor: $("#d-vigor-def").value,
  });
  const d = await api("/api/damage-bonus?" + q);
  if (seq !== calcSeq.n) return;
  if (d.atk_unit_attack != null && au) $("#d-aua").value = d.atk_unit_attack;
  if (d.atk_pilot_attack != null && ap) $("#d-aca").value = d.atk_pilot_attack;
  if (d.def_unit_defense != null && du) $("#d-dud").value = d.def_unit_defense;
  if (du && du.max_hp != null) {
    const dMult = SUPPORT_STAR_MULT[Number($("#def-unit-star").value || 0)] || 1;
    const passiveHp = (du.stat_bonuses || {}).hp || 0;
    const dSupPct = Number($("#def-support").value) || 0;
    const supHpFixed = Number($("#def-support-hp").value) || 0;
    const hpPanel = Math.floor(
      Math.floor(du.max_hp * dMult)
      * (100 + passiveHp + dSupPct + hpOpPct) / 100
    ) + supHpFixed + hpOpFixed;
    $("#d-dhp").value = hpPanel;
  }
  if (d.def_unit_hp != null && du) $("#d-dhp").value = d.def_unit_hp;
  if (d.def_pilot_defense != null && dp) $("#d-dcd").value = d.def_pilot_defense;
  const atkSkillBuff = calcSel.atkSkills.reduce((s, x) => s + (x.buff || 0), 0);
  const defSkillDebuff = calcSel.defSkills.reduce((s, x) => s + (x.debuff || 0), 0);
  if (au || ap) $("#d-buff").value = (d.attacker_damage_bonus || 0) + atkSkillBuff + atkUSkill.buff;
  if (du || dp) $("#d-debuff").value = (d.defender_damage_taken || 0) + defSkillDebuff + defUSkill.debuff;
  calcSel.lastAbilities = d.abilities || {};
  const critDmg = attackerCritDmg(d.abilities || {});
  $("#d-wcritdmg").textContent = critDmg ? `+${critDmg}%` : "—";
  const skillCrit = calcSel.atkSkills.reduce((s, x) => s + (x.crit || 0), 0);
  const abilityCrit = attackerCritRate(d.abilities || {});
  const baseCrit = w ? Number(w.crit_lv9 ?? w.crit_lv5 ?? w.critical_rate ?? 0) : 0;
  const effectiveCrit = baseCrit + skillCrit + abilityCrit + atkUSkill.crit;
  if (w) {
    $("#d-wcrit").textContent = `${effectiveCrit}%`;
    if (effectiveCrit >= 100) $("#d-crit").checked = true;
  } else {
    $("#d-wcrit").textContent = "—";
  }
  if (renderAbilityLists(d.abilities || {})) {
    autoCalcBonuses();
  }
}

function attackerCritDmg(ab) {
  let total = 0;
  const sum = (rows, key) => (rows || []).forEach((r) => {
    if (!calcSel[key].includes(r.row_id)) return;
    (r.effects || []).forEach((e) => {
      if (e.kind === "crit_dmg") total += e.pct;
    });
  });
  sum(ab.atk_unit, "atkUOn");
  sum(ab.atk_pilot, "atkPOn");
  return total;
}

function attackerCritRate(ab) {
  let total = 0;
  const sum = (rows, key) => (rows || []).forEach((r) => {
    if (!calcSel[key].includes(r.row_id)) return;
    (r.effects || []).forEach((e) => {
      if (e.kind === "crit_rate") total += e.pct;
    });
  });
  sum(ab.atk_unit, "atkUOn");
  sum(ab.atk_pilot, "atkPOn");
  return total;
}

function effectsText(effs) {
  const lbl = { dmg_up: "增伤+", dmg_down: "减伤+", atk_pct: "攻击+", def_pct: "防御+" };
  return (effs || []).map((e) => `${lbl[e.kind] || ""}${e.pct}%`).join(" ");
}

function resetAbInit() {
  calcSel.abInit = { atkU: false, atkP: false, defU: false, defP: false };
}

function renderAbilityLists(ab) {
  let changed = false;
  changed = renderAbContainer("#atk-unit-ab", ab.atk_unit, "atkU") || changed;
  changed = renderAbContainer("#atk-pilot-ab", ab.atk_pilot, "atkP") || changed;
  changed = renderAbContainer("#def-unit-ab", ab.def_unit, "defU") || changed;
  changed = renderAbContainer("#def-pilot-ab", ab.def_pilot, "defP") || changed;
  return changed;
}

function renderAbContainer(sel, rows, key) {
  const box = $(sel);
  if (!box) return;
  if (!rows || !rows.length) {
    box.innerHTML = '<div class="empty small">—</div>';
    return false;
  }
  let inited = false;
  if (!calcSel.abInit[key]) {
    calcSel[key + "On"] = rows.filter((r) => r.met).map((r) => r.row_id);
    calcSel.abInit[key] = true;
    inited = true;
  }
  const onArr = calcSel[key + "On"];
  box.innerHTML = rows.map((r) => `
    <label class="ab-row">
      <span class="ab-main">
        <span class="ab-name">${esc(r.name)}</span>
        <span class="muted">${esc(r.desc || effectsText(r.effects))}</span>
      </span>
      <input type="checkbox" class="ab-switch" data-key="${key}" data-rid="${esc(r.row_id)}" ${onArr.includes(r.row_id) ? "checked" : ""}>
    </label>`).join("");
  box.querySelectorAll(".ab-switch").forEach((cb) =>
    cb.addEventListener("change", () => {
      const k = cb.dataset.key;
      const rid = cb.dataset.rid;
      const cur = calcSel[k + "On"].slice();
      if (cb.checked) {
        if (!cur.includes(rid)) cur.push(rid);
      } else {
        const i = cur.indexOf(rid);
        if (i >= 0) cur.splice(i, 1);
      }
      calcSel[k + "On"] = cur;
      autoCalcBonuses();
    }));
  return inited;
}

function starVal(base, pct, star) {
  const mults = [[1, 1], [6, 5], [13, 10], [7, 5]];
  const m = mults[star] || [1, 1];
  const sb = Math.floor((base || 0) * m[0] / m[1]);
  return Math.floor(sb * (100 + (pct || 0)) / 100);
}

function applyUnitStar(side) {
  const u = side === "atk" ? calcSel.atkUnit : calcSel.defUnit;
  if (!u) return;
  u.star = Number($(`#${side}-unit-star`).value || 0);
  updatePanelLabels(side);
  autoCalcBonuses();
}

function updatePanelLabels(side) {
  const u = side === "atk" ? calcSel.atkUnit : calcSel.defUnit;
  const star = u ? (u.star || 0) : 0;
  const ult = u && (u.tags || []).includes("终极");
  const bt = u ? (ult ? 0 : ([0, 20, 30, 40][star] || 0)) : 0;
  const sb = (u && u.stat_bonuses) || {};
  const passive = side === "atk" ? (sb.attack || 0) : (sb.defense || 0);
  $(`#${side}-panel-bt`).textContent = bt + "%";
  $(`#${side}-panel-passive`).textContent = passive + "%";
}

$("#pick-atk-unit").addEventListener("click", () => openPicker("unit", async (it) => {
  const det = await api(`/api/units/${it.id}`);
  calcSel.atkUnit = { ...it, star: 0, stat_bonuses: det.stat_bonuses || {}, max_hp: det.max_hp };
  calcSel.atkUOn = [];
  resetAbInit();
  $("#atk-unit-info").innerHTML = pickInfoText(it);
  $("#atk-unit-star").classList.remove("hidden");
  $("#atk-unit-star").value = "0";
  updatePanelLabels("atk");
  applyUnitStar("atk");
  await autoCalcBonuses();
}));
$("#pick-def-unit").addEventListener("click", () => openPicker("unit", async (it) => {
  const det = await api(`/api/units/${it.id}`);
  calcSel.defUnit = { ...it, star: 0, stat_bonuses: det.stat_bonuses || {}, max_hp: det.max_hp };
  calcSel.defUOn = [];
  resetAbInit();
  $("#def-unit-info").innerHTML = pickInfoText(it);
  $("#def-unit-star").classList.remove("hidden");
  $("#def-unit-star").value = "0";
  updatePanelLabels("def");
  applyUnitStar("def");
  await autoCalcBonuses();
}));
$("#atk-unit-star").addEventListener("change", () => applyUnitStar("atk"));
$("#def-unit-star").addEventListener("change", () => applyUnitStar("def"));
$("#pick-atk-pilot").addEventListener("click", () => openPicker("pilot", async (it) => {
  calcSel.atkPilot = { id: it.id, source: it.source, ranged: it.ranged, melee: it.melee, awaken: it.awaken, defense: it.defense };
  calcSel.atkPOn = [];
  resetAbInit();
  $("#atk-pilot-info").innerHTML = pickInfoText(it);
  const dep = pilotDepValue(calcSel.atkPilot,
    calcSel.atkWeapon ? calcSel.atkWeapon.attack_attr : 1);
  $("#d-aca").value = dep != null ? dep : (it.ranged ?? "");
  await autoCalcBonuses();
}));
$("#pick-def-pilot").addEventListener("click", () => openPicker("pilot", async (it) => {
  calcSel.defPilot = { id: it.id, source: it.source, ranged: it.ranged, melee: it.melee, awaken: it.awaken, defense: it.defense };
  calcSel.defPOn = [];
  resetAbInit();
  $("#d-dcd").value = it.defense ?? "";
  $("#def-pilot-info").innerHTML = pickInfoText(it);
  await autoCalcBonuses();
}));
$("#pick-weapon").addEventListener("click", () => openPicker("weapon", null));

function pickSkill(side) {
  const pilot = side === "atk" ? calcSel.atkPilot : calcSel.defPilot;
  if (!pilot || pilot.source !== "library") {
    showPickerHint(`请先${side === "atk" ? "在攻击方" : "在防御方"}「选择驾驶员」选一位机体库驾驶员`);
    return;
  }
  openPicker("skill", (sk) => {
    let buff = 0, debuff = 0;
    let crit = 0;
    const stats = { ranged: 0, melee: 0, awaken: 0 };
    const statAlias = { "射击值": "ranged", "格斗值": "melee", "觉醒值": "awaken" };
    (sk.effects || []).forEach((e) => {
      const m1 = e.match(/损伤提升\s*(\d+)%/);
      if (m1) buff += Number(m1[1]);
      const m2 = e.match(/损伤减轻\s*(\d+)%/);
      if (m2) debuff += Number(m2[1]);
      const cm = e.match(/爆击率提升\s*(\d+)%/);
      if (cm) crit += Number(cm[1]);
      const sm = e.match(/(射击值|格斗值|觉醒值)(?:及|与|和)?(?:射击值|格斗值|觉醒值)?提升\s*(\d+)%/);
      if (sm) {
        const pct = Number(sm[2]);
        ["射击值", "格斗值", "觉醒值"].forEach((n) => {
          if (sm[1].includes(n)) stats[statAlias[n]] += pct;
        });
      }
    });
    const arr = side === "atk" ? calcSel.atkSkills : calcSel.defSkills;
    if (sk.name && !arr.some((x) => x.name === sk.name)) {
      arr.push({ name: sk.name, buff, debuff, stats, crit });
    }
    renderSkills(side);
    autoCalcBonuses();
  }, side);
}

function pickUSkill(side) {
  const unit = side === "atk" ? calcSel.atkUnit : calcSel.defUnit;
  if (!unit || unit.source !== "library") {
    showPickerHint(`请先${side === "atk" ? "在攻击方" : "在防御方"}「选择机体」选一台机体库机体`);
    return;
  }
  openPicker("uskill", (sk) => {
    let atk = 0, def = 0, buff = 0, debuff = 0, crit = 0;
    const desc = sk.desc || "";
    let m = desc.match(/攻击力提升\s*(\d+)%/);
    if (m) atk += Number(m[1]);
    m = desc.match(/防御力提升\s*(\d+)%/);
    if (m) def += Number(m[1]);
    m = desc.match(/(?<!爆击)损伤提升\s*(\d+)%/);
    if (m) buff += Number(m[1]);
    m = desc.match(/损伤(?:减轻|降低)\s*(\d+)%/);
    if (m) debuff += Number(m[1]);
    m = desc.match(/爆击率提升\s*(\d+)%/);
    if (m) crit += Number(m[1]);
    const arr = side === "atk" ? calcSel.atkUSkills : calcSel.defUSkills;
    if (sk.name && !arr.some((x) => x.name === sk.name)) {
      arr.push({ name: sk.name, atk, def, buff, debuff, crit });
    }
    renderUSkills(side);
    autoCalcBonuses();
  }, side);
}

function renderUSkills(side) {
  const box = $(side === "atk" ? "#d-atk-uskills" : "#d-def-uskills");
  const arr = side === "atk" ? calcSel.atkUSkills : calcSel.defUSkills;
  if (!box) return;
  box.innerHTML = arr.length ? arr.map((sk) => `
    <span class="chip sel-tag">${esc(sk.name)}
      <button class="chip-x" aria-label="移除" data-side="${side}" data-uskill="${esc(sk.name)}" title="移除">×</button>
    </span>`).join("") : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.side === "atk" ? "atkUSkills" : "defUSkills";
      calcSel[k] = calcSel[k].filter((x) => x.name !== b.dataset.uskill);
      renderUSkills(b.dataset.side);
      autoCalcBonuses();
    }));
}

function renderSkills(side) {
  const box = $(side === "atk" ? "#d-atk-skills" : "#d-def-skills");
  const arr = side === "atk" ? calcSel.atkSkills : calcSel.defSkills;
  if (!box) return;
  box.innerHTML = arr.length ? arr.map((sk) => `
    <span class="chip sel-tag">${esc(sk.name)}
      <button class="chip-x" aria-label="移除" data-side="${side}" data-skill="${esc(sk.name)}" title="移除">×</button>
    </span>`).join("") : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.side === "atk" ? "atkSkills" : "defSkills";
      calcSel[k] = calcSel[k].filter((x) => x.name !== b.dataset.skill);
      renderSkills(b.dataset.side);
      autoCalcBonuses();
    }));
}
$("#pick-atk-skill").addEventListener("click", () => pickSkill("atk"));
$("#pick-def-skill").addEventListener("click", () => pickSkill("def"));
$("#pick-atk-uskill").addEventListener("click", () => pickUSkill("atk"));
$("#pick-def-uskill").addEventListener("click", () => pickUSkill("def"));
$("#pick-atk-support").addEventListener("click", () => pickSupporter("atk"));
$("#pick-def-support").addEventListener("click", () => pickSupporter("def"));
["atk-support", "atk-fixed", "atk-support-hp",
 "def-support", "def-support-atk", "def-support-hp",
 "atk-op-hp", "atk-op-hp-mode", "atk-op-atk", "atk-op-atk-mode",
 "atk-op-def", "atk-op-def-mode",
 "def-op-hp", "def-op-hp-mode", "def-op-atk", "def-op-atk-mode",
 "def-op-def", "def-op-def-mode",
 "atk-support-star", "def-support-star"]
  .forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("change", () => {
      if (id === "atk-support-star") applySupportPanel("atk");
      if (id === "def-support-star") applySupportPanel("def");
      autoCalcBonuses();
    });
  });

function pickSupporter(side) {
  openPicker("supporter", (x) => {
    const key = side === "atk" ? "atkSupport" : "defSupport";
    calcSel[key] = x;
    const p = side === "atk" ? "atk" : "def";
    $(`#${p}-support-star`).value = "3";
    $(`#${p}-support-info`).innerHTML =
      `${rarityBadge(x.rarity)} ${esc(x.name)}` +
      ((x.conds && x.conds.length) ? ` <span class="muted">｜${esc(x.conds.join("；"))}</span>` : "");
    applySupportPanel(side);
    autoCalcBonuses();
  }, side);
}

const SUPPORT_STAR_MULT = [1, 1.2, 1.3, 1.4];

function applySupportPanel(side) {
  const x = side === "atk" ? calcSel.atkSupport : calcSel.defSupport;
  if (!x) return;
  const star = Number($(`#${side}-support-star`).value || 0);
  const pcts = x.leader_pcts || [];
  const leaderPct = pcts[star] ?? x.leader_pct ?? 0;
  $(`#${side}-support`).value = leaderPct;
  const atk = x.atk_add || 0;
  const hp = x.hp_add || 0;
  const atkEl = side === "atk" ? "#atk-fixed" : "#def-support-atk";
  $(atkEl).value = Math.floor(atk * SUPPORT_STAR_MULT[star] / 1.4);
  $(`#${side}-support-hp`).value = Math.floor(hp * SUPPORT_STAR_MULT[star] / 1.4);
}

$("#picker-search").addEventListener("click", () => {
  pickerState.q = $("#picker-q").value;
  pickerState.source = $("#picker-source").value;
  pickerState.rarity = $("#picker-rarity").value;
  pickerState.type = $("#picker-type").value;
  pickerState.tag_mode = $("#picker-tag-mode").value;
  pickerState.acq = $("#picker-acq").value;
  pickerState.support = $("#picker-support").value;
  loadPicker(0);
});
$("#picker-reset").addEventListener("click", () => {
  Object.assign(pickerState, {
    q: "", rarity: "", type: "", series: "", tags: "", tag_mode: "any",
    acq: "", wfx: "", wfx_mode: "any", skills: "", skill_mode: "any", support: "",
    sort: "rarity", order: "desc", page: 0,
  });
  $("#picker-q").value = "";
  $("#picker-rarity").value = "";
  $("#picker-type").value = "";
  $("#picker-tag-mode").value = "any";
  $("#picker-acq").value = "";
  $("#picker-support").value = "";
  syncCombobox("#picker-series-box");
  syncCombobox("#picker-tag-box");
  syncCombobox("#picker-wfx-box");
  syncCombobox("#picker-skill-box");
  loadPicker(0);
});
$("#picker-source").addEventListener("change", () => {
  pickerState.source = $("#picker-source").value;
  pickerState.page = 0;
  togglePickerFilters();
  loadPicker(0);
});
$("#picker-q").addEventListener("keydown", (e) => e.key === "Enter" && $("#picker-search").click());
$("#picker-close").addEventListener("click", () => $("#picker-modal").classList.add("hidden"));
$("#picker-modal").addEventListener("click", (e) => {
  if (e.target === $("#picker-modal")) $("#picker-modal").classList.add("hidden");
});

$("#d-calc").addEventListener("click", async () => {
  const ab = calcSel.lastAbilities || {};
  let defStackPct = 0, defStackMax = 0;
  let hpRecPct = 0, hpRecTh = 0;
  (ab.def_unit || []).forEach((r) => {
    if (!calcSel.defUOn.includes(r.row_id)) return;
    (r.effects || []).forEach((e) => {
      if (e.kind === "def_stack") {
        defStackPct += e.pct;
        defStackMax = Math.max(defStackMax, e.max);
      }
    });
  });
  (ab.def_pilot || []).forEach((r) => {
    if (!calcSel.defPOn.includes(r.row_id)) return;
    (r.effects || []).forEach((e) => {
      if (e.kind === "hp_recover") {
        hpRecPct += e.pct;
        hpRecTh = e.threshold;
      }
    });
  });
  const q = new URLSearchParams({
    aua: $("#d-aua").value, aca: $("#d-aca").value,
    dud: $("#d-dud").value, dcd: $("#d-dcd").value, dhp: $("#d-dhp").value,
    wp: $("#d-wp").value, terrain: $("#d-terrain").value,
    vigor: $("#d-vigor-atk").value,
    buff: $("#d-buff").value, debuff: $("#d-debuff").value,
    critical: $("#d-crit").checked ? "1" : "0",
    defend_state: $("#d-defend-state").value,
    def_stack_pct: defStackPct, def_stack_max: defStackMax,
    hp_recover_pct: hpRecPct, hp_recover_threshold: hpRecTh,
    crit_damage_bonus: attackerCritDmg(calcSel.lastAbilities || {}),
  });
  const d = await api("/api/damage-sim?" + q);
  if (d.error) {
    $("#d-result-body").innerHTML = `<div class="empty">${esc(d.error)}</div>`;
    return;
  }
  const hits = d.hits || [];
  const first = hits[0];
  const totalDmg = hits.reduce((s, h) => s + h.damage, 0);
  const avgDmg = hits.length ? Math.round(totalDmg / hits.length) : 0;
  const finalDef = hits.length ? hits[hits.length - 1].defense : 0;
  $("#d-result-body").innerHTML = hits.length ? `
    ${first ? `<div class="damage-final">本次攻击伤害 <b>${first.damage}</b></div>
    <div class="remain-hp">防御方剩余 HP：<b>${first.hp}</b>（${first.hp_pct}%）</div>` : ""}
    <div class="sim-summary">
      <span>共 <b>${hits.length}</b> 次攻击</span>
      <span>总伤害 <b>${totalDmg}</b></span>
      <span>平均每次 <b>${avgDmg}</b></span>
      <span>最终防御 <b>${finalDef}</b></span>
    </div>
    <h3>逐次攻击明细</h3>
    <table>
      <tr><th>次数</th><th>防御</th><th>本次伤害</th><th>剩余HP</th><th>剩余%</th><th>触发</th></tr>
      ${hits.map((h) => `
        <tr class="${h.hp <= 0 ? "dead" : ""}">
          <td class="mono">${h.n}</td>
          <td class="mono">${h.defense}</td>
          <td class="mono">${h.damage}</td>
          <td class="mono">${h.hp}</td>
          <td class="mono">${h.hp_pct}%</td>
          <td>${h.recovered ? "HP恢复" : ""}</td>
        </tr>`).join("")}
    </table>` : '<div class="empty">无数据</div>';
});

function resetSide(side) {
  if (side === "atk") {
    calcSel.atkUnit = calcSel.atkPilot = null;
    calcSel.atkWeapon = null;
    calcSel.atkSkills = [];
    calcSel.atkUSkills = [];
    calcSel.atkSupport = null;
    calcSel.atkOP = null;
    calcSel.atkUOn = [];
    calcSel.atkPOn = [];
    resetAbInit();
    $("#d-aua").value = 3000;
    $("#d-aca").value = 800;
    $("#d-wp").value = 5000;
    $("#d-wtype").textContent = "—";
    $("#d-wstat").textContent = "—";
    $("#d-weapon-name").textContent = "—";
    $("#d-wfx-power").textContent = "—";
    $("#d-wcrit").textContent = "—";
    $("#d-wcritdmg").textContent = "—";
    $("#atk-support").value = 0;
    $("#atk-fixed").value = 0;
    $("#atk-support-hp").value = 0;
    $("#atk-support-star").value = "3";
    ["atk-op-hp", "atk-op-atk", "atk-op-def"].forEach((id) => { $(`#${id}`).value = 0; });
    ["atk-op-hp-mode", "atk-op-atk-mode", "atk-op-def-mode"].forEach((id) => { $(`#${id}`).value = "pct"; });
    $("#atk-support-info").textContent = "未选择支援角色";
    renderSkills("atk");
    renderUSkills("atk");
    $("#d-buff").value = 0;
    $("#d-vigor-atk").value = "normal";
    $("#atk-unit-info").textContent = "";
    $("#atk-pilot-info").textContent = "";
    $("#atk-unit-star").classList.add("hidden");
    $("#atk-unit-star").value = "0";
    $("#atk-unit-ab").innerHTML = "";
    $("#atk-pilot-ab").innerHTML = "";
  } else {
    calcSel.defUnit = calcSel.defPilot = null;
    calcSel.defSkills = [];
    calcSel.defUSkills = [];
    calcSel.defSupport = null;
    calcSel.defOP = null;
    calcSel.defUOn = [];
    calcSel.defPOn = [];
    resetAbInit();
    $("#d-dud").value = 2800;
    $("#d-dhp").value = 0;
    $("#d-dcd").value = 750;
    $("#def-support").value = 0;
    $("#def-support-atk").value = 0;
    $("#def-support-hp").value = 0;
    $("#def-support-star").value = "3";
    ["def-op-hp", "def-op-atk", "def-op-def"].forEach((id) => { $(`#${id}`).value = 0; });
    ["def-op-hp-mode", "def-op-atk-mode", "def-op-def-mode"].forEach((id) => { $(`#${id}`).value = "pct"; });
    $("#def-support-info").textContent = "未选择支援角色";
    renderSkills("def");
    renderUSkills("def");
    $("#d-debuff").value = 0;
    $("#d-vigor-def").value = "normal";
    $("#def-unit-info").textContent = "";
    $("#def-pilot-info").textContent = "";
    $("#def-unit-star").classList.add("hidden");
    $("#def-unit-star").value = "0";
    $("#def-unit-ab").innerHTML = "";
    $("#def-pilot-ab").innerHTML = "";
  }
  autoCalcBonuses();
}
$("#reset-atk").addEventListener("click", () => resetSide("atk"));
$("#reset-def").addEventListener("click", () => resetSide("def"));

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
  state.characters.support = $("#char-support").value;
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
  state.supporters.skill_mode = $("#sup-skill-mode").value;
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
    wfx: [], wfx_mode: "any", cond: null,
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
  renderUnitCondBar();
  loadUnits(0);
}
function resetCharacters() {
  Object.assign(state.characters, {
    q: "", rarity: "", series: "", type: "", tags: [], tag_mode: "all", match: "and",
    skills: [], skill_mode: "any", support: "",
    sort: "rarity", order: "desc", page: 0,
  });
  $("#char-q").value = "";
  $("#char-rarity").value = "";
  $("#char-type").value = "";
  $("#char-tag-mode").value = "all";
  $("#char-skill-mode").value = "any";
  $("#char-support").value = "";
  $("#char-match").value = "and";
  syncCombobox("#char-series-box");
  renderTagChips("char");
  renderSkillChips();
  loadCharacters(0);
}
function resetSupporters() {
  Object.assign(state.supporters, {
    q: "", tags: [], tag_mode: "any", skills: [], skill_mode: "any",
    sort: "rarity", order: "desc", page: 0,
  });
  $("#sup-q").value = "";
  $("#sup-tag-mode").value = "any";
  $("#sup-skill-mode").value = "any";
  renderTagChips("sup");
  renderSupSkillChips();
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
  /* 重置为单栏默认布局（openUnit 会按需追加 modal-detail） */
  const box = $("#modal .modal-box");
  if (box) box.classList.remove("modal-detail");
  $("#modal").classList.remove("hidden");
}
function closeModal() {
  $("#modal").classList.add("hidden");
  const box = $("#modal .modal-box");
  if (box) box.classList.remove("modal-detail");
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
    $("#picker-modal").classList.add("hidden");
  }
});

// 数值框聚焦时自动全选，点一下即可直接覆盖输入
document.addEventListener("focusin", (e) => {
  if (e.target && e.target.matches && e.target.matches("input[type='number']")) {
    e.target.select();
  }
});

/* 原作关联跳转：机体↔驾驶员详情互跳 + 就地修改映射 */
function canonicalJumpHtml(type, entity, contextId) {
  const jump = type === "unit" ? "character" : "unit";
  const label = type === "unit" ? "原作驾驶" : "原作搭乘机体";
  const editType = type === "unit" ? "pilot" : "unit";
  return `<div class="ds-canonical">${label}：<button class="chip jump-chip" data-jump="${jump}" data-id="${entity.id}">${esc(entity.name)}</button>
    <button class="chip jump-edit" data-edit-type="${editType}" data-ctx="${contextId}" title="修改原作映射">改</button></div>`;
}
document.addEventListener("click", (e) => {
  const ed = e.target.closest(".jump-edit");
  if (ed) {
    const ctx = Number(ed.dataset.ctx);
    if (ed.dataset.editType === "pilot") {
      openPicker("pilot", async (p) => {
        await apiPost("/api/unit-pilot/edit", { unit_id: ctx, pilot_id: p.id });
        openUnit(ctx);
      });
    } else {
      openPicker("unit", async (u) => {
        await apiPost("/api/unit-pilot/edit", { unit_id: u.id, pilot_id: ctx });
        openCharacter(ctx);
      });
    }
    return;
  }
  const j = e.target.closest(".jump-chip");
  if (!j) return;
  if (j.dataset.jump === "character") openCharacter(j.dataset.id);
  else if (j.dataset.jump === "unit") openUnit(j.dataset.id);
});

/* ---------- 配对 ---------- */
const pairFilterState = { q:"", rarity:"", acq:"", series:"", type:"", tags: [], tag_mode: "all", skills: [], skill_mode: "any", support: "", match: "and", sort: "score", order: "desc" };
let pairFilterData = null;
let pairLastQuery = "";
const pairState = {
  unit: null, unitDetail: null, action: "attack", weapon: null, bench: "low",
  enemyTags: [], enemySeries: [], atkUs: [],
};
const pairUnitState = { q: "", rarity: "", acq: "", series: "", type: "", tags: [], tag_mode: "all", match: "and", wfx: [], wfx_mode: "any", page: 0, size: 25 };

function renderPairTagChips() {
  const box = $("#pp-tag-chips");
  box.innerHTML = pairUnitState.tags.length
    ? pairUnitState.tags.map((t) =>
        `<span class="chip sel-tag">${esc(t)}<button class="chip-x" aria-label="移除" data-t="${esc(t)}" title="移除">×</button></span>`).join("")
    : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      pairUnitState.tags = pairUnitState.tags.filter((t) => t !== b.dataset.t);
      renderPairTagChips();
      ppLoad(0);
    }));
}

function renderPairWfxChips() {
  const box = $("#pp-wfx-chips");
  box.innerHTML = pairUnitState.wfx.length
    ? pairUnitState.wfx.map((v) =>
        `<span class="chip sel-tag">${esc(wfxLabel(v))}<button class="chip-x" aria-label="移除" data-w="${esc(v)}" title="移除">×</button></span>`).join("")
    : "";
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      pairUnitState.wfx = pairUnitState.wfx.filter((v) => v !== b.dataset.w);
      renderPairWfxChips();
      ppLoad(0);
    }));
}

function ppLoad(page = pairUnitState.page) {
  pairUnitState.page = page;
  pairUnitState.q = $("#pp-q").value.trim();
  pairUnitState.rarity = $("#pp-rarity").value;
  pairUnitState.acq = $("#pp-acq").value;
  pairUnitState.type = $("#pp-type").value;
  pairUnitState.tag_mode = $("#pp-tag-mode").value;
  pairUnitState.match = $("#pp-match").value;
  pairUnitState.wfx_mode = $("#pp-wfx-mode").value;
  const s = pairUnitState;
  const q = new URLSearchParams({
    q: s.q, rarity: s.rarity, acq: s.acq, series: s.series, type: s.type,
    tags: s.tags.join(","), tag_mode: s.tag_mode,
    match: s.match, wfx: s.wfx.join(","), wfx_mode: s.wfx_mode,
    sort: "rarity", order: "desc",
    limit: s.size, offset: s.page * s.size,
  });
  api("/api/units?" + q).then((d) => {
    $("#pp-count").textContent = `共 ${d.total} 条结果`;
    $("#pp-list").innerHTML = d.items.length
      ? d.items.map((u) => `
        <div class="list-row units" data-id="${u.id}">
          <span class="name">${esc(u.name)}</span>
          ${cell(rarityBadge(u.rarity))}
          ${cell(roleBadge(u.role, u.role_label))}
          <span class="num">${u.atk_f}</span><span class="num">${u.def_f}</span>
          <span class="num">${u.mob_f}</span><span class="num">${u.hp_f}</span>
          <span class="num">${u.en_f}</span><span class="num">${u.mov}</span>
        </div>`).join("")
      : '<div class="empty">没有匹配的机体</div>';
    $("#pp-list").querySelectorAll(".list-row").forEach((r) => {
      const item = d.items.find((x) => String(x.id) === r.dataset.id);
      r.addEventListener("click", () => confirmPickUnit(Number(r.dataset.id), item));
    });
    pager("pp", d.total, s.page, s.size, ppLoad);
  });
}

async function confirmPickUnit(id, item) {
  if (!confirm(`是否选择这个机体：${item ? item.name : id}？`)) return;
  const detail = await api(`/api/units/${id}`);
  pairState.unit = {
    id, name: detail.name, rarity: detail.rarity,
    role: detail.role, role_label: detail.role_label, tags: detail.tags || [],
  };
  pairState.unitDetail = detail;
  pairState.weapon = null;
  pairState.atkUs = [];
  renderUnitSkillChips();
  $("#pair-picker-modal").classList.add("hidden");
  $("#pair-result").innerHTML = "";
  renderPairSelection();
}

function renderPairSelection() {
  const u = pairState.unit;
  const sel = $("#pair-selected");
  if (!u) {
    sel.innerHTML = '<span class="muted">未选择机体</span>';
    updatePairMatchBtn();
    return;
  }
  sel.innerHTML = `
    <span class="pair-sel-info">${rarityBadge(u.rarity)} <b>${esc(u.name)}</b> ${roleBadge(u.role, u.role_label)} ${(u.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join(" ")}</span>
    <button class="pair-sel-clear" aria-label="清除选择" id="pair-clear-unit" title="清除机体">×</button>`;
  $("#pair-clear-unit").addEventListener("click", () => {
    pairState.unit = null;
    pairState.unitDetail = null;
    pairState.weapon = null;
    renderPairSelection();
    renderWeaponInfo();
    updatePairMatchBtn();
  });
  updatePairModeUI();
  renderWeaponInfo();
  updatePairMatchBtn();
}

function updatePairMatchBtn() {
  const ok = pairState.unit && (pairState.action === "defense" || pairState.weapon);
  $("#pair-match").disabled = !ok;
}

function setPairAction(a) {
  pairState.action = a;
  $("#pair-result").innerHTML = "";
  $("#pair-act-atk").classList.toggle("active", a === "attack");
  $("#pair-act-def").classList.toggle("active", a === "defense");
  updatePairModeUI();
  if (a === "defense") applyDefaultEnemy();
  renderWeaponInfo();
  updatePairMatchBtn();
}

function updatePairModeUI() {
  const atk = pairState.action === "attack";
  $("#pair-weapon-row").classList.toggle("hidden", !atk);
  $("#pair-enemy-row").classList.toggle("hidden", atk);
  $("#pair-bench-wrap").classList.toggle("hidden", !atk);
  $("#pair-vigor-wrap").classList.toggle("hidden", !atk);
  $("#pair-ext-op-lbl").querySelector("span")?.remove();
  $("#pair-ext-op-lbl").childNodes[0].textContent = atk ? "零件攻击%" : "零件防御%";
  $("#pair-ext-hp-lbl").classList.toggle("hidden", atk);
  $("#pair-ext-hpf-lbl").classList.toggle("hidden", atk);
}

function renderEnemyPower() {
  const base = Number($("#pair-enemy-wp").value) || 0;
  const boost = Number($("#pair-enemy-wpboost").value) || 0;
  const eff = Math.ceil(base * (100 + boost) / 100);
  $("#pair-enemy-wpeff").textContent = eff;
  return eff;
}

let pairDefaultEnemy = null;
async function applyDefaultEnemy() {
  if (!pairDefaultEnemy) {
    try {
      pairDefaultEnemy = await api("/api/pairing/default-enemy");
    } catch (e) { return; }
  }
  const d = pairDefaultEnemy;
  $("#pair-enemy-ua").value = d.unit_attack;
  $("#pair-enemy-pa").value = d.pilot_attack;
  $("#pair-enemy-wp").value = d.power_base ?? d.power;
  $("#pair-enemy-wpboost").value = d.power_boost ?? 0;
  $("#pair-enemy-wp-fx").innerHTML = (d.power_effects || []).map((e) =>
    `<span class="chip" title="${esc(e.desc || "")}">${esc(e.name || "武装POWER提升")}</span>`).join("");
  $("#pair-enemy-wt").value = String(d.weapon_type);
  $("#pair-enemy-waa").value = d.weapon_attack;
  renderEnemyPower();
}

function renderUnitSkillChips() {
  const box = $("#pair-uskill-chips");
  const u = pairState.unitDetail;
  const names = (u?.skills || []).filter((s) => pairState.atkUs.includes(String(s.id))).map((s) => s.name);
  box.innerHTML = names.map((n) =>
    `<span class="chip sel-tag">${esc(n)}<button class="chip-x" aria-label="移除" data-n="${esc(n)}" title="移除">×</button></span>`).join("");
  box.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      const u2 = pairState.unitDetail;
      const s = (u2?.skills || []).find((x) => x.name === b.dataset.n);
      if (s) pairState.atkUs = pairState.atkUs.filter((v) => v !== String(s.id));
      renderUnitSkillChips();
    }));
}

function openUnitSkillPicker() {
  const u = pairState.unitDetail;
  if (!u || !u.skills || !u.skills.length) return;
  const rows = u.skills.map((s) => `
    <label class="ab-row">
      <span class="ab-main">
        <span class="ab-name">${esc(s.name || "—")}</span>
        <span class="muted">${esc(s.desc || "")}</span>
      </span>
      <input type="checkbox" class="ab-switch usk" data-id="${s.id}" ${pairState.atkUs.includes(String(s.id)) ? "checked" : ""}>
    </label>`).join("");
  showModal("选择机体单位技能",
    `<div class="ability-list" id="pair-uskill-list">${rows || '<div class="empty">该机体暂无单位技能</div>'}</div>
     <div class="calc-actions">
       <button id="pair-uskill-ok" class="cond-btn">确定</button>
       <button id="pair-uskill-cancel" class="cond-btn">取消</button>
     </div>`);
  $("#pair-uskill-list").querySelectorAll(".usk").forEach((cb) =>
    cb.addEventListener("change", () => {
      const id = String(cb.dataset.id);
      if (cb.checked) {
        if (!pairState.atkUs.includes(id)) pairState.atkUs.push(id);
      } else {
        pairState.atkUs = pairState.atkUs.filter((v) => v !== id);
      }
      renderUnitSkillChips();
    }));
  $("#pair-uskill-ok").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#pair-uskill-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

function setPairBench(b) {
  pairState.bench = b;
  $("#pair-bench-low").classList.toggle("active", b === "low");
  $("#pair-bench-mid").classList.toggle("active", b === "mid");
}

function renderEnemyChips() {
  const html = []
    .concat(pairState.enemySeries.map((s) => ({ key: "s", label: s.name, val: s.id, name: "系列" })))
    .concat(pairState.enemyTags.map((t) => ({ key: "t", label: t, name: "标签" })))
    .map((x) =>
      `<span class="chip sel-tag" title="${esc(x.name)}">${esc(x.label)}
        <button class="chip-x" aria-label="移除" data-kind="${x.key}" data-v="${esc(x.val ?? x.label)}" title="移除">×</button>
      </span>`).join("");
  $("#ep-chips").innerHTML = html || '<span class="muted">未选择（依赖敌方标签/系列的能力将不触发）</span>';
  $("#pair-enemy-tags").innerHTML = html;
  ["#ep-chips", "#pair-enemy-tags"].forEach((sel) => {
    const box = $(sel);
    box.querySelectorAll(".chip-x").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.kind === "s") {
          pairState.enemySeries = pairState.enemySeries.filter((v) => v.id !== b.dataset.v);
        } else {
          pairState.enemyTags = pairState.enemyTags.filter((v) => v !== b.dataset.v);
        }
        renderEnemyChips();
      }));
  });
}

async function openEnemyTagPicker() {
  try {
    const [series, tags] = await Promise.all([
      api("/api/series"),
      api("/api/tags?kind=unit"),
    ]);
    initCombobox("#ep-series-box",
      [{ value: "", label: "全部系列" }].concat(series.map((s) => ({ value: s.id, label: s.name }))),
      () => "",
      (v, label) => { if (v && !pairState.enemySeries.some((x) => x.id === String(v))) {
        pairState.enemySeries.push({ id: String(v), name: label });
        renderEnemyChips();
      } }, false);
    initCombobox("#ep-tag-box",
      tags.map((t) => ({ value: t, label: t })),
      () => "",
      (v) => { if (v && !pairState.enemyTags.includes(v)) {
        pairState.enemyTags.push(v);
        renderEnemyChips();
      } }, false);
  } catch (e) { /* 忽略 */ }
  renderEnemyChips();
  $("#enemy-picker-modal").classList.remove("hidden");
}

function openPairUnitPicker() {
  pairUnitState.page = 0;
  $("#pair-picker-modal").classList.remove("hidden");
  ppLoad(0);
}

function openPairWeaponPicker() {
  const u = pairState.unitDetail;
  if (!u || !u.weapons || !u.weapons.length) return;
  const rows = u.weapons.map((w) => `
    <div class="picker-row" data-w="${w.id}">
      <span class="name">${esc(w.name)}</span>
      <span class="muted">威力 ${w.power_lv9 ?? w.power_lv5 ?? w.power}</span>
      <span class="muted">${esc(`${w.attack_attr_label ?? "—"}/${w.attrs_label ?? w.weapon_attr_label ?? "—"}`)} ${esc(w.pilot_stat ?? "")}</span>
    </div>`).join("");
  showModal("选择武器",
    `<div id="pair-weapon-list" class="list picker-list">${rows || '<div class="empty">该机体暂无武器数据</div>'}</div>
     <div class="calc-actions"><button id="pair-wp-close" class="cond-btn">取消</button></div>`);
  $("#pair-weapon-list").querySelectorAll(".picker-row").forEach((r) =>
    r.addEventListener("click", () => {
      const w = u.weapons.find((x) => String(x.id) === r.dataset.w);
      pairState.weapon = w;
      $("#modal").classList.add("hidden");
      renderWeaponInfo();
      updatePairMatchBtn();
    }));
  $("#pair-wp-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
}

function renderWeaponInfo() {
  const box = $("#pair-weapon-info");
  if (pairState.action !== "attack") return;
  if (!pairState.weapon) {
    box.innerHTML = '<span class="muted">未选择武器</span>';
    return;
  }
  const w = pairState.weapon;
  const basePow = w.power_lv9 ?? w.power_lv5 ?? w.power;
  const pb = weaponPowerBoost(w);
  const power = pb.boost ? Math.ceil(basePow * (100 + pb.boost) / 100) : basePow;
  const wcrit = w.crit_lv9 ?? w.crit_lv5 ?? w.critical_rate ?? 0;
  box.innerHTML = `
    <span>武器：<b>${esc(w.name)}</b></span>
    <span>类型 ${esc(`${w.attack_attr_label ?? "—"}/${w.attrs_label ?? w.weapon_attr_label ?? "—"}`)}</span>
    <span>依赖 ${esc(w.pilot_stat ?? "—")}</span>
    <span>威力 <input id="pair-wp-input" type="number" value="${power}" min="0">${pb.effects.length ? `<span class="muted" title="${esc(pb.effects.map((e) => `${e.name}+${e.pct}%`).join("；"))}">（含特效）</span>` : ""}</span>
    <span>暴击率 <input id="pair-crit-input" type="number" value="${wcrit}" min="0" max="100">%</span>
    <span>暴击伤害 <input id="pair-critdmg-input" type="number" value="0" min="0">%</span>
    <button class="pair-sel-clear" aria-label="清除选择" id="pair-clear-weapon" title="清除武器">×</button>`;
  $("#pair-clear-weapon").addEventListener("click", () => {
    pairState.weapon = null;
    renderWeaponInfo();
    updatePairMatchBtn();
  });
}

async function runPairMatch() {
  const msg = $("#pair-msg");
  const u = pairState.unit;
  if (!u) { msg.textContent = "请先选择机体"; return; }
  if (pairState.action === "attack" && !pairState.weapon) { msg.textContent = "请先选择武器"; return; }
  const q = new URLSearchParams({
    unit_id: u.id, action: pairState.action,
    weapon_id: pairState.weapon ? pairState.weapon.id : "",
    bench: pairState.bench,
  });
  if (pairState.action === "attack") {
    q.set("evigor", $("#pair-vigor").value);
    q.set("atk_us", pairState.atkUs.join(","));
    q.set("ext_pct", String((Number($("#pair-ext-sup").value) || 0) + (Number($("#pair-ext-op").value) || 0)));
    q.set("ext_fixed", $("#pair-ext-fixed").value);
    q.set("wp_ov", $("#pair-wp-input")?.value ?? "");
    q.set("crit_ov", $("#pair-crit-input")?.value ?? "");
    q.set("critdmg_ov", $("#pair-critdmg-input")?.value ?? "");
  } else {
    q.set("eua", $("#pair-enemy-ua").value);
    q.set("epa", $("#pair-enemy-pa").value);
    q.set("ewp", String(renderEnemyPower()));
    q.set("ewt", $("#pair-enemy-wt").value);
    q.set("ewaa", $("#pair-enemy-waa").value);
    q.set("etags", pairState.enemyTags.join(","));
    q.set("eseries", pairState.enemySeries.map((x) => x.id).join(","));
    q.set("eguard", $("#pair-enemy-guard").value);
    q.set("eir", $("#pair-enemy-ir").checked ? "1" : "0");
    q.set("evigor", $("#pair-enemy-vigor").value);
    q.set("eterrain", $("#pair-enemy-terrain").value);
    q.set("ecrit", $("#pair-enemy-crit").value);
    q.set("ext_pct", String((Number($("#pair-ext-sup").value) || 0) + (Number($("#pair-ext-op").value) || 0)));
    q.set("ext_fixed", $("#pair-ext-fixed").value);
    q.set("hp_pct", $("#pair-ext-hp").value);
    q.set("hp_fixed", $("#pair-ext-hpf").value);
  }
  collectPairFilterInputs();
  pairFilterState.sort = "score";
  pairFilterState.order = "desc";
  appendPairFilterParams(q);
  pairLastQuery = q.toString();
  msg.textContent = "正在匹配…";
  try {
    const res = await api("/api/pairing/match?" + q);
    msg.textContent = "";
    renderPairResult(res);
  } catch (e) {
    msg.textContent = "匹配失败：" + (e.message || e);
  }
}

function pairMechChips(mechs) {
  if (!mechs || !mechs.length) return '<span class="muted">—</span>';
  return mechs.slice(0, 8).map((m) =>
    `<span class="chip ${m.kind === "enemy_cond" || m.kind === "unverifiable" ? "cond" : ""}" title="${esc(m.label)}">${esc(m.label.length > 16 ? m.label.slice(0, 16) + "…" : m.label)}</span>`).join("") +
    (mechs.length > 8 ? ` <span class="muted">+${mechs.length - 8}</span>` : "");
}

function pairTrigChips(trig) {
  if (!trig || !trig.length) return '<span class="muted">—</span>';
  return trig.map((t) =>
    `<span class="chip" title="${esc(`${t.name}：${t.desc}`)}">${esc(t.name || "能力")}</span>`).join("");
}

function pairClassChips(list) {
  if (!list || !list.length) return '<span class="muted">—</span>';
  return list.map((x) =>
    `<span class="chip" title="${esc(`${x.name}：${x.desc}（${x.reason}）`)}">${esc(x.name || "能力")}</span>`).join("");
}

function pairSkillChips(skills) {
  if (!skills || !skills.length) return '<span class="muted">—</span>';
  return skills.map((s) =>
    `<span class="chip" title="${esc(s.desc || "")}">${esc(s.name || "—")}</span>`).join("");
}

function renderPairResult(res) {
  if (res.error) { $("#pair-msg").textContent = res.error; return; }
  const isAtk = res.action === "attack";
  const head = buildPairHead(isAtk);
  /* Step 7: 计算最大分数用于分段分数条归一化 */
  const maxScore = Math.max(1, ...res.pilots.map((p) => Number(p.score) || 0));
  const scoreCell = (score) => `<td class="num">
    <div style="display:flex;flex-direction:column;gap:4px;min-width:110px">
      <span style="font-weight:700;color:#eef1f5">${fmtNum(score)}</span>
      <span class="seg-score-bar tier-${(Number(score) || 0) / maxScore >= 0.85 ? "s" : (Number(score) || 0) / maxScore >= 0.7 ? "a" : (Number(score) || 0) / maxScore >= 0.55 ? "b" : (Number(score) || 0) / maxScore >= 0.4 ? "c" : "low"}" style="height:5px">
        ${Array.from({ length: 10 }, (_, i) =>
          `<span class="${i < Math.round(((Number(score) || 0) / maxScore) * 10) ? "on" : ""}"></span>`).join("")}
      </span>
    </div></td>`;
  const rows = res.pilots.map((p, i) => {
    const td = isAtk
      ? `${scoreCell(p.score)}<td class="num">${p.crit_damage}</td>
         <td class="num">${p.crit_rate}%</td><td>${esc(p.dep_label)}</td><td class="num">${p.dep_value}</td>`
      : `${scoreCell(p.score)}<td class="num">${p.survive}</td><td class="num">${p.survive_crit}</td>
         <td class="num">${p.first_damage}</td><td class="num">${p.defense}</td><td class="num">${p.dmg_down}%</td>`;
    const trigCell = isAtk
      ? (p.support_mech || []).map((m) =>
          `<span class="chip" title="${esc(m.label)}">${esc(m.label.length > 12 ? m.label.slice(0, 12) + "…" : m.label)}</span>`).join("") + pairTrigChips(p.triggered)
      : (p.support_mech || []).map((m) =>
          `<span class="chip" title="${esc(m.label)}">${esc(m.label.length > 12 ? m.label.slice(0, 12) + "…" : m.label)}</span>`).join("") + pairTrigChips(p.triggered);
    return `<tr class="pair-pilot" data-id="${p.id}">
      <td class="num">${i + 1}</td><td>${esc(p.name)}</td>
      <td>${rarityBadge(p.rarity)}</td><td>${roleBadge(p.role, p.role_label)}</td>
      ${td}
      ${isAtk
        ? `<td>${trigCell}</td><td>${pairClassChips(p.potential)}</td><td>${pairClassChips(p.impossible)}</td><td>${pairSkillChips(p.skills)}</td>`
        : `<td>${trigCell}</td><td>${pairClassChips(p.potential)}</td><td>${pairClassChips(p.impossible)}</td><td>${pairSkillChips(p.skills)}</td>`}
      <td><button class="cond-btn pair-to-damage" data-pid="${p.id}" title="把该驾驶员代入伤害计算">代入</button></td>
    </tr>`;
  }).join("");
  const first = res.pilots[0] || {};
  const unitAb = (pairState.unitDetail?.abilities || []).map((a) =>
    `<span class="chip" title="${esc(a.desc || "")}">${esc(a.name || "能力")}</span>`).join("");
  const unitSk = (pairState.unitDetail?.skills || []).map((s) =>
    `<span class="chip" title="${esc(s.desc || "")}">${esc(s.name || "技能")}</span>`).join("");
  const headInfo = `
    <div class="pair-head-unit">${rarityBadge(res.unit.rarity)} <b>${esc(res.unit.name)}</b> <span class="chip">${esc(res.unit.role_label)}</span></div>
    ${isAtk
      ? `<div>机体攻击（满星满级）：<b>${res.unit_attack}</b></div>`
      : `<div>HP <b>${first.unit_hp ?? "—"}</b> · 防御 <b>${first.unit_defense ?? "—"}</b></div>`}
    ${unitAb ? `<div>单位能力：${unitAb}</div>` : ""}
    ${unitSk ? `<div>单位技能：${unitSk}</div>` : ""}
  `;
  const hasCond = Boolean(
    pairFilterState.q || pairFilterState.rarity || pairFilterState.acq ||
    pairFilterState.series || pairFilterState.type || pairFilterState.tags.length ||
    pairFilterState.skills.length || pairFilterState.support);
  $("#pair-result").innerHTML = `
    <div class="pair-result-panel">
      ${headInfo}
      <div class="result-count">共 ${res.total ?? res.pilots.length} 名驾驶员${hasCond ? "（已按条件筛选）" : ""}</div>
      <div style="max-height:60vh;overflow:auto">
        <table>${head}${rows}</table>
      </div>
    </div>`;
  bindPairResultSort();
  document.querySelectorAll(".pair-pilot").forEach((r) =>
    r.addEventListener("click", () => openCharacter(r.dataset.id)));
  document.querySelectorAll(".pair-to-damage").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const pilot = res.pilots.find((x) => String(x.id) === b.dataset.pid);
      if (pilot) pairToDamageCalc(res, pilot);
    }));
  $("#pair-result").scrollIntoView({ behavior: "auto", block: "start" });
}

function sortTh(sort, label) {
  const active = pairFilterState.sort === sort;
  const arrow = active ? (pairFilterState.order === "asc" ? " ▲" : " ▼") : "";
  return `<th><button class="sort-th" data-sort="${sort}">${label}${arrow}</button></th>`;
}

function buildPairHead(isAtk) {
  const t = (s, l) => sortTh(s, l);
  return isAtk
    ? `<tr><th>#</th>${t("name","名称")}${t("rarity","稀有度")}${t("role","类型")}${t("score","得分（非暴击）")}${t("crit_damage","暴击伤害")}${t("crit_rate","暴击率")}<th>依赖属性</th>${t("dep_value","属性值")}<th>触发的能力</th><th>有可能触发</th><th>不能触发</th><th>驾驶员技能</th><th></th></tr>`
    : `<tr><th>#</th>${t("name","名称")}${t("rarity","稀有度")}${t("role","类型")}${t("score","得分（期望抵御）")}${t("survive","非暴击")}${t("survive_crit","暴击")}${t("first_damage","首次伤害")}${t("defense","驾驶员防御")}${t("dmg_down","减伤%")}<th>触发的能力</th><th>有可能触发</th><th>不能触发</th><th>驾驶员技能</th><th></th></tr>`;
}

function bindPairResultSort() {
  document.querySelectorAll(".pair-result-panel .sort-th").forEach((b) =>
    b.addEventListener("click", () => {
      const sort = b.dataset.sort;
      if (pairFilterState.sort === sort) {
        pairFilterState.order = pairFilterState.order === "asc" ? "desc" : "asc";
      } else {
        pairFilterState.sort = sort;
        pairFilterState.order = "desc";
      }
      if (pairLastQuery) refreshPairResult();
    }));
}

function renderPairFilterChips() {
  const tagBox = $("#pr-tag-chips");
  const skillBox = $("#pr-skill-chips");
  if (!tagBox || !skillBox) return;
  const tagsHtml = pairFilterState.tags.map((t) =>
    `<span class="chip sel-tag">${esc(t)}<button class="chip-x" aria-label="移除" data-t="${esc(t)}" title="移除">×</button></span>`).join("");
  const skillsHtml = pairFilterState.skills.map((s) =>
    `<span class="chip sel-tag">${esc(s)}<button class="chip-x" aria-label="移除" data-s="${esc(s)}" title="移除">×</button></span>`).join("");
  tagBox.innerHTML = tagsHtml;
  skillBox.innerHTML = skillsHtml;
  tagBox.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      pairFilterState.tags = pairFilterState.tags.filter((t) => t !== b.dataset.t);
      renderPairFilterChips();
    }));
  skillBox.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      pairFilterState.skills = pairFilterState.skills.filter((s) => s !== b.dataset.s);
      renderPairFilterChips();
    }));
}

function collectPairFilterInputs() {
  pairFilterState.q = $("#pr-q").value.trim();
  pairFilterState.rarity = $("#pr-rarity").value;
  pairFilterState.acq = $("#pr-acq").value;
  pairFilterState.type = $("#pr-type").value;
  pairFilterState.tag_mode = $("#pr-tag-mode").value;
  pairFilterState.skill_mode = $("#pr-skill-mode").value;
  pairFilterState.support = $("#pr-support").value;
  pairFilterState.match = $("#pr-match").value;
}

function appendPairFilterParams(q) {
  q.set("pq", pairFilterState.q);
  q.set("prarity", pairFilterState.rarity);
  q.set("pacq", pairFilterState.acq);
  q.set("pseries", pairFilterState.series);
  q.set("ptype", pairFilterState.type);
  q.set("ptags", pairFilterState.tags.join(","));
  q.set("ptag_mode", pairFilterState.tag_mode);
  q.set("pskills", pairFilterState.skills.join(","));
  q.set("pskill_mode", pairFilterState.skill_mode);
  q.set("psupport", pairFilterState.support);
  q.set("pmatch", pairFilterState.match);
  q.set("sort", pairFilterState.sort);
  q.set("order", pairFilterState.order);
}

function bindPairFilterRow() {
  if (!pairFilterData) {
    setTimeout(bindPairFilterRow, 300);
    return;
  }
  $("#pr-q").value = pairFilterState.q;
  $("#pr-rarity").value = pairFilterState.rarity;
  $("#pr-acq").value = pairFilterState.acq;
  $("#pr-type").value = pairFilterState.type;
  $("#pr-tag-mode").value = pairFilterState.tag_mode;
  $("#pr-skill-mode").value = pairFilterState.skill_mode;
  $("#pr-support").innerHTML = '<option value="">全部支援次数</option>' +
    pairFilterData.supportLabels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  $("#pr-support").value = pairFilterState.support;
  $("#pr-match").value = pairFilterState.match;
  initCombobox("#pr-series-box", pairFilterData.seriesOpts, () => pairFilterState.series,
    (v) => { pairFilterState.series = String(v); }, true);
  initCombobox("#pr-tag-box", pairFilterData.charTags, () => "",
    (v) => { if (v && !pairFilterState.tags.includes(v)) { pairFilterState.tags.push(v); renderPairFilterChips(); } }, false);
  initCombobox("#pr-skill-box", pairFilterData.skillNames, () => "",
    (v) => { if (v && !pairFilterState.skills.includes(v)) { pairFilterState.skills.push(v); renderPairFilterChips(); } }, false);
  $("#pr-q").addEventListener("keydown", (e) => { if (e.key === "Enter") runPairMatch(); });
  $("#pr-search").addEventListener("click", runPairMatch);
  $("#pr-reset").addEventListener("click", resetPairFilter);
  renderPairFilterChips();
}

function resetPairFilter() {
  pairFilterState.q = ""; pairFilterState.rarity = ""; pairFilterState.acq = "";
  pairFilterState.series = ""; pairFilterState.type = "";
  pairFilterState.tags = []; pairFilterState.tag_mode = "all";
  pairFilterState.skills = []; pairFilterState.skill_mode = "any";
  pairFilterState.support = ""; pairFilterState.match = "and";
  pairFilterState.sort = "score"; pairFilterState.order = "desc";
  $("#pr-q").value = ""; $("#pr-rarity").value = ""; $("#pr-acq").value = "";
  $("#pr-type").value = ""; $("#pr-tag-mode").value = "all";
  $("#pr-skill-mode").value = "any"; $("#pr-support").value = ""; $("#pr-match").value = "and";
  syncCombobox("#pr-series-box");
  renderPairFilterChips();
}

function resetPairAll() {
  /* 机体 */
  pairState.unit = null;
  pairState.unitDetail = null;
  pairState.weapon = null;
  pairState.atkUs = [];
  pairState.action = "attack";
  pairState.bench = "low";
  pairState.enemyTags = [];
  pairState.enemySeries = [];

  renderPairSelection();
  renderWeaponInfo();
  renderUnitSkillChips();
  renderEnemyChips();

  $("#pair-act-atk").classList.add("active");
  $("#pair-act-def").classList.remove("active");
  $("#pair-bench-low").classList.add("active");
  $("#pair-bench-mid").classList.remove("active");
  updatePairModeUI();
  $("#pair-vigor").value = "normal";

  /* 外部加成与敌方输入回默认值 */
  ["#pair-ext-sup", "#pair-ext-op", "#pair-ext-fixed", "#pair-ext-hp", "#pair-ext-hpf"]
    .forEach((sel) => { $(sel).value = "0"; });
  $("#pair-enemy-ua").value = "15000";
  $("#pair-enemy-pa").value = "800";
  $("#pair-enemy-wp").value = "5000";
  $("#pair-enemy-wpboost").value = "0";
  $("#pair-enemy-wt").value = "2";
  $("#pair-enemy-waa").value = "Ranged";
  $("#pair-enemy-guard").value = "2";
  $("#pair-enemy-vigor").value = "normal";
  $("#pair-enemy-terrain").value = "1.0";
  $("#pair-enemy-crit").value = "0";
  $("#pair-enemy-ir").checked = false;
  renderEnemyPower();

  /* 筛选条件 */
  resetPairFilter();

  /* 配对列表 */
  pairLastQuery = "";
  $("#pair-result").innerHTML = "";
  $("#pair-msg").textContent = "";
  updatePairMatchBtn();
}

async function refreshPairResult() {
  if (!pairLastQuery) return;
  collectPairFilterInputs();
  const q = new URLSearchParams(pairLastQuery);
  appendPairFilterParams(q);
  try {
    const res = await api("/api/pairing/match?" + q);
    renderPairResult(res);
  } catch (e) {
    $("#pair-msg").textContent = "筛选失败：" + (e.message || e);
  }
}

function pairToDamageCalc(res, pilot) {
  activateTab("damage");
  $("#modal").classList.add("hidden");
  const isAtk = res.action === "attack";
  const u = pairState.unitDetail;
  const unitInfo = {
    name: res.unit.name, rarity: res.unit.rarity,
    role: res.unit.role, role_label: res.unit.role_label,
  };
  const pilotInfo = {
    name: pilot.name, rarity: pilot.rarity,
    role: pilot.role, role_label: pilot.role_label,
  };
  if (isAtk) {
    calcSel.atkUnit = { id: res.unit.id, source: "library", star: 3,
      stat_bonuses: (u && u.stat_bonuses) || {}, max_hp: (u && u.max_hp) || 0 };
    calcSel.atkPilot = { id: pilot.id, source: "library",
      ranged: pilot.stats.ranged, melee: pilot.stats.melee,
      awaken: pilot.stats.awaken, defense: pilot.stats.defense };
    calcSel.atkWeapon = pairState.weapon || null;
    calcSel.atkUOn = []; calcSel.atkPOn = [];
    resetAbInit();
    $("#atk-unit-info").innerHTML = pickInfoText(unitInfo);
    $("#atk-pilot-info").innerHTML = pickInfoText(pilotInfo);
    $("#atk-unit-star").classList.remove("hidden");
    $("#atk-unit-star").value = "3";
    $("#d-aua").value = res.unit_attack;
    $("#d-aca").value = pilot.dep_value ?? pilot.stats.melee;
    if (calcSel.atkWeapon) {
      const w = calcSel.atkWeapon;
      $("#d-weapon-name").textContent = w.name || "—";
      $("#d-wtype").textContent = w.weapon_attr_label ?? "—";
      $("#d-wstat").textContent = w.pilot_stat ?? "—";
      $("#d-wp").value = res.weapon ? res.weapon.power : (w.power_lv5 ?? w.power);
      $("#d-wcrit").textContent = (pilot.crit_rate ?? 0) + "%";
    }
    $("#d-vigor-atk").value = res.enemy_cfg?.vigor ?? "normal";
    $("#d-buff").value = 0;
  } else {
    calcSel.defUnit = { id: res.unit.id, source: "library", star: 3,
      stat_bonuses: (u && u.stat_bonuses) || {}, max_hp: (u && u.max_hp) || 0 };
    calcSel.defPilot = { id: pilot.id, source: "library",
      ranged: pilot.stats.ranged, melee: pilot.stats.melee,
      awaken: pilot.stats.awaken, defense: pilot.stats.defense };
    calcSel.defUOn = []; calcSel.defPOn = [];
    resetAbInit();
    $("#def-unit-info").innerHTML = pickInfoText(unitInfo);
    $("#def-pilot-info").innerHTML = pickInfoText(pilotInfo);
    $("#def-unit-star").classList.remove("hidden");
    $("#def-unit-star").value = "3";
    $("#d-dud").value = firstUnitDef(res);
    $("#d-dhp").value = firstUnitHp(res);
    $("#d-dcd").value = pilot.defense;
    $("#d-aua").value = res.enemy_cfg.unit_attack;
    $("#d-aca").value = res.enemy_cfg.pilot_attack;
    $("#d-wp").value = res.enemy_cfg.power;
    $("#d-terrain").value = res.enemy_cfg.terrain;
    $("#d-vigor-atk").value = res.enemy_cfg.vigor;
    $("#d-crit").checked = (res.enemy_cfg.crit_rate || 0) >= 100;
    $("#d-defend-state").value = { 0: "none", 1: "defend", 2: "defend_shield" }[res.enemy_cfg.guard] ?? "defend_shield";
    $("#d-debuff").value = 0;
  }
  autoCalcBonuses();
}

function firstUnitDef(res) {
  return res.pilots[0] ? res.pilots[0].unit_defense : 0;
}
function firstUnitHp(res) {
  return res.pilots[0] ? res.pilots[0].unit_hp : 0;
}

function initPairing() {
  $("#pair-select-unit").addEventListener("click", openPairUnitPicker);
  $("#pair-reset-all").addEventListener("click", resetPairAll);
  $("#pair-match").addEventListener("click", runPairMatch);
  $("#pair-act-atk").addEventListener("click", () => setPairAction("attack"));
  $("#pair-act-def").addEventListener("click", () => setPairAction("defense"));
  $("#pair-bench-low").addEventListener("click", () => setPairBench("low"));
  $("#pair-bench-mid").addEventListener("click", () => setPairBench("mid"));
  $("#pair-select-weapon").addEventListener("click", openPairWeaponPicker);
  $("#pair-select-uskill").addEventListener("click", openUnitSkillPicker);
  $("#pair-enemy-tags-btn").addEventListener("click", openEnemyTagPicker);
  $("#pair-enemy-default").addEventListener("click", () => applyDefaultEnemy());
  $("#pair-enemy-wp").addEventListener("input", renderEnemyPower);
  $("#pair-enemy-wpboost").addEventListener("input", renderEnemyPower);
  $("#pair-picker-close").addEventListener("click", () => $("#pair-picker-modal").classList.add("hidden"));
  $("#pair-picker-modal").addEventListener("click", (e) => {
    if (e.target === $("#pair-picker-modal")) $("#pair-picker-modal").classList.add("hidden");
  });
  $("#enemy-picker-close").addEventListener("click", () => $("#enemy-picker-modal").classList.add("hidden"));
  $("#enemy-picker-modal").addEventListener("click", (e) => {
    if (e.target === $("#enemy-picker-modal")) $("#enemy-picker-modal").classList.add("hidden");
  });
  $("#ep-ok").addEventListener("click", () => $("#enemy-picker-modal").classList.add("hidden"));
  $("#ep-cancel").addEventListener("click", () => $("#enemy-picker-modal").classList.add("hidden"));
  $("#ep-clear").addEventListener("click", () => {
    pairState.enemyTags = [];
    pairState.enemySeries = [];
    renderEnemyChips();
  });
  $("#pp-search").addEventListener("click", () => ppLoad(0));
  $("#pp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") ppLoad(0); });
  $("#pp-reset").addEventListener("click", () => {
    pairUnitState.q = ""; pairUnitState.rarity = ""; pairUnitState.acq = "";
    pairUnitState.series = ""; pairUnitState.type = ""; pairUnitState.tags = [];
    pairUnitState.tag_mode = "all"; pairUnitState.match = "and";
    pairUnitState.wfx = []; pairUnitState.wfx_mode = "any"; pairUnitState.page = 0;
    $("#pp-q").value = ""; $("#pp-rarity").value = ""; $("#pp-acq").value = "";
    $("#pp-type").value = ""; $("#pp-tag-mode").value = "all"; $("#pp-match").value = "and";
    $("#pp-wfx-mode").value = "any";
    syncCombobox("#pp-series-box");
    renderPairTagChips();
    renderPairWfxChips();
    ppLoad(0);
  });
  ["#pp-rarity", "#pp-acq", "#pp-type", "#pp-tag-mode", "#pp-match", "#pp-wfx-mode"]
    .forEach((sel) => $(sel).addEventListener("change", () => ppLoad(0)));
}

/* ---------- 组队 ---------- */
const teamState = {
  bench: "low",
  customEnemy: { unit_defense: 1060, character_defense: 109 },
  teams: [],
};
const TEAM_LS_KEY = "gundam.teams.v1";
let teamResults = {};

function newTeamSlot() { return { unit: null, star: 3, weapon: null, pilot: null }; }
function newTeam() {
  return { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    supporter: null, breakStep: 3,
    slots: [newTeamSlot(), newTeamSlot(), newTeamSlot(), newTeamSlot(), newTeamSlot()] };
}

function saveTeamState() {
  // 本地降级缓存（断网/未配置后端时仍可用）
  try {
    localStorage.setItem(TEAM_LS_KEY, JSON.stringify({
      bench: teamState.bench, customEnemy: teamState.customEnemy, teams: teamState.teams,
    }));
  } catch (_) {}
  // 同步到后端（fire-and-forget，失败忽略，不阻塞 UI）
  try {
    (teamState.teams || []).forEach((t) => {
      apiPost("/api/team/save", {
        team_id: t.id,
        name: t.name || "",
        data: {
          supporter: t.supporter || null,
          breakStep: t.breakStep ?? 3,
          slots: (t.slots || []).map((s) => ({
            unit: s.unit || null, star: s.star ?? 3,
            weapon: s.weapon || null, pilot: s.pilot || null,
          })),
        },
      }).catch(() => {});
    });
    apiPost("/api/team/config", {
      bench: teamState.bench,
      customEnemy: teamState.customEnemy,
    }).catch(() => {});
  } catch (_) {}
}

function loadTeamState() {
  // 同步先填 localStorage（离线可用、即时渲染），随后异步用后端数据覆盖
  try {
    const raw = localStorage.getItem(TEAM_LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.teams)) {
        teamState.bench = d.bench || "low";
        teamState.customEnemy = d.customEnemy || { unit_defense: 1060, character_defense: 109 };
        teamState.teams = d.teams.map((t) => ({
          id: t.id || newTeam().id,
          supporter: t.supporter || null,
          breakStep: t.breakStep ?? 3,
          slots: (Array.isArray(t.slots) && t.slots.length === 5)
            ? t.slots.map((s) => ({ unit: s.unit || null, star: s.star ?? 3, weapon: s.weapon || null, pilot: s.pilot || null }))
            : [newTeamSlot(), newTeamSlot(), newTeamSlot(), newTeamSlot(), newTeamSlot()],
        }));
      }
    }
  } catch (_) {}
  // 异步从后端拉取（后端优先）；后端为空则把本地现有队伍迁移上去
  fetchTeamFromServer();
}

async function fetchTeamFromServer() {
  try {
    const r = await fetch("/api/team/list");
    const d = await r.json();
    if (!d || !d.ok) return;
    if (d.teams && d.teams.length) {
      teamState.teams = d.teams.map((t) => ({
        id: t.team_id,
        name: t.name || "",
        supporter: (t.payload && t.payload.supporter) || null,
        breakStep: (t.payload && t.payload.breakStep) ?? 3,
        slots: ((t.payload && t.payload.slots) || []).map((s) => ({
          unit: s.unit || null, star: s.star ?? 3,
          weapon: s.weapon || null, pilot: s.pilot || null,
        })),
      }));
      renderTeam();
    }
    if (d.config && d.config.payload) {
      teamState.bench = d.config.payload.bench || teamState.bench;
      teamState.customEnemy = d.config.payload.customEnemy || teamState.customEnemy;
      syncTeamBenchUI();
    }
    // 后端为空但本地有数据 → 迁移一次（之后以云端为准）
    if ((!d.teams || !d.teams.length) && teamState.teams.length) {
      saveTeamState();
    }
  } catch (_) {}
}

function teamBenchConfig() {
  if (teamState.bench === "custom") {
    return {
      bench: "custom",
      custom_enemy: {
        unit_defense: Number($("#team-custom-udef").value) || 0,
        character_defense: Number($("#team-custom-cdef").value) || 0,
      },
    };
  }
  return { bench: teamState.bench };
}

function collectTeamPairs(team) {
  return team.slots.map((s) => ({
    unit_id: s.unit ? s.unit.id : 0,
    star: s.star,
    weapon_id: s.weapon ? s.weapon.id : 0,
    pilot_id: s.pilot ? s.pilot.id : 0,
  }));
}

async function computeTeam(teamId) {
  const team = teamState.teams.find((t) => t.id === teamId);
  if (!team) return;
  const body = Object.assign({}, teamBenchConfig(), {
    supporter_id: team.supporter ? team.supporter.id : null,
    break_step: team.breakStep,
    pairs: collectTeamPairs(team),
  });
  try {
    const r = await apiPost("/api/team/score", body);
    if (r && r.ok) {
      teamResults[teamId] = r;
      renderTeam();
    }
  } catch (_) {}
}

function renderTeam() {
  const list = $("#team-list");
  if (!list) return;
  if (!teamState.teams.length) {
    list.innerHTML = '<div class="empty">还没有队伍，点击上方「＋ 新增队伍」创建。</div>';
    return;
  }
  list.innerHTML = teamState.teams.map((t) => renderTeamRow(t)).join("");
}

function renderTeamRow(team) {
  const res = teamResults[team.id];
  const sup = res ? res.supporter : null;
  const unitCards = team.slots.map((s, i) => renderUnitCard(team, s, i, res ? res.pairs[i] : null)).join("");
  const pilotCards = team.slots.map((s, i) => renderPilotCard(team, s, i, res ? res.pairs[i] : null)).join("");
  const matched = sup ? sup.matched_units.length : 0;
  return `
    <div class="pair-panel team-row">
      <div class="team-row-head">
        <span class="team-title">队伍</span>
        ${sup ? `<span class="muted">支援「${esc(sup.name)}」全能力 +${sup.leader_pct}% · 匹配机体 ${matched}/5</span>`
          : (team.supporter ? '<span class="muted">计算中…</span>' : '<span class="muted">未选择支援角色</span>')}
        <button class="cond-btn team-remove" data-team="${esc(team.id)}" title="删除本队">删除</button>
      </div>
      <div class="team-grid">
        ${renderSupporterCard(team, sup)}
        ${unitCards}
        ${pilotCards}
      </div>
    </div>`;
}

function renderSupporterCard(team, sup) {
  const s = team.supporter;
  if (!s) {
    return `<div class="team-card team-supporter-card" data-team="${esc(team.id)}" data-kind="supporter">
      <div class="team-card-empty">＋ 选择支援角色</div></div>`;
  }
  const breakOpts = [0, 1, 2, 3].map((b) => {
    const pct = sup && sup.leader_pcts ? sup.leader_pcts[b] : "";
    return `<option value="${b}" ${b === team.breakStep ? "selected" : ""}>突破 ${b}${pct !== "" ? `（${pct}%）` : ""}</option>`;
  }).join("");
  const conds = sup && sup.conds ? sup.conds.map((c) =>
    ["系列：" + (c.series || []).join("、"), "标签：" + (c.tags || []).join("、")]
      .filter((x) => !x.endsWith("：")).join(" · ")
  ).filter(Boolean).join("；") : "";
  const skillsHtml = sup && sup.active_skills && sup.active_skills.length
    ? `<div class="team-skills">` + sup.active_skills.map((sk) =>
        `<div class="team-skill" title="${esc(sk.desc || "")}">${esc(sk.name)}${sk.is_auto_usage ? "（自动）" : ""}</div>`).join("") + `</div>`
    : "";
  return `<div class="team-card team-supporter-card" data-team="${esc(team.id)}" data-kind="supporter">
    <div class="team-card-name">${rarityBadge(s.rarity)} ${esc(s.name)}</div>
    <div class="team-card-ctl"><label>突破 <select class="team-break" data-team="${esc(team.id)}">${breakOpts}</select></label></div>
    ${sup ? `<div class="team-card-stats">
      <div class="team-stat"><span>全能力</span><b>+${sup.leader_pct}%</b></div>
      <div class="team-stat"><span>固定攻击</span><b>+${sup.atk_add}</b></div>
      <div class="team-stat"><span>固定HP</span><b>+${sup.hp_add}</b></div>
    </div>` : '<div class="muted">计算中…</div>'}
    ${skillsHtml}
    ${conds ? `<div class="team-conds" title="词条对象">${esc(conds)}</div>` : ""}
  </div>`;
}

function renderUnitCard(team, s, i, pr) {
  let name, statsHtml, weaponHtml, badge = "";
  if (s.unit) {
    name = `${rarityBadge(s.unit.rarity)} ${esc(s.unit.name)}`;
    const starOpts = [0, 1, 2, 3].map((b) => `<option value="${b}" ${b === s.star ? "selected" : ""}>${b} 星</option>`).join("");
    const ultimate = s.unit.ultimate;
    statsHtml = pr && pr.stats ? `
      <div class="team-stat"><span>攻击</span><b>${fmtNum(pr.stats.attack)}</b></div>
      <div class="team-stat"><span>防御</span><b>${fmtNum(pr.stats.defense)}</b></div>
      <div class="team-stat"><span>HP</span><b>${fmtNum(pr.stats.hp)}</b></div>
      <div class="team-stat"><span>机动</span><b>${fmtNum(pr.stats.mobility)}</b></div>` : '<div class="muted">计算中…</div>';
    weaponHtml = s.weapon
      ? `<div class="team-weapon">${esc(s.weapon.name)}${pr && pr.weapon && pr.weapon.damage != null ? ` · 伤害 ${fmtNum(pr.weapon.damage)}` : ""}</div>`
      : `<button class="team-weapon-btn" data-team="${esc(team.id)}" data-slot="${i}">选择武器</button>`;
    if (pr && pr.supporter_applied) badge = '<span class="team-applied" title="支援全能力生效">▲</span>';
    return `<div class="team-card team-unit-card" data-team="${esc(team.id)}" data-slot="${i}" data-kind="unit">
      ${badge}
      <div class="team-card-name">${name}</div>
      <div class="team-card-ctl"><label>星级 <select class="team-star" data-team="${esc(team.id)}" data-slot="${i}" ${ultimate ? "disabled" : ""}>${starOpts}</select></label></div>
      <div class="team-card-stats">${statsHtml}</div>
      ${weaponHtml}
    </div>`;
  }
  return `<div class="team-card team-unit-card" data-team="${esc(team.id)}" data-slot="${i}" data-kind="unit">
    <div class="team-card-empty">＋ 选择机体</div></div>`;
}

function renderPilotCard(team, s, i, pr) {
  if (!s.pilot) {
    return `<div class="team-card team-pilot-card" data-team="${esc(team.id)}" data-slot="${i}" data-kind="pilot">
      <div class="team-card-empty">＋ 选择驾驶员</div></div>`;
  }
  const statsHtml = pr && pr.pilot_stats ? `
    <div class="team-stat"><span>射击</span><b>${fmtNum(pr.pilot_stats.ranged)}</b></div>
    <div class="team-stat"><span>格斗</span><b>${fmtNum(pr.pilot_stats.melee)}</b></div>
    <div class="team-stat"><span>防御</span><b>${fmtNum(pr.pilot_stats.defense)}</b></div>
    <div class="team-stat"><span>反应</span><b>${fmtNum(pr.pilot_stats.reaction)}</b></div>
    <div class="team-stat"><span>觉醒</span><b>${fmtNum(pr.pilot_stats.awaken)}</b></div>` : '<div class="muted">计算中…</div>';
  return `<div class="team-card team-pilot-card" data-team="${esc(team.id)}" data-slot="${i}" data-kind="pilot">
    <div class="team-card-name">${rarityBadge(s.pilot.rarity)} ${esc(s.pilot.name)}</div>
    <div class="team-card-stats">${statsHtml}</div></div>`;
}

function onTeamListClick(e) {
  const removeBtn = e.target.closest(".team-remove");
  if (removeBtn) {
    const tid = removeBtn.dataset.team;
    if (confirm("删除这支队伍？")) {
      teamState.teams = teamState.teams.filter((t) => t.id !== tid);
      delete teamResults[tid];
      saveTeamState();
      renderTeam();
    }
    return;
  }
  const weaponBtn = e.target.closest(".team-weapon-btn");
  if (weaponBtn) {
    const tid = weaponBtn.dataset.team;
    const slot = Number(weaponBtn.dataset.slot);
    const team = teamState.teams.find((t) => t.id === tid);
    if (!team || !team.slots[slot].unit) return;
    openTeamWeaponPicker(team, slot);
    return;
  }
  if (e.target.closest(".team-star") || e.target.closest(".team-break")) return;
  const card = e.target.closest(".team-card");
  if (!card) return;
  const tid = card.dataset.team;
  const team = teamState.teams.find((t) => t.id === tid);
  if (!team) return;
  if (card.dataset.kind === "supporter") openTeamSupporterPicker(team);
  else if (card.dataset.kind === "unit") openTeamUnitPicker(team, Number(card.dataset.slot));
  else if (card.dataset.kind === "pilot") openTeamPilotPicker(team, Number(card.dataset.slot));
}

function onTeamListChange(e) {
  const starSel = e.target.closest(".team-star");
  if (starSel) {
    const team = teamState.teams.find((t) => t.id === starSel.dataset.team);
    if (!team) return;
    team.slots[Number(starSel.dataset.slot)].star = Number(starSel.value);
    saveTeamState();
    computeTeam(team.id);
    return;
  }
  const breakSel = e.target.closest(".team-break");
  if (breakSel) {
    const team = teamState.teams.find((t) => t.id === breakSel.dataset.team);
    if (!team) return;
    team.breakStep = Number(breakSel.value);
    saveTeamState();
    computeTeam(team.id);
  }
}

async function openTeamUnitPicker(team, slot) {
  // 队伍已选支援角色时，取其「词条」(标签) 作为机体选择器的默认过滤
  let defaultTags = [];
  if (team.supporter && team.supporter.id) {
    try {
      const sp = await api(`/api/supporters/${team.supporter.id}`);
      const set = new Set();
      const collect = (branches) => (branches || []).forEach((b) => {
        const subs = (b.subs && b.subs.length) ? b.subs : [{ tags: b.tags }];
        (subs || []).forEach((sd) => (sd.tags || []).forEach((t) => set.add(t)));
      });
      (sp.cond_groups || []).forEach((g) => (g.tags || []).forEach((t) => set.add(t)));
      (sp.leader_skills || []).forEach((ls) => collect(ls.branches));
      defaultTags = [...set].filter(Boolean);
    } catch (_) {}
  }
  await openPicker("unit", async (u) => {
    const dup = team.slots.some((s, i) => i !== slot && s.unit && String(s.unit.id) === String(u.id));
    if (dup) { alert("该机体已在队伍中，不能重复选择"); return; }
    const ultimate = (u.tags || []).includes("终极");
    team.slots[slot].unit = { id: u.id, name: u.name, rarity: u.rarity, role: u.role, role_label: u.role_label, ultimate };
    team.slots[slot].weapon = null;
    if (ultimate) team.slots[slot].star = 0;
    // 自动填原作驾驶员（可再手动改）
    try {
      const c = await api(`/api/canonical?unit_id=${u.id}`);
      if (c && c.pilot) {
        team.slots[slot].pilot = { id: c.pilot.id, name: c.pilot.name, rarity: c.pilot.rarity, role: c.pilot.role, role_label: c.pilot.role_label };
      }
    } catch (_) {}
    saveTeamState();
    computeTeam(team.id);
  }, null, null, { defaultTags });
}

async function openTeamPilotPicker(team, slot) {
  await openPicker("pilot", (p) => {
    const dup = team.slots.some((s, i) => i !== slot && s.pilot && String(s.pilot.id) === String(p.id));
    if (dup) { alert("该驾驶员已在队伍中，不能重复选择"); return; }
    team.slots[slot].pilot = { id: p.id, name: p.name, rarity: p.rarity, role: p.role, role_label: p.role_label };
    saveTeamState();
    computeTeam(team.id);
  });
}

async function openTeamSupporterPicker(team) {
  await openPicker("supporter", (x) => {
    team.supporter = { id: x.id, name: x.name, rarity: x.rarity };
    saveTeamState();
    computeTeam(team.id);
  });
}

async function openTeamWeaponPicker(team, slot) {
  await openPicker("weapon", (w) => {
    team.slots[slot].weapon = { id: w.id, name: w.name };
    saveTeamState();
    computeTeam(team.id);
  }, "team", { id: team.slots[slot].unit.id });
}

function syncTeamBenchUI() {
  $("#team-bench-low").classList.toggle("active", teamState.bench === "low");
  $("#team-bench-mid").classList.toggle("active", teamState.bench === "mid");
  $("#team-bench-custom").classList.toggle("active", teamState.bench === "custom");
  $("#team-custom-wrap").classList.toggle("hidden", teamState.bench !== "custom");
  $("#team-custom-udef").value = teamState.customEnemy.unit_defense;
  $("#team-custom-cdef").value = teamState.customEnemy.character_defense;
}

function setTeamBench(b) {
  teamState.bench = b;
  syncTeamBenchUI();
  saveTeamState();
  teamState.teams.forEach((t) => computeTeam(t.id));
}

let teamRecomputeTimer = null;
function scheduleTeamRecompute() {
  clearTimeout(teamRecomputeTimer);
  teamRecomputeTimer = setTimeout(() => {
    teamState.teams.forEach((t) => computeTeam(t.id));
  }, 300);
}

function initTeam() {
  $("#team-add").addEventListener("click", () => {
    teamState.teams.push(newTeam());
    saveTeamState();
    renderTeam();
  });
  $("#team-bench-low").addEventListener("click", () => setTeamBench("low"));
  $("#team-bench-mid").addEventListener("click", () => setTeamBench("mid"));
  $("#team-bench-custom").addEventListener("click", () => setTeamBench("custom"));
  ["#team-custom-udef", "#team-custom-cdef"].forEach((id) =>
    $(id).addEventListener("input", () => {
      teamState.customEnemy.unit_defense = Number($("#team-custom-udef").value) || 0;
      teamState.customEnemy.character_defense = Number($("#team-custom-cdef").value) || 0;
      saveTeamState();
      scheduleTeamRecompute();
    }));

  const list = $("#team-list");
  list.addEventListener("click", onTeamListClick);
  list.addEventListener("change", onTeamListChange);

  loadTeamState();
  syncTeamBenchUI();
  renderTeam();
  teamState.teams.forEach((t) => computeTeam(t.id));
}

/* ---------- 原作映射 ---------- */
const mapState = { signal: "", q: "", page: 0, size: 50 };
const MAP_SIGNAL_LABEL = { manual: "人工修正", active: "主动驾驶", mention: "名字出现", role: "系列类型" };

function mapSignalBadge(s) {
  return `<span class="chip map-signal" data-signal="${esc(s)}">${MAP_SIGNAL_LABEL[s] || s}</span>`;
}

async function loadMapping(page = mapState.page) {
  mapState.page = page;
  mapState.signal = $("#map-signal").value;
  mapState.q = $("#map-q").value.trim();
  const s = mapState;
  const params = new URLSearchParams({
    signal: s.signal, q: s.q, limit: s.size, offset: s.page * s.size,
  });
  const d = await api("/api/unit-pilot?" + params);
  $("#map-count").textContent = `共 ${d.total} 条映射`;
  $("#map-list").innerHTML = d.items.length
    ? `<table class="map-table"><tr><th>信号</th><th>机体</th><th>原作驾驶员</th><th class="map-act-col">操作</th></tr>` +
      d.items.map((r) => `
        <tr data-unit="${r.unit_id}">
          <td>${mapSignalBadge(r.signal)}</td>
          <td><button class="map-name" data-unit-id="${r.unit_id}">${esc(r.unit_name)}</button></td>
          <td><button class="map-name" data-pilot-id="${r.pilot_id}">${esc(r.pilot_name)}</button></td>
          <td class="map-act-col">
            <button class="cond-btn map-edit" data-unit="${r.unit_id}" title="重新选择该机体的原作驾驶员">改</button>
            <button class="cond-btn map-clear" data-unit="${r.unit_id}" title="清除该映射">清除</button>
          </td>
        </tr>`).join("") + `</table>`
    : '<div class="empty">暂无映射，请先运行 python scripts/build_unit_pilot.py</div>';
  $("#map-list").querySelectorAll("[data-unit-id]").forEach((b) =>
    b.addEventListener("click", () => openUnit(b.dataset.unitId)));
  $("#map-list").querySelectorAll("[data-pilot-id]").forEach((b) =>
    b.addEventListener("click", () => openCharacter(b.dataset.pilotId)));
  $("#map-list").querySelectorAll(".map-edit").forEach((b) =>
    b.addEventListener("click", () => openMappingEdit(Number(b.dataset.unit))));
  $("#map-list").querySelectorAll(".map-clear").forEach((b) =>
    b.addEventListener("click", () => clearMapping(Number(b.dataset.unit))));
  pager("map", d.total, s.page, s.size, loadMapping);
}

async function openMappingEdit(unitId) {
  await openPicker("pilot", async (p) => {
    await apiPost("/api/unit-pilot/edit", { unit_id: unitId, pilot_id: p.id });
    loadMapping(mapState.page);
  });
}

async function clearMapping(unitId) {
  if (!confirm("清除该机体的原作驾驶员映射？")) return;
  await apiPost("/api/unit-pilot/edit", { unit_id: unitId, pilot_id: null });
  loadMapping(mapState.page);
}

function initMapping() {
  $("#map-search").addEventListener("click", () => loadMapping(0));
  $("#map-q").addEventListener("keydown", (e) => { if (e.key === "Enter") loadMapping(0); });
  $("#map-signal").addEventListener("change", () => loadMapping(0));
}

/* ---------- 启动 ---------- */
initFilterControls();
initColumnResize();
initPairing();
bindPairFilterRow();
initTeam();
initMapping();
loadSummary();
