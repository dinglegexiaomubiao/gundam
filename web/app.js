const $ = (sel) => document.querySelector(sel);
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
    : "单分支"}）<button class="chip-x" id="unit-cond-clear" title="清除词条对象筛选">×</button></span>`;
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
async function loadSummary() {
  const d = await api("/api/summary");
  const c = d.counts || {};
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
  const dbStatus = !d.db_exists
    ? '<span class="chip cond">数据库不存在</span>'
    : d.db_has_data
      ? `<span class="chip cond">本地数据库可用（${d.db_size_mb} MB）</span>`
      : '<span class="chip cond">数据库为空，请导入数据</span>';
  $("#tab-overview").innerHTML = `
    <h3>数据概览</h3>
    <div class="overview-actions">
      ${dbStatus}
      <button id="ov-export" class="cond-btn" title="下载当前数据库文件">导出数据库</button>
      <button id="ov-import" class="cond-btn" title="导入数据库备份文件（自动保存到本地）">导入数据库</button>
      <button id="ov-crawl" class="cond-btn" title="从 soshage 全量抓取并构建数据库（仅手动触发）">爬取数据</button>
      <button id="ov-sync-up" class="cond-btn" title="以本地数据为准，覆盖云端服务器">上传本地到服务器</button>
      <button id="ov-sync-down" class="cond-btn" title="以云端服务器数据为准，覆盖本地">服务器同步到本地</button>
      <input type="file" id="ov-import-file" accept=".db" class="hidden">
      <span id="ov-msg" class="muted"></span>
    </div>
    <div class="stat-grid">${html}</div>
    <p class="desc">${d.db_has_data
      ? `数据库构建时间：${esc(d.built_at)}<br>数据已全量抓取完成（机体 1210 / 关卡 594）。`
      : "当前没有数据，可通过「导入数据库」恢复本地数据，或点击「爬取数据」全量抓取。"}<br>
    数据来源：soshage.com/gget（zh-CN），仅供个人研究。</p>`;
  bindOverviewActions(d);
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
  ["#ov-export", "#ov-import", "#ov-crawl", "#ov-sync-up", "#ov-sync-down"]
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
  crawlBtn.addEventListener("click", async () => {
    let edits = [];
    try {
      edits = await api("/api/crawl-edits");
    } catch (e) { /* 忽略 */ }
    if (edits.length) {
      showModal("爬取数据",
        `<p class="desc">全量爬取会用原始数据重建数据库，以下机体有本地编辑记录。勾选需要保留的编辑，未勾选的将被新数据覆盖：</p>
         <div id="crawl-keep-list" class="tags">${edits.map((x) =>
           `<label class="chip sel-tag"><input type="checkbox" value="${x.unit_id}" checked> ${esc(x.name)}（${x.edits} 项编辑）</label>`).join("")}</div>
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
  $("#char-support").innerHTML = '<option value="">全部支援次数</option>' +
    supportLabels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  initCombobox("#picker-series-box", seriesOpts, () => pickerState.series,
    (v) => { pickerState.series = String(v); }, true);
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

