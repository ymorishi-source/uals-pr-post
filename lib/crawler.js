// 巡回処理: ページ差分検知 + RSS + AI 抽出 → 更新情報（items）の作成
const { db, save, newId, getSnapshot, setSnapshot } = require('./db');
const fetcher = require('./fetcher');
const ai = require('./ai');
const { normalizeUrl, normalizeTitle, todayISO } = require('./text');

const CONCURRENCY = 4;
const FEED_IMPORT_DAYS = 30;   // RSS 初回取得時、この日数以内の記事を取り込む
const MIN_ADDED_CHARS = 20;    // 差分がこれ未満なら「変化なし」扱い

function normLine(l) { return l.replace(/\s+/g, ' ').trim(); }
function diffAdded(oldText, newText) {
  const oldSet = new Set((oldText || '').split('\n').map(normLine));
  const added = [];
  for (const l of (newText || '').split('\n')) {
    const n = normLine(l);
    if (n.length >= 2 && !oldSet.has(n)) added.push(n);
  }
  // 同じ行の重複を除く
  return [...new Set(added)];
}

function societyUrls(s) {
  const urls = [s.url, ...(s.checkUrls || [])].map(u => (u || '').trim()).filter(Boolean);
  return [...new Set(urls)];
}

function findDuplicate(societyId, { url, title }) {
  const nu = normalizeUrl(url), nt = normalizeTitle(title);
  const cutoff = Date.now() - 180 * 86400000; // 半年より古い同名件は別件（年次大会など）とみなす
  return db.items.find(it => it.societyId === societyId && new Date(it.foundAt).getTime() > cutoff &&
    ((nu && normalizeUrl(it.url) === nu && !isTopPage(nu, societyId)) || (nt && nt.length > 6 && normalizeTitle(it.title) === nt)));
}
function isTopPage(nu, societyId) {
  const s = db.societies.find(x => x.id === societyId);
  return s && normalizeUrl(s.url) === nu;
}

function addItem(data) {
  if (!data.title) return null;
  if (findDuplicate(data.societyId, data)) return null;
  const now = new Date().toISOString();
  const item = {
    id: newId(), societyId: data.societyId, title: data.title.trim().slice(0, 200), url: data.url || null,
    date: data.date || null, eventDate: data.eventDate || null, category: data.category || 'その他',
    summary: data.summary || '', importance: data.importance || 2, status: 'new', source: data.source || 'page',
    foundAt: now, updatedAt: now, runId: data.runId || null, editor: data.editor || '', notes: '',
    draft: '', draftAt: null, newsDraft: '', postedAt: null, postedUrl: '', postedBy: '', raw: (data.raw || '').slice(0, 6000),
  };
  db.items.unshift(item);
  save();
  return item;
}

