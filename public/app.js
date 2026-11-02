/* 言語系学会連合 広報支援アプリ — フロントエンド（依存なし） */
'use strict';

const STATUS_LABEL = { new: '新着', accepted: '採用', drafted: '投稿案あり', posted: '投稿済み', rejected: '見送り' };
const STATUS_ORDER = ['new', 'accepted', 'drafted', 'posted', 'rejected'];
const RUN_STATUS = { changed: '新着あり', 'changed-noitems': '更新あり（対象なし）', nochange: '変化なし', baseline: '初回取得', error: 'エラー' };

let S = { societies: [], items: [], runs: [], settings: {}, currentRun: null, aiAvailable: false };
let pollTimer = null;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const soc = (id) => S.societies.find(s => s.id === id) || { name: '（不明な学会）', url: '' };
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '';
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u || ''; } };

// X の文字数（サーバー側 lib/text.js と同じ規則）
function xLength(text) {
  if (!text) return 0;
  let n = 0;
  const rest = text.replace(/https?:\/\/[^\s]+/g, () => { n += 23; return ''; });
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
async function loadState() {
  S = await api('GET', '/api/state');
  updateBadge();
  if (S.currentRun && !S.currentRun.finishedAt) startPolling();
}
function updateBadge() {
  const n = S.items.filter(i => i.status === 'new').length;
  const b = $('#badge-new'); b.hidden = n === 0; b.textContent = n > 99 ? '99+' : n;
}

// ---------- Snackbar ----------
let snackTimer;
function snack(msg, isError = false) {
  const el = $('#snackbar'); el.textContent = msg; el.className = 'snackbar' + (isError ? ' error' : ''); el.hidden = false;
  clearTimeout(snackTimer); snackTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}
async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) snack(okMsg); return r; } catch (e) { snack(e.message, true); throw e; }
}

// ---------- Dialog ----------
function openDialog(html) {
  const d = $('#dialog'); d.innerHTML = html; if (!d.open) d.showModal(); d.scrollTop = 0;
  $$('[data-close]', d).forEach(b => b.onclick = () => d.close());
  return d;
}
function closeDialog() { $('#dialog').close(); }

// ---------- Router ----------
function route() {
  const dlg = $('#dialog'); if (dlg && dlg.open) dlg.close();
  const view = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  $$('.rail-item').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  const views = { dashboard: renderDashboard, items: renderItems, societies: renderSocieties, runs: renderRuns, settings: renderSettings };
  (views[view] || renderDashboard)();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- Crawl polling ----------
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const run = await api('GET', '/api/runs/current');
      S.currentRun = run;
      renderCrawlCard();
      if (!run || run.finishedAt) {
        clearInterval(pollTimer); pollTimer = null;
        await loadState();
        snack(run ? `巡回が完了しました：新着 ${run.newItems || 0} 件` : '巡回が完了しました');
        route();
      }
    } catch { /* 一時的な失敗は無視 */ }
  }, 1500);
}
async function startCrawl(societyIds = null) {
  await guard(async () => {
    const run = await api('POST', '/api/crawl', { societyIds });
    S.currentRun = run; startPolling(); renderCrawlCard();
  }, societyIds ? '巡回を開始しました' : `全 ${S.societies.filter(s => s.active !== false).length} 学会の巡回を開始しました`);
}

// ======================================================================
// ダッシュボード
// ======================================================================
function renderDashboard() {
  const items = S.items;
  const month = new Date().toISOString().slice(0, 7);
  const cnt = {
    new: items.filter(i => i.status === 'new').length,
    waiting: items.filter(i => i.status === 'accepted' || i.status === 'drafted').length,
    posted: items.filter(i => i.status === 'posted' && (i.postedAt || '').startsWith(month)).length,
    errors: S.societies.filter(s => s.active !== false && /error/.test(s.lastStatus || '')).length,
  };
  const recent = items.filter(i => i.status === 'new').slice(0, 10);
  const lastRun = S.runs.find(r => r.finishedAt);
  $('#main').innerHTML = `
    <div class="topbar"><h1>ホーム</h1><span class="sub">${esc(new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }))}</span></div>
    <div class="grid stats">
      <a class="card stat tint-primary" href="#/items?status=new"><span class="label"><span class="ico sm">new_releases</span>新着（未確認）</span><span class="value">${cnt.new}</span><span class="hint">採用／見送りを判断</span></a>
      <a class="card stat" href="#/items?status=waiting"><span class="label"><span class="ico sm">pending_actions</span>投稿待ち</span><span class="value">${cnt.waiting}</span><span class="hint">採用済み・投稿案あり</span></a>
      <a class="card stat" href="#/items?status=posted"><span class="label"><span class="ico sm">check_circle</span>今月の投稿</span><span class="value">${cnt.posted}</span><span class="hint">X に投稿済み</span></a>
      <a class="card stat ${cnt.errors ? 'tint-error' : ''}" href="#/societies"><span class="label"><span class="ico sm">error</span>取得エラー</span><span class="value">${cnt.errors}</span><span class="hint">${cnt.errors ? '加盟学会ページで確認' : '問題なし'}</span></a>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div id="crawl-card"></div>
      <div class="card">
        <div class="section-title" style="margin-top:0"><span class="ico">info</span>状況</div>
        <dl class="kv">
          <dt>加盟学会</dt><dd>${S.societies.filter(s => s.active !== false).length} 学会（監視中）／ RSS あり ${S.societies.filter(s => s.feedUrl && !s.feedDisabled).length}</dd>
          <dt>最終巡回</dt><dd>${lastRun ? `${fmtDate(lastRun.finishedAt)}（${lastRun.trigger === 'auto' ? '自動' : '手動'}・新着 ${lastRun.newItems || 0} 件）` : 'まだ巡回していません'}</dd>
          <dt>AI</dt><dd>${S.aiAvailable ? `<span class="chip ok"><span class="ico">smart_toy</span>${esc(S.settings.model)}</span>` : `<span class="chip warn"><span class="ico">key_off</span>API キー未設定</span> <a href="#/settings">設定へ</a>`}</dd>
          <dt>自動巡回</dt><dd>${S.settings.autoCrawlEnabled ? `毎日 ${S.settings.autoCrawlHour ?? 6} 時` : 'オフ'}（<a href="#/settings">変更</a>）</dd>
        </dl>
        <p class="small muted" style="margin:12px 0 0">流れ：<b>巡回</b>で各学会サイトの更新を検知 → <b>更新情報</b>で採用／見送り → <b>投稿文を生成</b>して X に投稿 → 投稿済みを記録。</p>
      </div>
    </div>
    <div class="section-title"><span class="ico">campaign</span>新着の更新情報 <a class="btn sm" href="#/items?status=new">すべて見る</a></div>
    <div class="list">${recent.length ? recent.map(i => itemRow(i)).join('') : '<div class="card flat empty"><span class="ico">inbox</span>新着はありません。「巡回する」で加盟学会サイトを確認できます。</div>'}</div>`;
  renderCrawlCard();
  bindItemRows();
}

