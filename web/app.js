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
    if (!confirm("将开始全量爬取数据（耗时较长），确定继续？")) return;
    crawlBtn.disabled = true;
    msg.textContent = "正在开始爬取…";
    try {
      const r = await fetch("/api/crawl", { method: "POST" });
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
  });
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
  const seriesOpts = series.map((s) => ({ value: s.id, label: s.name }));
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
  showModal(u.name,
    `<p class="desc">${roleBadge(u.role, u.role_label)} ${esc(u.desc || "暂无描述")}</p>
     <div id="unit-stats"></div>
     <h3>地形适性</h3><div class="tags">${terrain}</div>
     ${u.tags.length ? `<h3>标签（点击可搜索）</h3><div class="tags">${u.tags.map((t) => tagChip(t)).join("")}</div>` : ""}
     <h3>武器（${u.weapons.length}）</h3>
     <table><tr><th>名称</th><th>伤害类型</th><th>依赖属性</th><th>射程</th><th>威力(满级)</th><th>EN(满级)</th><th>命中(满级)</th><th>暴击(满级)</th><th>特效(满级)</th></tr>${weapons || '<tr><td colspan="9" class="empty">暂无武器数据</td></tr>'}</table>
     ${abilities ? `<h3>能力</h3><table><tr><th>名称</th><th>效果</th></tr>${abilities}</table>` : ""}
     ${unitSkills ? `<h3>单位技能（${(u.skills || []).length}）</h3><table><tr><th>名称</th><th>效果</th><th>持续</th></tr>${unitSkills}</table>` : ""}`);
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
  body.innerHTML = ls.branches.map((b, i) => `
    <div class="effect-block">
      <div class="effect">${esc(b.desc)}</div>
      <div class="tags"><button class="chip sup-branch" data-branch="${i}" title="点击搜索该分支的机体">${esc(b.text)}${condModeLabel(b.mode)}</button></div>
    </div>`).join("") || '<div class="empty">暂无加成分支</div>';
  body.querySelectorAll(".sup-branch").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const g = ls.branches[Number(b.dataset.branch)];
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
  atkSkills: [], defSkills: [],
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
    : kind === "unitability" ? "选择单位能力"
    : kind === "charability" ? "选择角色能力" : "选择技能";
  $("#picker-source").style.display =
    (kind === "weapon" || kind === "skill" || kind === "unitability" || kind === "charability") ? "none" : "";
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
        <span class="muted">${esc(w.weapon_attr_label ?? "")} ${esc(w.pilot_stat ?? "")}</span>
      </div>`).join("") : '<div class="empty">该机体暂无武器数据</div>';
    $("#picker-list").querySelectorAll(".picker-row").forEach((r) =>
      r.addEventListener("click", () => {
        const w = weapons.find((x) => String(x.id) === r.dataset.w);
        calcSel.atkWeapon = w;
        $("#d-wp").value = w.power_lv5 ?? w.power;
        $("#d-weapon-name").value = w.name || "—";
        $("#d-wtype").value = w.weapon_attr_label ?? "—";
        $("#d-wstat").value = w.pilot_stat ?? "—";
        $("#d-wcrit").value = (w.crit_lv5 ?? w.critical_rate ?? 0) + "%";
        const statMap = { 1: "ranged", 2: "melee", 3: "awaken" };
        const key = statMap[w.attack_attr];
        if (key && calcSel.atkPilot && calcSel.atkPilot[key] != null) {
          $("#d-aca").value = calcSel.atkPilot[key];
        }
        $("#picker-modal").classList.add("hidden");
        resetAbInit();
        autoCalcBonuses();
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
  return it.name ? `${it.name}${role}` : "";
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
  const q = new URLSearchParams({
    atk_uid: au ? au.id : "", atk_usrc: au ? au.source : "",
    atk_pid: ap ? ap.id : "", atk_psrc: ap ? ap.source : "",
    def_uid: du ? du.id : "", def_usrc: du ? du.source : "",
    def_pid: dp ? dp.id : "", def_psrc: dp ? dp.source : "",
    weapon_attr: w ? w.weapon_attr : "", attack_attr: w ? w.attack_attr : "",
    attr_nullify: w && (w.effects || []).some((e) =>
      ((e.name || "") + (e.desc || "")).includes("武装属性损伤减轻无效")) ? "1" : "0",
    atk_u_on: calcSel.atkUOn.join(","), atk_p_on: calcSel.atkPOn.join(","),
    def_u_on: calcSel.defUOn.join(","), def_p_on: calcSel.defPOn.join(","),
    atk_star: au ? (au.star || 0) : 0, def_star: du ? (du.star || 0) : 0,
    atk_skill_ranged: skillStats.ranged,
    atk_skill_melee: skillStats.melee,
    atk_skill_awaken: skillStats.awaken,
  });
  const d = await api("/api/damage-bonus?" + q);
  if (seq !== calcSeq.n) return;
  if (d.atk_unit_attack != null && au) $("#d-aua").value = d.atk_unit_attack;
  if (d.atk_pilot_attack != null && ap) $("#d-aca").value = d.atk_pilot_attack;
  if (d.def_unit_defense != null && du) $("#d-dud").value = d.def_unit_defense;
  if (d.def_unit_hp != null && du) $("#d-dhp").value = d.def_unit_hp;
  if (d.def_pilot_defense != null && dp) $("#d-dcd").value = d.def_pilot_defense;
  const atkSkillBuff = calcSel.atkSkills.reduce((s, x) => s + (x.buff || 0), 0);
  const defSkillDebuff = calcSel.defSkills.reduce((s, x) => s + (x.debuff || 0), 0);
  if (au || ap) $("#d-buff").value = (d.attacker_damage_bonus || 0) + atkSkillBuff;
  if (du || dp) $("#d-debuff").value = (d.defender_damage_taken || 0) + defSkillDebuff;
  calcSel.lastAbilities = d.abilities || {};
  const critDmg = attackerCritDmg(d.abilities || {});
  $("#d-wcritdmg").value = critDmg ? `+${critDmg}%` : "—";
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
  autoCalcBonuses();
}

$("#pick-atk-unit").addEventListener("click", () => openPicker("unit", async (it) => {
  calcSel.atkUnit = { ...it, star: 0 };
  calcSel.atkUOn = [];
  resetAbInit();
  $("#atk-unit-info").textContent = pickInfoText(it);
  $("#atk-unit-star").classList.remove("hidden");
  $("#atk-unit-star").value = "0";
  applyUnitStar("atk");
  await autoCalcBonuses();
}));
$("#pick-def-unit").addEventListener("click", () => openPicker("unit", async (it) => {
  calcSel.defUnit = { ...it, star: 0 };
  calcSel.defUOn = [];
  resetAbInit();
  $("#def-unit-info").textContent = pickInfoText(it);
  $("#def-unit-star").classList.remove("hidden");
  $("#def-unit-star").value = "0";
  applyUnitStar("def");
  await autoCalcBonuses();
}));
$("#atk-unit-star").addEventListener("change", () => applyUnitStar("atk"));
$("#def-unit-star").addEventListener("change", () => applyUnitStar("def"));
$("#pick-atk-pilot").addEventListener("click", () => openPicker("pilot", async (it) => {
  calcSel.atkPilot = { id: it.id, source: it.source, ranged: it.ranged, melee: it.melee, awaken: it.awaken, defense: it.defense };
  calcSel.atkPOn = [];
  resetAbInit();
  $("#atk-pilot-info").textContent = pickInfoText(it);
  const statMap = { 1: "ranged", 2: "melee", 3: "awaken" };
  const key = calcSel.atkWeapon ? statMap[calcSel.atkWeapon.attack_attr] : "ranged";
  $("#d-aca").value = (key && calcSel.atkPilot[key] != null) ? calcSel.atkPilot[key] : (it.ranged ?? "");
  await autoCalcBonuses();
}));
$("#pick-def-pilot").addEventListener("click", () => openPicker("pilot", async (it) => {
  calcSel.defPilot = { id: it.id, source: it.source, ranged: it.ranged, melee: it.melee, awaken: it.awaken, defense: it.defense };
  calcSel.defPOn = [];
  resetAbInit();
  $("#d-dcd").value = it.defense ?? "";
  $("#def-pilot-info").textContent = pickInfoText(it);
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
    const stats = { ranged: 0, melee: 0, awaken: 0 };
    const statAlias = { "射击值": "ranged", "格斗值": "melee", "觉醒值": "awaken" };
    (sk.effects || []).forEach((e) => {
      const m1 = e.match(/损伤提升\s*(\d+)%/);
      if (m1) buff += Number(m1[1]);
      const m2 = e.match(/损伤减轻\s*(\d+)%/);
      if (m2) debuff += Number(m2[1]);
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
      arr.push({ name: sk.name, buff, debuff, stats });
    }
    renderSkills(side);
    autoCalcBonuses();
  }, side);
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
    shield: $("#d-shield").checked ? "1" : "0",
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
  if (first) {
    $("#d-summary").innerHTML =
      `<div class="damage-final">本次攻击伤害 <b>${first.damage}</b></div>` +
      `<div class="remain-hp">防御方剩余 HP：<b>${first.hp}</b>（${first.hp_pct}%）</div>`;
  }
  const totalDmg = hits.reduce((s, h) => s + h.damage, 0);
  const avgDmg = hits.length ? Math.round(totalDmg / hits.length) : 0;
  const finalDef = hits.length ? hits[hits.length - 1].defense : 0;
  $("#d-result-body").innerHTML = hits.length ? `
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