function renderSupSkillChips() {
  const box = $("#sup-skill-chips");
  if (!box) return;
  box.innerHTML = state.supporters.skills.length
    ? state.supporters.skills.map((v) =>
        `<span class="chip sel-tag">${esc(v)}
          <button class="chip-x" data-skill="${esc(v)}" title="移除">×</button>
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
    cond: s.cond ? JSON.stringify(s.cond) : "",
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
  const abilities = u.abilities.map((a) => `
    <tr>
      <td><button class="link-name" data-type="ability" data-name="${esc(a.name)}">${esc(a.name)}</button></td>
      <td class="desc">${effectHtml(a.effects, a.desc, a.cond_entities)}</td>
    </tr>`).join("");
  const unitSkills = (u.skills || []).map((s) => `
    <tr>
      <td>${esc(s.name || "单位技能")}</td>
      <td class="desc">${esc(s.desc || "—")}</td>
      <td>${s.duration ? `${s.duration} 回合` : "—"}</td>
    </tr>`).join("");
  const t = u.terrain || {};
  const terrain = Object.entries({ 宇宙: t.space, 大气圈: t.atmospheric, 地面: t.ground, 水面: t.surface, 水中: t.underwater })
    .map(([k, v]) => `<span class="chip">${k} ${v ?? "—"}</span>`).join("");
  unitEdit = null;
  showModal(
    `${esc(u.name)}<span class="unit-edit-btns">
       <button id="unit-edit-btn" class="cond-btn" title="进入编辑模式">修改机体数据</button>
       <button id="unit-save-btn" class="cond-btn" title="保存修改到本地">保存修改到本地</button>
       <button id="unit-sync-btn" class="cond-btn" title="同步该机体数据到服务器">同步机体数据到服务器</button>
     </span>`,
    `<p class="desc">${roleBadge(u.role, u.role_label)} ${esc(u.desc || "暂无描述")}</p>
     ${(u.series_names || []).length ? `<h3>系列（点击可搜索）</h3><div class="tags">${u.series_names.map((s) => `<button class="chip series-chip" data-series-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}
     <div id="unit-stats"></div>
     <h3>地形适性</h3><div class="tags">${terrain}</div>
     ${u.tags.length ? `<h3>标签（点击可搜索）</h3><div class="tags">${u.tags.map((t) => tagChip(t)).join("")}</div>` : ""}
     ${(u.wfx_matches || []).length ? `<h3>备注（点击可搜索）</h3><div class="tags">${WFX_OPTIONS.filter((o) => (u.wfx_matches || []).includes(o.value)).map((o) => `<button class="chip wfx-chip" data-wfx="${esc(o.value)}">${esc(o.label)}</button>`).join("")}</div>` : ""}
     <h3>武器（${u.weapons.length}）</h3>
     <table><tr><th>名称</th><th>类型</th><th>依赖属性</th><th>射程</th><th>威力(满级)</th><th>EN(满级)</th><th>命中(满级)</th><th>暴击(满级)</th><th>特效(满级)</th></tr>${weapons || '<tr><td colspan="9" class="empty">暂无武器数据</td></tr>'}</table>
     ${abilities ? `<h3>能力</h3><table><tr><th>名称</th><th>效果</th></tr>${abilities}</table>` : ""}
     ${unitSkills ? `<h3>单位技能（${(u.skills || []).length}）</h3><table><tr><th>名称</th><th>效果</th><th>持续</th></tr>${unitSkills}</table>` : ""}`);
  renderUnitStats(u, 0, "default");
  bindTagChips();
  bindSearchLinks();
  bindEffectChips();
  bindUnitInfoChips();
  bindUnitEditButtons(u);
}

function bindUnitInfoChips() {
  document.querySelectorAll(".series-chip").forEach((b) =>
    b.addEventListener("click", () => searchUnitsBySeries(Number(b.dataset.seriesId))));
  document.querySelectorAll(".wfx-chip").forEach((b) =>
    b.addEventListener("click", () => searchUnitsByWfx(b.dataset.wfx)));
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
  if (editBtn) editBtn.addEventListener("click", () => enterUnitEdit(u));
  if (saveBtn) saveBtn.addEventListener("click", () => saveUnitEdit());
  if (syncBtn) syncBtn.addEventListener("click", () => {
    openUnitSync(u.id);
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
  const s = unitEdit;
  const roleOpts = [[1, "攻击型"], [2, "耐久型"], [3, "支援型"]];
  const attrOpts = [[1, "射击"], [2, "格斗"], [3, "特殊"], [7, "EX"]];
  const dmgOpts = [[1, "实弹"], [2, "光束"], [3, "特殊"], [4, "特殊招式"], [6, "EX"]];
  const statCell = (prefix) => (k) =>
    `<td><input class="edit-input" data-stat="${prefix}" data-k="${k}" value="${s.stats[prefix][k] ?? ""}"></td>`;
  const statRow = (prefix, label) =>
    `<tr><th>${label}</th>${EDIT_STAT_KEYS.map(statCell(prefix)).join("")}</tr>`;
  const tagHtml = s.tags.map((t, i) =>
    `<span class="chip sel-tag">${esc(t)}${t === "终极" ? "" : `<button class="chip-x" data-tag-i="${i}" title="删除">×</button>`}</span>`).join("")
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
      <td><div class="tags">${w.effects.map((e, ei) => `<span class="chip sel-tag">${esc(e.name)}<button class="chip-x" data-wi="${wi}" data-ei="${ei}" title="移除特效">×</button></span>`).join("") || '<span class="muted">无</span>'}</div>
          <button class="cond-btn" data-add-effect="${wi}" style="margin-left:0">添加特效</button></td>
    </tr>`;
  }).join("");
  const abilityHtml = s.abilities.map((a, i) =>
    `<div class="edit-row"><span class="chip cond">${esc(a.name)}</span>
     <button class="edit-remove" data-ability-i="${i}" title="删除能力">×</button></div>`).join("")
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
  $("#char-list").innerHTML = d.items.length
    ? d.items.map((c) => `
      <div class="list-row chars" data-id="${c.id}">
        <span class="name">${esc(c.name)}</span>
        ${cell(rarityBadge(c.rarity))}
        ${cell(roleBadge(c.role, c.role_label))}
        <span class="num">${c.ranged_f}</span><span class="num">${c.melee_f}</span>
        <span class="num">${c.defense_f}</span><span class="num">${c.awaken_f}</span>
        <span class="num">${c.reaction_f}</span>
        <span class="num">${esc(c.support_label || "")}</span>
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
      <td>${sk.sp ?? "—"}</td><td>${sk.duration ?? "—"}</td><td class="desc">${effectHtml(sk.effects, sk.desc, sk.cond_entities)}</td></tr>`).join("");
  const abilities = c.abilities.map((a) => `
    <tr><td><button class="link-name" data-type="ability" data-name="${esc(a.name)}">${esc(a.name)}</button></td>
      <td class="desc">${effectHtml(a.effects, a.desc, a.cond_entities)}</td></tr>`).join("");
  showModal(c.name,
    `<p class="desc">${roleBadge(c.role, c.role_label)} ${esc(c.desc || "暂无描述")}</p>
     ${(c.series_names || []).length ? `<h3>系列（点击可搜索）</h3><div class="tags">${c.series_names.map((s) => `<button class="chip series-chip" data-series-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}
     <div id="char-stats"></div>
     ${c.tags.length ? `<h3>标签（点击可搜索）</h3><div class="tags">${c.tags.map((t) => tagChip(t)).join("")}</div>` : ""}
     ${c.support_label ? `<h3>备注（点击可搜索）</h3><div class="tags"><button class="chip support-chip" data-support="${esc(c.support_label)}">${esc(c.support_label)}</button></div>` : ""}
     <h3>技能（${c.skills.length}）</h3>
     <table><tr><th>名称</th><th>SP</th><th>持续</th><th>效果</th></tr>${skills || '<tr><td colspan="4" class="empty">无</td></tr>'}</table>
     <h3>能力</h3>
     <table><tr><th>名称</th><th>效果</th></tr>${abilities || '<tr><td colspan="2" class="empty">无</td></tr>'}</table>`);
  renderCharStats(c, "default");
  bindTagChips();
  bindSearchLinks();
  bindCharInfoChips();
}

function bindCharInfoChips() {
  document.querySelectorAll(".series-chip").forEach((b) =>
    b.addEventListener("click", () => searchCharactersBySeries(Number(b.dataset.seriesId))));
  document.querySelectorAll(".support-chip").forEach((b) =>
    b.addEventListener("click", () => searchCharactersBySupport(b.dataset.support)));
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
       <tr><td class="mono">+${s.max_hp_addition_value}</td><td class="mono">+${s.max_attack_addition_value}</td>
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
      renderSupporterLeaderStep(b.dataset.step);
    }));
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
const calcSel = {
  atkUnit: null, atkPilot: null, defUnit: null, defPilot: null,
  atkSkills: [], defSkills: [], atkUSkills: [], defUSkills: [],
  atkSupport: null, defSupport: null, atkOP: null, defOP: null,
  atkUOn: [], atkPOn: [], defUOn: [], defPOn: [],
  abInit: { atkU: false, atkP: false, defU: false, defP: false },
};
const calcSeq = { n: 0 };
const pickerState = { kind: "", side: "", q: "", source: "library", rarity: "", type: "", series: "", tags: "", sort: "rarity", order: "desc", page: 0, size: 20, onPick: null };