function renderCrawlCard() {
  const el = $('#crawl-card'); if (!el) return;
  const run = S.currentRun;
  const running = run && !run.finishedAt;
  const results = run ? [...run.results].slice(-12).reverse() : [];
  el.innerHTML = `<div class="card">
    <div class="section-title" style="margin-top:0"><span class="ico">travel_explore</span>巡回</div>
    <p class="small muted" style="margin:0 0 12px">全加盟学会のウェブサイト（と RSS）を取得し、前回からの追加分を AI が読んで告知を抽出します。初回は現在の内容を基準として記録するだけです。</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn filled" id="btn-crawl" ${running ? 'disabled' : ''}><span class="ico">${running ? 'hourglass_top' : 'play_arrow'}</span>${running ? '巡回中…' : '全学会を巡回する'}</button>
      ${!S.aiAvailable ? '<span class="chip warn"><span class="ico">key_off</span>AI 未設定：差分のみ記録</span>' : ''}
    </div>
    ${run ? `<div class="progress ${running && !run.done ? 'indeterminate' : ''}"><div style="width:${run.total ? Math.round(run.done / run.total * 100) : 0}%"></div></div>
      <div class="small muted">${running ? `${run.done} / ${run.total} 学会` : `完了 ${fmtDate(run.finishedAt)}：新着 ${run.newItems || 0} 件`}</div>
      <div class="runlog">${results.map(r => `<span class="dot ${r.status.split('+')[0].replace('-noitems', '')}"></span><span>${esc(r.name)}</span><span class="muted">${runStatusLabel(r)}</span>`).join('')}</div>` : ''}
  </div>`;
  const b = $('#btn-crawl'); if (b) b.onclick = () => startCrawl();
}
function runStatusLabel(r) {
  const base = r.status.split('+')[0];
  let t = RUN_STATUS[base] || base;
  if (r.newItems?.length) t += ` ${r.newItems.length} 件`;
  if (/error/.test(r.status) && base !== 'error') t += '（一部エラー）';
  return t;
}