// 1 学会を巡回。結果 { status: baseline|nochange|changed|error, newItems:[], ... }
async function crawlSociety(society, { runId = null, useAI = ai.available() } = {}) {
  const result = { societyId: society.id, name: society.name, status: 'nochange', newItems: [], pages: [], errors: [], aiUsed: false };
  const snap = getSnapshot(society.id) || { pages: {}, feedSeen: null, createdAt: new Date().toISOString() };
  const added = []; // [{url, text}]
  let anyBaseline = false, anyOk = false;

  for (const url of societyUrls(society)) {
    try {
      const page = await fetcher.getPage(url);
      anyOk = true;
      if (page.feedUrl && !society.feedUrl && !society.feedDisabled) { society.feedUrl = page.feedUrl; society.feedAuto = true; }
      const prev = snap.pages[url];
      if (!prev) {
        anyBaseline = true;
        result.pages.push({ url, status: 'baseline', lines: page.text.split('\n').length });
      } else {
        const lines = diffAdded(prev.text, page.text);
        const text = lines.join('\n');
        result.pages.push({ url, status: text.length >= MIN_ADDED_CHARS ? 'changed' : 'nochange', addedLines: lines.length });
        if (text.length >= MIN_ADDED_CHARS) added.push({ url: page.finalUrl || url, text });
      }
      snap.pages[url] = { text: page.text, fetchedAt: new Date().toISOString(), title: page.title };
    } catch (e) {
      result.errors.push(`${url}: ${e.message}`);
      result.pages.push({ url, status: 'error', error: e.message });
    }
  }

  // RSS / Atom
  if (society.feedUrl && !society.feedDisabled) {
    try {
      const entries = await fetcher.getFeed(society.feedUrl);
      anyOk = true;
      const seen = new Set(snap.feedSeen || []);
      const first = snap.feedSeen == null;
      const cutoff = Date.now() - FEED_IMPORT_DAYS * 86400000;
      let n = 0;
      for (const en of entries) {
        const key = normalizeUrl(en.link) || normalizeTitle(en.title);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (first && !(en.date && new Date(en.date).getTime() > cutoff)) continue;
        const item = addItem({ societyId: society.id, title: en.title || '（無題）', url: en.link, date: en.date, summary: stripLinks(en.description).slice(0, 400),
          category: guessCategory(en.title + ' ' + en.description), source: 'rss', runId, raw: en.description, editor: society.editor || '' });
        if (item) { result.newItems.push(item.id); n++; }
      }
      snap.feedSeen = [...seen].slice(-500);
      result.pages.push({ url: society.feedUrl, status: first ? 'baseline' : (n ? 'changed' : 'nochange'), feedItems: entries.length, newItems: n });
    } catch (e) {
      result.errors.push(`RSS ${society.feedUrl}: ${e.message}`);
      result.pages.push({ url: society.feedUrl, status: 'error', error: e.message });
    }
  }

  // 差分を AI で構造化
  if (added.length) {
    const rawAll = added.map(a => `[${a.url}]\n${a.text}`).join('\n\n');
    if (useAI) {
      try {
        const extracted = await ai.extractItems({ society, pages: added });
        result.aiUsed = true;
        for (const x of extracted) {
          const item = addItem({ ...x, societyId: society.id, source: 'page', runId, raw: rawAll, editor: society.editor || '' });
          if (item) result.newItems.push(item.id);
        }
        if (!extracted.length) result.pages.push({ url: '(AI)', status: 'nochange', note: '追加テキストはあるが広報対象なしと判定' });
      } catch (e) {
        result.errors.push(`AI 抽出: ${e.message}`);
        const item = addItem(rawChangeItem(society, rawAll, runId, `AI 抽出に失敗したため差分をそのまま記録: ${e.message}`));
        if (item) result.newItems.push(item.id);
      }
    } else {
      const item = addItem(rawChangeItem(society, rawAll, runId, 'API キー未設定のため差分をそのまま記録'));
      if (item) result.newItems.push(item.id);
    }
  }

  setSnapshot(society.id, snap);
  if (!anyOk) result.status = 'error';
  else if (result.newItems.length) result.status = 'changed';
  else if (anyBaseline) result.status = 'baseline';
  else if (added.length) result.status = 'changed-noitems';
  else result.status = 'nochange';
  if (result.errors.length && anyOk) result.status += '+error';

  society.lastChecked = new Date().toISOString();
  society.lastStatus = result.status;
  society.lastError = result.errors.join(' / ') || '';
  society.lastNewItems = result.newItems.length;
  save();
  return result;
}

function rawChangeItem(society, rawAll, runId, note) {
  const firstLine = rawAll.split('\n').find(l => l && !l.startsWith('[')) || '';
  return { societyId: society.id, title: `ページ更新を検知: ${firstLine.slice(0, 60)}`, url: society.url, date: todayISO(),
    summary: `${note}\n\n${rawAll.slice(0, 1500)}`, category: 'その他', source: 'page', runId, raw: rawAll, importance: 1, editor: society.editor || '' };
}