async function initPickerTagBox(kind) {
  if (kind !== "unit" && kind !== "pilot") return;
  const t = await api(`/api/tags?kind=${kind === "unit" ? "unit" : "character"}`);
  initCombobox("#picker-tag-box", t.map((x) => ({ value: x, label: x })),
    () => pickerState.tags, (v) => { pickerState.tags = String(v); }, true);
}

function togglePickerFilters() {
  const show = pickerState.source === "library" && (pickerState.kind === "unit" || pickerState.kind === "pilot");
  ["#picker-rarity", "#picker-type", "#picker-series-box", "#picker-tag-box"].forEach((sel) => {
    $(sel).classList.toggle("hidden", !show);
  });
}

async function openPicker(kind, onPick, side) {
  Object.assign(pickerState, {
    kind, side: side || "", q: "", source: "library",
    rarity: "", type: "", series: "", tags: "",
    sort: "rarity", order: "desc", page: 0, onPick,
  });
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
  syncCombobox("#picker-series-box");
  syncCombobox("#picker-tag-box");
  $("#picker-modal").classList.remove("hidden");
  await initPickerTagBox(kind);
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
  if (s.kind === "supporter") {
    const d = await api("/api/supporter-panel");
    const kw = s.q.trim();
    const list = d.filter((x) => !kw || x.name.includes(kw));
    $("#picker-list").innerHTML = list.length ? list.map((x) => `
      <div class="picker-row" data-i="${x.id}">
        <span class="name">${rarityBadge(x.rarity)} ${esc(x.name)}</span>
        <span class="muted">队长技 +${x.leader_pct}% · 固定攻击 +${x.atk_add}</span>
      </div>`).join("") : '<div class="empty">无匹配支援角色</div>';
    $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
      r.addEventListener("click", () => {
        const x = list.find((y) => String(y.id) === r.dataset.i);
        $("#picker-modal").classList.add("hidden");
        s.onPick(x);
      }));
    $("#picker-pager").innerHTML = "";
    return;
  }
  const ep = s.kind === "unit" ? "units" : "pilots";
  const params = new URLSearchParams({
    q: s.q, source: s.source, limit: s.size, offset: s.page * s.size,
  });
  if (s.source === "library") {
    params.set("rarity", s.rarity);
    params.set("type", s.type);
    params.set("series", s.series);
    params.set("tags", s.tags);
  }
  params.set("sort", s.sort);
  params.set("order", s.order);
  const d = await api(`/api/picker/${ep}?` + params);
  const isEntity = s.kind === "unit" || s.kind === "pilot";
  const statLabel = { ranged: "射击值", melee: "格斗值", awaken: "觉醒值" };
  const body = d.items.map((it) => {
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
    return `<div class="picker-row picker-grid" data-i="${it.id}">
      <span class="name">${esc(it.name)}</span>
      ${it.rarity ? rarityBadge(it.rarity) : "<span>—</span>"}
      <span>${it.role_label ? roleBadge(it.role, it.role_label) : "—"}</span>
      <span class="muted">${esc(tags)}</span>
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
    def_support: $("#def-support").value || 0,
    def_op: defOpPct,
    def_fixed: defOpFixed,
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
      <button class="chip-x" data-side="${side}" data-uskill="${esc(sk.name)}" title="移除">×</button>
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
      <button class="chip-x" data-side="${side}" data-skill="${esc(sk.name)}" title="移除">×</button>
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
  loadPicker(0);
});
$("#picker-reset").addEventListener("click", () => {
  Object.assign(pickerState, {
    q: "", rarity: "", type: "", series: "", tags: "",
    sort: "rarity", order: "desc", page: 0,
  });
  $("#picker-q").value = "";
  $("#picker-rarity").value = "";
  $("#picker-type").value = "";
  syncCombobox("#picker-series-box");
  syncCombobox("#picker-tag-box");
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
  $("#modal").classList.remove("hidden");
}
$("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) $("#modal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#modal").classList.add("hidden");
    $("#picker-modal").classList.add("hidden");
  }
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