// ======================================================================
// 更新情報
// ======================================================================
const filt = { status: 'new', society: '', q: '' };
const sel = new Set(); // 一括操作用の選択
function readQuery() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.has('status')) filt.status = q.get('status');
}
function renderItems() {
  readQuery();
  const counts = { all: S.items.length, waiting: S.items.filter(i => i.status === 'accepted' || i.status === 'drafted').length };
  for (const st of STATUS_ORDER) counts[st] = S.items.filter(i => i.status === st).length;
  const chips = [['new', '新着'], ['waiting', '投稿待ち'], ['posted', '投稿済み'], ['rejected', '見送り'], ['all', 'すべて']];
  $('#main').innerHTML = `
    <div class="topbar"><h1>更新情報</h1>
      <a class="btn outlined" href="/api/items.csv"><span class="ico">download</span>CSV 書き出し</a></div>
    <div class="toolbar">
      <div class="chips">${chips.map(([k, l]) => `<button class="chip filter ${filt.status === k ? 'on' : ''}" data-st="${k}">${l} <span class="cnt">${counts[k] ?? 0}</span></button>`).join('')}</div>
      <select id="f-soc"><option value="">すべての学会</option>${S.societies.map(s => `<option value="${s.id}" ${filt.society === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <div class="search"><span class="ico">search</span><input id="f-q" placeholder="件名・概要を検索" value="${esc(filt.q)}"></div>
    </div>
    <div class="bulkbar" id="bulkbar">
      <label class="switch sm"><input type="checkbox" id="sel-all"><span>表示中をすべて選択</span></label>
      <span class="small" id="sel-count"></span>
      <span class="spacer"></span>
      <button class="btn sm" data-bulk="status:posted"><span class="ico">check</span>投稿済みにする</button>
      <button class="btn sm" data-bulk="status:rejected"><span class="ico">thumb_down</span>見送り</button>
      <button class="btn sm" data-bulk="status:new"><span class="ico">undo</span>新着に戻す</button>
      <button class="btn sm danger" data-bulk="delete"><span class="ico">delete</span>削除</button>
    </div>
    <p class="small muted" style="margin:0 0 8px">各行左のチェックで複数選択し、まとめて削除・状態変更ができます。X で配信済みのものは「投稿済みにする」か「削除」で整理してください。</p>
    <div class="list" id="items-list"></div>
    <button class="fab" id="fab-add"><span class="ico">add</span>手動で追加</button>`;
  $$('.chip.filter').forEach(c => c.onclick = () => { filt.status = c.dataset.st; history.replaceState(null, '', `#/items?status=${filt.status}`); renderItems(); });
  $('#f-soc').onchange = (e) => { filt.society = e.target.value; renderItemList(); };
  $('#f-q').oninput = (e) => { filt.q = e.target.value; renderItemList(); };
  $('#fab-add').onclick = () => openAddDialog();
  $('#sel-all').onchange = (e) => { const ids = visibleIds(); if (e.target.checked) ids.forEach(i => sel.add(i)); else ids.forEach(i => sel.delete(i)); renderItemList(); };
  $$('[data-bulk]').forEach(b => b.onclick = () => bulkAction(b.dataset.bulk));
  renderItemList();
}
let lastVisible = [];
function visibleIds() { return lastVisible; }
function updateBulkbar() {
  const bar = $('#bulkbar'); if (!bar) return;
  const n = [...sel].filter(id => S.items.some(i => i.id === id)).length;
  bar.classList.toggle('active', n > 0);
  $$('[data-bulk]', bar).forEach(b => b.disabled = n === 0);
  $('#sel-count').textContent = n ? `${n} 件を選択中` : '未選択';
  const all = $('#sel-all'); all.checked = lastVisible.length > 0 && lastVisible.every(id => sel.has(id));
}
async function bulkAction(spec) {
  const ids = [...sel].filter(id => S.items.some(i => i.id === id));
  if (!ids.length) return;
  const [action, status] = spec.split(':');
  if (action === 'delete' && !confirm(`選択した ${ids.length} 件を削除します。元に戻せません。よろしいですか？`)) return;
  await guard(async () => {
    const r = await api('POST', '/api/items/bulk', { ids, action, status });
    sel.clear(); await loadState(); renderItems();
    snack(action === 'delete' ? `${r.count} 件を削除しました` : `${r.count} 件を「${STATUS_LABEL[status]}」にしました`);
  });
}
function renderItemList() {
  let list = S.items;
  if (filt.status === 'waiting') list = list.filter(i => i.status === 'accepted' || i.status === 'drafted');
  else if (filt.status !== 'all') list = list.filter(i => i.status === filt.status);
  if (filt.society) list = list.filter(i => i.societyId === filt.society);
  if (filt.q.trim()) { const q = filt.q.trim().toLowerCase(); list = list.filter(i => (i.title + ' ' + i.summary + ' ' + soc(i.societyId).name).toLowerCase().includes(q)); }
  lastVisible = list.map(i => i.id);
  $('#items-list').innerHTML = list.length ? list.map(i => itemRow(i, true)).join('') : '<div class="card flat empty"><span class="ico">inbox</span>該当する情報はありません</div>';
  bindItemRows();
  $$('.selbox').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => { cb.checked ? sel.add(cb.dataset.sel) : sel.delete(cb.dataset.sel); cb.closest('.row').classList.toggle('selected', cb.checked); updateBulkbar(); };
  });
  updateBulkbar();
}
function itemRow(i, selectable = false) {
  const s = soc(i.societyId);
  const src = { rss: 'rss_feed', page: 'difference', manual: 'edit_note' }[i.source] || 'article';
  return `<div class="row ${selectable ? 'selectable' : ''} ${sel.has(i.id) ? 'selected' : ''}" data-item="${i.id}">
    ${selectable ? `<label class="selcell"><input type="checkbox" class="selbox" data-sel="${i.id}" ${sel.has(i.id) ? 'checked' : ''}></label>` : ''}
    <div>
      <div class="meta"><b>${esc(s.name)}</b><span class="chip">${esc(i.category || 'その他')}</span><span class="ico sm" title="取得元: ${i.source}">${src}</span>${i.eventDate ? `<span><span class="ico sm">event</span>${esc(i.eventDate)}</span>` : ''}${i.editor ? `<span><span class="ico sm">person</span>${esc(i.editor)}</span>` : ''}</div>
      <div class="title">${esc(i.title)}</div>
      <div class="summary">${esc(i.summary)}</div>
    </div>
    <div class="right"><span class="chip st-${i.status}">${STATUS_LABEL[i.status]}</span><span>検知 ${fmtDay(i.foundAt)}</span>${i.status === 'posted' && i.postedUrl ? `<a href="${esc(i.postedUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><span class="ico sm">open_in_new</span>X の投稿</a>` : (i.draft ? `<span><span class="ico sm">chat</span>${xLength(i.draft)}/${S.settings.maxChars || 280}</span>` : '')}</div>
  </div>`;
}
function bindItemRows() { $$('[data-item]').forEach(r => r.onclick = (e) => { if (e.target.closest('.selcell')) return; openItem(r.dataset.item); }); }

// ---------- 詳細ダイアログ ----------
function openItem(id) {
  const it = S.items.find(x => x.id === id); if (!it) return;
  const s = soc(it.societyId);
  const limit = Number(S.settings.maxChars) || 280;
  const editors = S.settings.editors || [];
  const cats = S.settings.categories || [];
  const d = openDialog(`
    <div class="dlg-head"><span class="chip st-${it.status}" id="d-status">${STATUS_LABEL[it.status]}</span><h2>${esc(s.name)}</h2><button class="iconbtn" data-close title="閉じる"><span class="ico">close</span></button></div>
    <div class="dlg-body">
      <div class="field"><label>件名</label><input id="d-title" value="${esc(it.title)}"></div>
      <div class="field"><label>URL ${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">開く <span class="ico sm">open_in_new</span></a>` : ''}</label><input id="d-url" value="${esc(it.url || '')}" placeholder="https://"></div>
      <div class="fields-2">
        <div class="field"><label>日付情報（開催日・締切など）</label><input id="d-event" value="${esc(it.eventDate || '')}" placeholder="例: 2026年12月6日（土）"></div>
        <div class="field"><label>分類</label><select id="d-cat">${cats.map(c => `<option ${c === it.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>概要</label><textarea id="d-summary">${esc(it.summary)}</textarea></div>
      <div class="fields-2">
        <div class="field"><label>担当（編集委員）</label><input id="d-editor" list="editors" value="${esc(it.editor || '')}"><datalist id="editors">${editors.map(e => `<option value="${esc(e)}">`).join('')}</datalist></div>
        <div class="field"><label>メモ（投稿文に反映したい補足など）</label><input id="d-notes" value="${esc(it.notes || '')}"></div>
      </div>
      <div class="chips" style="margin:4px 0 8px">
        <span class="small muted">判断：</span>
        <button class="btn tonal sm" data-set-status="accepted"><span class="ico">thumb_up</span>採用</button>
        <button class="btn sm" data-set-status="rejected"><span class="ico">thumb_down</span>見送り</button>
        <button class="btn sm" data-set-status="new"><span class="ico">undo</span>新着に戻す</button>
      </div>

      <div class="dlg-section">
        <h3><span class="ico">chat</span>X 投稿文</h3>
        <div class="field" style="margin-bottom:6px"><textarea id="d-draft" placeholder="「AI で生成」を押すか、ここに直接入力してください">${esc(it.draft || '')}</textarea></div>
        <div class="counter" id="d-counter"></div>
        <div class="chips">
          <button class="btn filled sm" id="d-gen" ${S.aiAvailable ? '' : 'disabled title="API キー未設定"'}><span class="ico">auto_awesome</span>AI で生成</button>
          <button class="btn sm" id="d-copy"><span class="ico">content_copy</span>コピー</button>
          <button class="btn sm" id="d-x"><span class="ico">open_in_new</span>X の投稿画面を開く</button>
          <button class="btn tonal sm" id="d-posted"><span class="ico">check</span>投稿済みにする</button>
        </div>
        ${it.status === 'posted' ? `<div class="small muted" style="margin-top:8px">投稿日 ${fmtDate(it.postedAt)}${it.postedBy ? ` ／ ${esc(it.postedBy)}` : ''}</div>` : ''}
        <div class="fields-2" style="margin-top:10px">
          <div class="field" style="margin-bottom:0"><label>投稿 URL（記録用）</label><input id="d-posted-url" value="${esc(it.postedUrl || '')}" placeholder="https://x.com/..."></div>
          <div class="field" style="margin-bottom:0"><label>投稿者（管理委員）</label><input id="d-posted-by" value="${esc(it.postedBy || '')}"></div>
        </div>
      </div>

      <div class="dlg-section">
        <h3><span class="ico">newspaper</span>uals.net お知らせ用の文案 <span class="small muted" style="font-weight:400">（任意）</span></h3>
        <div class="field" style="margin-bottom:6px"><textarea id="d-news" placeholder="uals.net の「お知らせ」に転載する際の記事本文（タイトル＋箇条書き）">${esc(it.newsDraft || '')}</textarea></div>
        <div class="chips">
          <button class="btn sm" id="d-gen-news" ${S.aiAvailable ? '' : 'disabled'}><span class="ico">auto_awesome</span>AI で生成</button>
          <button class="btn sm" id="d-copy-news"><span class="ico">content_copy</span>コピー</button>
        </div>
      </div>

      <details class="raw"><summary>検知した元テキスト・情報（取得元: ${esc(it.source)}、検知 ${fmtDate(it.foundAt)}）</summary><pre>${esc(it.raw || '（なし）')}</pre></details>
    </div>
    <div class="dlg-foot">
      <button class="btn danger" id="d-delete"><span class="ico">delete</span>削除</button>
      <span class="spacer"></span>
      <button class="btn" data-close>閉じる</button>
      <button class="btn filled" id="d-save"><span class="ico">save</span>保存</button>
    </div>`);

  const collect = () => ({
    title: $('#d-title', d).value.trim(), url: $('#d-url', d).value.trim() || null, eventDate: $('#d-event', d).value.trim() || null,
    category: $('#d-cat', d).value, summary: $('#d-summary', d).value, editor: $('#d-editor', d).value.trim(), notes: $('#d-notes', d).value,
    draft: $('#d-draft', d).value, newsDraft: $('#d-news', d).value, postedUrl: $('#d-posted-url', d).value.trim(), postedBy: $('#d-posted-by', d).value.trim(),
  });
  const apply = (updated) => { const i = S.items.findIndex(x => x.id === id); if (i >= 0) S.items[i] = updated; updateBadge(); };
  const saveItem = async (extra = {}) => { const u = await api('PUT', `/api/items/${id}`, { ...collect(), ...extra }); apply(u); return u; };
  const updateCounter = () => { const n = xLength($('#d-draft', d).value); const c = $('#d-counter', d); c.textContent = `${n} / ${limit}`; c.classList.toggle('over', n > limit); };
  $('#d-draft', d).oninput = updateCounter; updateCounter();

  $$('[data-set-status]', d).forEach(b => b.onclick = () => guard(async () => { await saveItem({ status: b.dataset.setStatus }); closeDialog(); route(); }, `「${STATUS_LABEL[b.dataset.setStatus]}」にしました`));
  $('#d-save', d).onclick = () => guard(async () => { await saveItem(); closeDialog(); route(); }, '保存しました');
  $('#d-delete', d).onclick = () => {
    if (!confirm('この更新情報を削除しますか？')) return;
    guard(async () => { await api('DELETE', `/api/items/${id}`); S.items = S.items.filter(x => x.id !== id); updateBadge(); closeDialog(); route(); }, '削除しました');
  };
  $('#d-gen', d).onclick = () => guard(async () => {
    const b = $('#d-gen', d); b.disabled = true; b.innerHTML = '<span class="spinner"></span>生成中…';
    try {
      await saveItem();
      const r = await api('POST', `/api/items/${id}/draft`);
      apply(r.item); $('#d-draft', d).value = r.item.draft; updateCounter();
      $('#d-status', d).className = `chip st-${r.item.status}`; $('#d-status', d).textContent = STATUS_LABEL[r.item.status];
    } finally { b.disabled = false; b.innerHTML = '<span class="ico">auto_awesome</span>AI で生成'; }
  }, '投稿文を生成しました。内容を確認・修正してください');
  $('#d-gen-news', d).onclick = () => guard(async () => {
    const b = $('#d-gen-news', d); b.disabled = true; b.innerHTML = '<span class="spinner"></span>生成中…';
    try { await saveItem(); const r = await api('POST', `/api/items/${id}/news-draft`); apply(r.item); $('#d-news', d).value = r.item.newsDraft; }
    finally { b.disabled = false; b.innerHTML = '<span class="ico">auto_awesome</span>AI で生成'; }
  }, 'お知らせ文案を生成しました');
  $('#d-copy', d).onclick = () => copyText($('#d-draft', d).value);
  $('#d-copy-news', d).onclick = () => copyText($('#d-news', d).value);
  $('#d-x', d).onclick = () => guard(async () => {
    const text = $('#d-draft', d).value.trim();
    if (!text) throw new Error('投稿文が空です');
    await saveItem();
    window.open('https://x.com/intent/post?text=' + encodeURIComponent(text), '_blank', 'noopener,width=600,height=700');
  });
  $('#d-posted', d).onclick = () => guard(async () => { await saveItem({ status: 'posted' }); closeDialog(); route(); }, '投稿済みとして記録しました');
}
async function copyText(t) {
  if (!t) return snack('コピーする内容がありません', true);
  try { await navigator.clipboard.writeText(t); snack('クリップボードにコピーしました'); }
  catch { snack('コピーできませんでした（ブラウザの制限）', true); }
}

// ---------- 手動追加 ----------
function openAddDialog(presetSocietyId = '') {
  const d = openDialog(`
    <div class="dlg-head"><h2>更新情報を手動で追加</h2><button class="iconbtn" data-close><span class="ico">close</span></button></div>
    <div class="dlg-body">
      <div class="field"><label>学会</label><select id="a-soc"><option value="">選択してください</option>${S.societies.map(s => `<option value="${s.id}" ${s.id === presetSocietyId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>告知ページの URL</label><input id="a-url" placeholder="https://..."><span class="help">URL だけ入力して追加すると、${S.aiAvailable ? 'ページを読み取って AI が件名・概要を自動で作成します' : 'ページの本文を取り込みます（AI 未設定のため要約はされません）'}。</span></div>
      <div class="field"><label>件名（URL を使わず手入力する場合）</label><input id="a-title"></div>
      <div class="fields-2">
        <div class="field"><label>日付情報</label><input id="a-event"></div>
        <div class="field"><label>分類</label><select id="a-cat">${(S.settings.categories || []).map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>概要</label><textarea id="a-summary"></textarea></div>
    </div>
    <div class="dlg-foot"><button class="btn" data-close>キャンセル</button><button class="btn filled" id="a-ok"><span class="ico">add</span>追加</button></div>`);
  $('#a-ok', d).onclick = () => guard(async () => {
    const body = { societyId: $('#a-soc', d).value, url: $('#a-url', d).value.trim(), title: $('#a-title', d).value.trim(), eventDate: $('#a-event', d).value.trim(), category: $('#a-cat', d).value, summary: $('#a-summary', d).value };
    if (!body.societyId) throw new Error('学会を選択してください');
    if (!body.url && !body.title) throw new Error('URL か件名を入力してください');
    const b = $('#a-ok', d); b.disabled = true; b.innerHTML = '<span class="spinner"></span>処理中…';
    try {
      const r = await api('POST', '/api/items', body);
      await loadState(); closeDialog(); location.hash = '#/items?status=new'; route();
      snack(r.message || '追加しました');
    } finally { b.disabled = false; b.innerHTML = '<span class="ico">add</span>追加'; }
  });
}

// ======================================================================
// 加盟学会
// ======================================================================
function renderSocieties() {
  const running = S.currentRun && !S.currentRun.finishedAt;
  $('#main').innerHTML = `
    <div class="topbar"><h1>加盟学会</h1><span class="sub">${S.societies.length} 学会</span>
      <button class="btn outlined" id="s-crawl-all" ${running ? 'disabled' : ''}><span class="ico">travel_explore</span>全学会を巡回</button>
      <button class="btn filled" id="s-add"><span class="ico">add</span>学会を追加</button></div>
    <p class="small muted">各学会の「監視 URL」は原則トップページです。お知らせ一覧ページが別にある場合は編集で追加すると検知精度が上がります。RSS は自動検出されます。</p>
    <div class="list">${S.societies.map(societyRow).join('')}</div>`;
  $('#s-add').onclick = () => openSocietyDialog(null);
  $('#s-crawl-all').onclick = () => startCrawl();
  $$('[data-s-edit]').forEach(b => b.onclick = () => openSocietyDialog(b.dataset.sEdit));
  $$('[data-s-crawl]').forEach(b => b.onclick = () => startCrawl([b.dataset.sCrawl]));
  $$('[data-s-more]').forEach(b => b.onclick = () => openSocietyMenu(b.dataset.sMore));
}
function societyRow(s) {
  const st = s.lastStatus || '';
  const base = st.split('+')[0];
  const chip = !s.lastChecked ? '<span class="chip muted">未巡回</span>' :
    /^error/.test(st) ? '<span class="chip warn"><span class="ico">error</span>エラー</span>' :
    base === 'changed' ? `<span class="chip st-new"><span class="ico">new_releases</span>新着 ${s.lastNewItems || 0}</span>` :
    base === 'baseline' ? '<span class="chip st-drafted">初回取得</span>' : '<span class="chip ok"><span class="ico">check</span>変化なし</span>';
  const newCount = S.items.filter(i => i.societyId === s.id && i.status === 'new').length;
  return `<div class="row soc-row ${s.active === false ? 'muted' : ''}">
    <div>
      <div class="meta">${s.short ? `<span class="chip">${esc(s.short)}</span>` : ''}<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(host(s.url))} <span class="ico sm">open_in_new</span></a>
        ${s.feedUrl && !s.feedDisabled ? '<span title="RSS あり"><span class="ico sm">rss_feed</span>RSS</span>' : ''}${(s.checkUrls || []).length ? `<span>+${s.checkUrls.length} ページ</span>` : ''}${s.editor ? `<span><span class="ico sm">person</span>${esc(s.editor)}</span>` : ''}${s.active === false ? '<span class="chip">監視停止</span>' : ''}</div>
      <div class="title">${esc(s.name)} ${newCount ? `<a class="small" href="#/items?status=new" onclick="filt.society='${s.id}'">新着 ${newCount} 件</a>` : ''}</div>
      <div class="small muted">${s.lastChecked ? `最終巡回 ${fmtDate(s.lastChecked)}` : ''} ${/error/.test(st) ? `<div class="err">${esc(s.lastError)}</div>` : ''}</div>
    </div>
    <div class="right"><div>${chip}</div>
      <div class="actions"><button class="iconbtn" title="この学会だけ巡回" data-s-crawl="${s.id}"><span class="ico">refresh</span></button><button class="iconbtn" title="編集" data-s-edit="${s.id}"><span class="ico">edit</span></button><button class="iconbtn" title="その他" data-s-more="${s.id}"><span class="ico">more_vert</span></button></div>
    </div></div>`;
}
function openSocietyDialog(id) {
  const s = id ? S.societies.find(x => x.id === id) : { name: '', short: '', url: '', checkUrls: [], feedUrl: '', xAccount: '', editor: '', note: '', active: true };
  const editors = S.settings.editors || [];
  const d = openDialog(`
    <div class="dlg-head"><h2>${id ? '学会情報の編集' : '学会を追加'}</h2><button class="iconbtn" data-close><span class="ico">close</span></button></div>
    <div class="dlg-body">
      <div class="fields-2"><div class="field"><label>学会名</label><input id="e-name" value="${esc(s.name)}"></div><div class="field"><label>略称</label><input id="e-short" value="${esc(s.short || '')}"></div></div>
      <div class="field"><label>ウェブサイト URL（監視対象）</label><input id="e-url" value="${esc(s.url)}"></div>
      <div class="field"><label>追加で監視するページ URL（1 行に 1 つ）</label><textarea id="e-check" rows="3">${esc((s.checkUrls || []).join('\n'))}</textarea><span class="help">例: お知らせ一覧、大会案内ページ。トップページに告知が出ない学会で有効。</span></div>
      <div class="field"><label>RSS / Atom フィード URL ${s.feedAuto ? '<span class="small muted">（自動検出）</span>' : ''}</label><input id="e-feed" value="${esc(s.feedUrl || '')}"></div>
      <div class="fields-2"><div class="field"><label>X アカウント</label><input id="e-x" value="${esc(s.xAccount || '')}" placeholder="@..."></div>
        <div class="field"><label>担当編集委員</label><input id="e-editor" list="editors2" value="${esc(s.editor || '')}"><datalist id="editors2">${editors.map(e => `<option value="${esc(e)}">`).join('')}</datalist></div></div>
      <div class="field"><label>メモ</label><input id="e-note" value="${esc(s.note || '')}"></div>
      <label class="switch"><input type="checkbox" id="e-active" ${s.active !== false ? 'checked' : ''}><span>巡回対象にする</span></label>
      <label class="switch" style="margin-left:24px"><input type="checkbox" id="e-feedoff" ${s.feedDisabled ? 'checked' : ''}><span>RSS を使わない</span></label>
    </div>
    <div class="dlg-foot">${id ? '<button class="btn danger" id="e-del"><span class="ico">delete</span>削除</button>' : ''}<span class="spacer"></span><button class="btn" data-close>キャンセル</button><button class="btn filled" id="e-save"><span class="ico">save</span>保存</button></div>`);
  $('#e-save', d).onclick = () => guard(async () => {
    const body = { name: $('#e-name', d).value.trim(), short: $('#e-short', d).value.trim(), url: $('#e-url', d).value.trim(), checkUrls: $('#e-check', d).value.split('\n').map(x => x.trim()).filter(Boolean),
      feedUrl: $('#e-feed', d).value.trim(), xAccount: $('#e-x', d).value.trim(), editor: $('#e-editor', d).value.trim(), note: $('#e-note', d).value, active: $('#e-active', d).checked, feedDisabled: $('#e-feedoff', d).checked };
    if (!body.name || !body.url) throw new Error('学会名と URL は必須です');
    if (id) await api('PUT', `/api/societies/${id}`, body); else await api('POST', '/api/societies', body);
    await loadState(); closeDialog(); renderSocieties();
  }, '保存しました');
  if (id) $('#e-del', d).onclick = () => {
    if (!confirm(`「${s.name}」を削除しますか？（この学会の更新情報は残ります）`)) return;
    guard(async () => { await api('DELETE', `/api/societies/${id}`); await loadState(); closeDialog(); renderSocieties(); }, '削除しました');
  };
}
function openSocietyMenu(id) {
  const s = S.societies.find(x => x.id === id);
  const d = openDialog(`
    <div class="dlg-head"><h2>${esc(s.name)}</h2><button class="iconbtn" data-close><span class="ico">close</span></button></div>
    <div class="dlg-body">
      <div class="list">
        <div class="row compact" id="m-extract"><div><div class="title"><span class="ico sm">auto_awesome</span> 現在掲載中の告知を AI で抽出</div><div class="small muted">サイトに今載っている告知を読み取り、更新情報として取り込みます（初期セットアップや巡回の取りこぼし確認に）。${S.aiAvailable ? '' : '<b>API キー未設定のため使えません。</b>'}</div></div></div>
        <div class="row compact" id="m-add"><div><div class="title"><span class="ico sm">add_link</span> URL を指定して追加</div><div class="small muted">この学会の告知ページ URL から 1 件追加します。</div></div></div>
        <div class="row compact" id="m-reset"><div><div class="title"><span class="ico sm">restart_alt</span> 基準（前回取得内容）をリセット</div><div class="small muted">次回巡回を初回扱いにします。サイト構造が大きく変わったときなどに。</div></div></div>
      </div>
    </div>
    <div class="dlg-foot"><button class="btn" data-close>閉じる</button></div>`);
  $('#m-extract', d).onclick = () => guard(async () => {
    if (!S.aiAvailable) throw new Error('OpenAI API キーを設定してください');
    $('#m-extract .title', d).innerHTML = '<span class="spinner"></span>抽出中（30 秒ほどかかります）…';
    const r = await api('POST', `/api/societies/${id}/extract`);
    await loadState(); closeDialog(); location.hash = '#/items?status=new'; route();
    snack(`${r.extracted} 件を抽出し、${r.created.length} 件を新規追加しました`);
  });
  $('#m-add', d).onclick = () => openAddDialog(id);
  $('#m-reset', d).onclick = () => guard(async () => { await api('POST', `/api/societies/${id}/reset`); await loadState(); closeDialog(); renderSocieties(); }, 'リセットしました');
}

// ======================================================================
// 巡回履歴
// ======================================================================
function renderRuns() {
  $('#main').innerHTML = `<div class="topbar"><h1>巡回履歴</h1></div>
    <div class="runs">${S.runs.length ? S.runs.map((r, idx) => `<details class="card run" ${idx === 0 ? 'open' : ''}>
      <summary><span class="ico">${r.finishedAt ? 'task_alt' : 'hourglass_top'}</span><b>${fmtDate(r.startedAt)}</b><span class="chip">${r.trigger === 'auto' ? '自動' : '手動'}</span><span class="muted">${r.done}/${r.total} 学会</span><span class="chip st-new">新着 ${r.newItems ?? r.results.reduce((a, x) => a + x.newItems.length, 0)} 件</span>${r.results.some(x => /error/.test(x.status)) ? `<span class="chip warn">エラー ${r.results.filter(x => /error/.test(x.status)).length}</span>` : ''}${r.aiAvailable === false ? '<span class="chip muted">AI なし</span>' : ''}</summary>
      <div class="res">${r.results.map(x => `<span class="dot ${x.status.split('+')[0].replace('-noitems', '')}"></span><span>${esc(x.name)}${x.errors?.length ? `<div class="err">${esc(x.errors.join(' / '))}</div>` : ''}</span><span class="muted">${runStatusLabel(x)}</span>`).join('')}</div>
    </details>`).join('') : '<div class="card flat empty"><span class="ico">history</span>まだ巡回していません</div>'}</div>`;
}

// ======================================================================
// 設定
// ======================================================================
function renderSettings() {
  const st = S.settings;
  $('#main').innerHTML = `<div class="topbar"><h1>設定</h1></div>
    <div class="grid two">
      <div class="card">
        <div class="section-title" style="margin-top:0"><span class="ico">key</span>OpenAI API</div>
        <div class="field"><label>API キー ${st.apiKeyMasked ? `<span class="chip ok">設定済み ${esc(st.apiKeyMasked)}${st.apiKeySource === 'env' ? '（.env）' : ''}</span>` : '<span class="chip warn">未設定</span>'}</label>
          <input id="st-key" type="password" placeholder="${st.apiKeyMasked ? '変更する場合のみ入力' : 'sk-...'}" autocomplete="off"><span class="help">このサーバーの data/db.json に保存されます（他の人には見えないよう、公開サーバーではパスワード保護を）。</span></div>
        <div class="field"><label>モデル</label><input id="st-model" value="${esc(st.openaiModel || '')}" placeholder="${esc(st.model)}"><span class="help">空欄なら ${esc(st.model)}。コスト重視なら gpt-5-mini / gpt-4.1-mini、精度重視なら gpt-5 など。</span></div>
        <div class="chips"><button class="btn filled" id="st-save-ai"><span class="ico">save</span>保存</button><button class="btn outlined" id="st-test"><span class="ico">network_check</span>接続テスト</button>${st.apiKeySource === 'settings' ? '<button class="btn danger" id="st-clear">キーを削除</button>' : ''}</div>
        <div id="st-test-result" class="small" style="margin-top:8px"></div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0"><span class="ico">schedule</span>自動巡回・運用</div>
        <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="st-auto" ${st.autoCrawlEnabled ? 'checked' : ''}><span>毎日自動で巡回する</span></label>
        <div class="field"><label>巡回時刻（0〜23 時）</label><input id="st-hour" type="number" min="0" max="23" value="${st.autoCrawlHour ?? 6}"><span class="help">アプリ（サーバー）が起動している必要があります。</span></div>
        <div class="field"><label>編集委員・管理委員の名前（カンマ区切り）</label><input id="st-editors" value="${esc((st.editors || []).join(', '))}"><span class="help">担当者欄の候補として表示されます。</span></div>
        <div class="chips"><button class="btn filled" id="st-save-ops"><span class="ico">save</span>保存</button><a class="btn outlined" href="/api/items.csv"><span class="ico">download</span>更新情報を CSV で書き出す</a></div>
        <p class="small muted" style="margin:12px 0 0">データ保存先: <code>${esc(st.dataDir)}</code></p>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-top:0"><span class="ico">edit_note</span>X 投稿文のスタイル</div>
      <div class="field"><label>文体・構成の指示（AI に渡されます）</label><textarea id="st-style" rows="7" placeholder="${esc(st.defaultPostStyle)}">${esc(st.postStyle || '')}</textarea><span class="help">空欄なら上の既定の指示を使います。</span></div>
      <div class="fields-2">
        <div class="field"><label>ハッシュタグ</label><input id="st-tags" value="${esc(st.hashtags ?? '')}" placeholder="空欄なら付けない（@uals_pr の既存投稿はハッシュタグなし）"></div>
        <div class="field"><label>文字数上限（X の重み付きカウント）</label><input id="st-max" type="number" value="${st.maxChars || 280}"><span class="help">無料アカウントは 280（日本語約 140 字）。</span></div>
      </div>
      <button class="btn filled" id="st-save-style"><span class="ico">save</span>保存</button>
    </div>`;
  const after = async (msg) => { await loadState(); renderSettings(); snack(msg); };
  $('#st-save-ai').onclick = () => guard(async () => {
    const body = { openaiModel: $('#st-model').value.trim() };
    const k = $('#st-key').value.trim(); if (k) body.openaiApiKey = k;
    await api('PUT', '/api/settings', body); await after('保存しました');
  });
  const clr = $('#st-clear'); if (clr) clr.onclick = () => guard(async () => { await api('PUT', '/api/settings', { openaiApiKey: '' }); await after('API キーを削除しました'); });
  $('#st-test').onclick = () => guard(async () => {
    const el = $('#st-test-result'); el.innerHTML = '<span class="spinner"></span>接続中…';
    try { const r = await api('POST', '/api/settings/test-ai'); el.innerHTML = `<span class="chip ok"><span class="ico">check</span>接続成功（${esc(r.model)}）：${esc(r.reply)}</span>`; }
    catch (e) { el.innerHTML = `<span class="err">${esc(e.message)}</span>`; throw e; }
  });
  $('#st-save-ops').onclick = () => guard(async () => {
    await api('PUT', '/api/settings', { autoCrawlEnabled: $('#st-auto').checked, autoCrawlHour: Number($('#st-hour').value), editors: $('#st-editors').value.split(/[,、，]/).map(x => x.trim()).filter(Boolean) });
    await after('保存しました');
  });
  $('#st-save-style').onclick = () => guard(async () => {
    await api('PUT', '/api/settings', { postStyle: $('#st-style').value, hashtags: $('#st-tags').value.trim(), maxChars: Number($('#st-max').value) || 280 });
    await after('保存しました');
  });
}

// ---------- 起動 ----------
(async () => {
  try { await loadState(); route(); }
  catch (e) { $('#main').innerHTML = `<div class="card empty"><span class="ico">cloud_off</span>サーバーに接続できません：${esc(e.message)}</div>`; }
})();