function stripLinks(t) { return (t || '').replace(/\s*\[https?:\/\/[^\]]+\]/g, '').replace(/[ \t]+\n/g, '\n'); }

function guessCategory(t) {
  t = t || '';
  if (/募集|CFP|call for/i.test(t) && /発表|研究|口頭|ポスター/.test(t)) return '発表募集';
  if (/投稿|原稿募集/.test(t)) return '論文投稿募集';
  if (/大会|年次|全国|conference/i.test(t)) return '大会';
  if (/研究会|講演|シンポジウム|ワークショップ|セミナー|例会|勉強会|コロキウム|分科会|研究発表会|フォーラム/.test(t)) return '研究会・講演会';
  if (/刊行|発行|学会誌|紀要|ジャーナル|journal|号/i.test(t)) return '刊行';
  if (/公募|助成|賞|奨励/.test(t)) return '公募・助成';
  if (/総会|選挙|会費|役員/.test(t)) return '会務';
  return 'その他';
}

// ---- 巡回ラン（複数学会・並列実行） ----
let currentRun = null;

function getCurrentRun() { return currentRun; }

async function startRun(societyIds, { trigger = 'manual' } = {}) {
  if (currentRun && !currentRun.finishedAt) throw new Error('巡回がすでに実行中です');
  const targets = db.societies.filter(s => s.active !== false && (!societyIds || societyIds.includes(s.id)));
  const run = { id: newId(), startedAt: new Date().toISOString(), finishedAt: null, trigger, total: targets.length, done: 0, results: [], aiAvailable: ai.available() };
  currentRun = run;
  db.runs.unshift(run);
  if (db.runs.length > 60) db.runs.length = 60;
  save();

  (async () => {
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const s = queue.shift();
        let r;
        try { r = await crawlSociety(s, { runId: run.id }); }
        catch (e) { r = { societyId: s.id, name: s.name, status: 'error', newItems: [], errors: [e.message], pages: [] }; }
        run.results.push(r); run.done++; save();
      }
    });
    await Promise.all(workers);
    run.finishedAt = new Date().toISOString();
    run.newItems = run.results.reduce((a, r) => a + r.newItems.length, 0);
    save();
  })();
  return run;
}

// 現在掲載されている情報を丸ごと AI で抽出（初回セットアップや手動取り込みに使う）
async function extractCurrent(society) {
  if (!ai.available()) throw new Error('OpenAI API キーが設定されていません');
  const pages = [];
  for (const url of societyUrls(society)) {
    const page = await fetcher.getPage(url);
    pages.push({ url: page.finalUrl || url, text: page.text.slice(0, 30000) });
  }
  const extracted = await ai.extractItems({ society, pages });
  const created = [];
  for (const x of extracted) {
    const item = addItem({ ...x, societyId: society.id, source: 'manual', raw: pages.map(p => p.text).join('\n').slice(0, 6000), editor: society.editor || '' });
    if (item) created.push(item);
  }
  return { extracted: extracted.length, created };
}

// URL を指定して 1 ページから抽出（手動追加）
async function extractFromUrl(society, url) {
  const page = await fetcher.getPage(url);
  if (!ai.available()) {
    const item = addItem({ societyId: society.id, title: page.title || url, url, date: todayISO(), summary: page.text.slice(0, 800), source: 'manual', raw: page.text });
    return { created: item ? [item] : [], extracted: 0 };
  }
  const extracted = await ai.extractItems({ society, pages: [{ url: page.finalUrl || url, text: page.text.slice(0, 40000) }] });
  const created = [];
  for (const x of extracted) {
    const item = addItem({ ...x, url: x.url || url, societyId: society.id, source: 'manual', raw: page.text.slice(0, 6000), editor: society.editor || '' });
    if (item) created.push(item);
  }
  return { extracted: extracted.length, created };
}

module.exports = { crawlSociety, startRun, getCurrentRun, extractCurrent, extractFromUrl, addItem, diffAdded, guessCategory };