function resetDamage() {
  $("#d-aua").value = 3000;
  $("#d-aca").value = 800;
  $("#d-dud").value = 2800;
  $("#d-dcd").value = 750;
  $("#d-dhp").value = 0;
  $("#d-wp").value = 5000;
  $("#d-wtype").value = "—";
  $("#d-wstat").value = "—";
  $("#d-weapon-name").value = "—";
  $("#d-wcrit").value = "—";
  $("#d-wcritdmg").value = "—";
  $("#d-terrain").value = 1.0;
  $("#d-vigor-atk").value = "normal";
  $("#d-vigor-def").value = "normal";
  $("#d-buff").value = 0;
  $("#d-debuff").value = 0;
  $("#d-crit").checked = false;
  $("#d-shield").checked = false;
  calcSel.atkUnit = calcSel.atkPilot = null;
  calcSel.defUnit = calcSel.defPilot = null;
  calcSel.atkWeapon = null;
  calcSel.atkSkills = [];
  calcSel.defSkills = [];
  calcSel.atkUOn = []; calcSel.atkPOn = [];
  calcSel.defUOn = []; calcSel.defPOn = [];
  resetAbInit();
  ["atk-unit-info", "atk-pilot-info", "def-unit-info", "def-pilot-info"].forEach((id) => {
    $(`#${id}`).textContent = "";
  });
  ["#atk-unit-ab", "#atk-pilot-ab", "#def-unit-ab", "#def-pilot-ab"].forEach((id) => {
    $(id).innerHTML = "";
  });
  renderSkills("atk");
  renderSkills("def");
  $("#atk-unit-star").classList.add("hidden");
  $("#def-unit-star").classList.add("hidden");
  $("#d-result-body").innerHTML = "";
  $("#d-summary").innerHTML = "";
}
$("#d-reset").addEventListener("click", resetDamage);

function resetSide(side) {
  if (side === "atk") {
    calcSel.atkUnit = calcSel.atkPilot = null;
    calcSel.atkWeapon = null;
    calcSel.atkSkills = [];
    calcSel.atkUOn = [];
    calcSel.atkPOn = [];
    resetAbInit();
    $("#d-aua").value = 3000;
    $("#d-aca").value = 800;
    $("#d-wp").value = 5000;
    $("#d-wtype").value = "—";
    $("#d-wstat").value = "—";
    $("#d-weapon-name").value = "—";
    $("#d-wcrit").value = "—";
    $("#d-wcritdmg").value = "—";
    renderSkills("atk");
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
    calcSel.defUOn = [];
    calcSel.defPOn = [];
    resetAbInit();
    $("#d-dud").value = 2800;
    $("#d-dhp").value = 0;
    $("#d-dcd").value = 750;
    renderSkills("def");
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
