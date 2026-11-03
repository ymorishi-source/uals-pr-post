// 言語系学会連合 広報支援アプリ サーバー
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch { /* .env なし */ }

const express = require('express');
const path = require('path');
const { db, save, newId, deleteSnapshot, DATA_DIR } = require('./lib/db');
const crawler = require('./lib/crawler');
const ai = require('./lib/ai');
const { xLength } = require('./lib/text');
const seed = require('./lib/seed');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(express.json({ limit: '2mb' }));

// 共通パスワード（公開サーバー用、任意）
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [, b64] = h.split(' ');
    const pw = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pw === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="UALS PR"').status(401).send('認証が必要です');
  });
}
app.use(express.static(path.join(__dirname, 'public')));

// 初回起動時に加盟学会を投入
if (db.societies.length === 0) {
  for (const s of seed) db.societies.push({ id: newId(), active: true, checkUrls: [], xAccount: '', editor: '', note: '', ...s });
  save();
  console.log(`加盟学会 ${seed.length} 件を初期登録しました`);
}
// 既定設定
db.settings.editors ||= [];
save();

const STATUSES = ['new', 'accepted', 'drafted', 'posted', 'rejected'];

function publicSettings() {
  const s = { ...db.settings };
  const key = db.settings.openaiApiKey || process.env.OPENAI_API_KEY || '';
  delete s.openaiApiKey;
  s.apiKeyMasked = key ? key.slice(0, 7) + '…' + key.slice(-4) : '';
  s.apiKeySource = db.settings.openaiApiKey ? 'settings' : (process.env.OPENAI_API_KEY ? 'env' : '');
  s.model = ai.model();
  s.defaultPostStyle = ai.styleGuide();
  s.categories = ai.CATEGORIES;
  s.dataDir = DATA_DIR;
  return s;
}

// ---- 状態一括取得 ----
app.get('/api/state', (req, res) => {
  res.json({
    societies: db.societies, items: db.items, runs: db.runs.slice(0, 30),
    currentRun: crawler.getCurrentRun(), settings: publicSettings(), aiAvailable: ai.available(), now: new Date().toISOString(),
  });
});

// ---- 加盟学会 ----
app.post('/api/societies', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.url) return res.status(400).json({ error: '学会名と URL は必須です' });
  const s = { id: newId(), name: b.name, short: b.short || '', url: b.url, checkUrls: b.checkUrls || [], feedUrl: b.feedUrl || '', xAccount: b.xAccount || '', editor: b.editor || '', note: b.note || '', active: b.active !== false };
  db.societies.push(s); save(); res.json(s);
});
app.put('/api/societies/:id', (req, res) => {
  const s = db.societies.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  for (const k of ['name', 'short', 'url', 'feedUrl', 'xAccount', 'editor', 'note', 'active', 'feedDisabled']) if (k in b) s[k] = b[k];
  if ('checkUrls' in b) s.checkUrls = (b.checkUrls || []).map(u => u.trim()).filter(Boolean);
  if ('feedUrl' in b) s.feedAuto = false;
  save(); res.json(s);
});
app.delete('/api/societies/:id', (req, res) => {
  const i = db.societies.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  db.societies.splice(i, 1); deleteSnapshot(req.params.id); save(); res.json({ ok: true });
});
app.post('/api/societies/:id/reset', (req, res) => {
  const s = db.societies.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  deleteSnapshot(s.id); s.lastStatus = ''; s.lastChecked = null; s.lastError = ''; save(); res.json({ ok: true });
});
app.post('/api/societies/:id/extract', async (req, res) => {
  const s = db.societies.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try { res.json(await crawler.extractCurrent(s)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 巡回 ----
app.post('/api/crawl', async (req, res) => {
  try {
    const run = await crawler.startRun(req.body?.societyIds || null, { trigger: 'manual' });
    res.json(run);
  } catch (e) { res.status(409).json({ error: e.message }); }
});
app.get('/api/runs/current', (req, res) => res.json(crawler.getCurrentRun()));
app.get('/api/runs/:id', (req, res) => {
  const r = db.runs.find(x => x.id === req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});

// ---- 更新情報 ----
app.post('/api/items', async (req, res) => {
  const b = req.body || {};
  const s = db.societies.find(x => x.id === b.societyId);
  if (!s) return res.status(400).json({ error: '学会を選択してください' });
  try {
    if (b.url && !b.title) {
      const r = await crawler.extractFromUrl(s, b.url);
      return res.json({ created: r.created, extracted: r.extracted, message: r.created.length ? `${r.created.length} 件を追加しました` : '追加できる新しい情報が見つかりませんでした（重複または該当なし）' });
    }
    const item = crawler.addItem({ societyId: s.id, title: b.title, url: b.url || null, date: b.date || null, eventDate: b.eventDate || null, category: b.category, summary: b.summary || '', source: 'manual', editor: b.editor || s.editor || '' });
    if (!item) return res.status(409).json({ error: '同じ件名または URL の情報がすでにあります' });
    res.json({ created: [item], message: '追加しました' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 一括操作（削除・状態変更）
app.post('/api/items/bulk', (req, res) => {
  const { ids = [], action, status } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '対象が選択されていません' });
  let n = 0;
  if (action === 'delete') {
    const set = new Set(ids); const before = db.items.length;
    db.items = db.items.filter(it => !set.has(it.id)); n = before - db.items.length;
  } else if (action === 'status' && STATUSES.includes(status)) {
    for (const it of db.items) if (ids.includes(it.id)) {
      it.status = status; it.updatedAt = new Date().toISOString();
      if (status === 'posted') it.postedAt = it.postedAt || it.updatedAt; else it.postedAt = null;
      n++;
    }
  } else return res.status(400).json({ error: '不正な操作です' });
  save(); res.json({ ok: true, count: n });
});

app.put('/api/items/:id', (req, res) => {
  const it = db.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  for (const k of ['title', 'url', 'date', 'eventDate', 'category', 'summary', 'notes', 'editor', 'draft', 'newsDraft', 'postedUrl', 'postedBy', 'postedAt', 'importance', 'societyId']) if (k in b) it[k] = b[k];
  if (b.status && STATUSES.includes(b.status)) {
    it.status = b.status;
    if (b.status === 'posted') { it.postedAt = it.postedAt || new Date().toISOString(); }
    else it.postedAt = null;
  }
  if ('draft' in b && b.draft && it.status === 'accepted') it.status = 'drafted';
  it.updatedAt = new Date().toISOString();
  save(); res.json(it);
});
app.delete('/api/items/:id', (req, res) => {
  const i = db.items.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  db.items.splice(i, 1); save(); res.json({ ok: true });
});
app.post('/api/items/:id/draft', async (req, res) => {
  const it = db.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const s = db.societies.find(x => x.id === it.societyId) || { name: '', url: '' };
  try {
    const text = await ai.draftPost({ item: it, society: s });
    it.draft = text; it.draftAt = new Date().toISOString(); it.updatedAt = it.draftAt;
    if (it.status === 'new' || it.status === 'accepted') it.status = 'drafted';
    save(); res.json({ item: it, length: xLength(text) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/items/:id/news-draft', async (req, res) => {
  const it = db.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const s = db.societies.find(x => x.id === it.societyId) || { name: '', url: '' };
  try {
    it.newsDraft = await ai.draftNews({ item: it, society: s }); it.updatedAt = new Date().toISOString();
    save(); res.json({ item: it });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV 書き出し（Excel 対応 BOM 付き）
app.get('/api/items.csv', (req, res) => {
  const cols = ['検知日', '学会', '分類', '件名', '日付情報', 'URL', '概要', '状態', '担当', 'メモ', '投稿文', '投稿日', '投稿URL'];
  const label = { new: '新着', accepted: '採用', drafted: '投稿案あり', posted: '投稿済み', rejected: '見送り' };
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = db.items.map(it => {
    const s = db.societies.find(x => x.id === it.societyId);
    return [it.foundAt?.slice(0, 10), s?.name || '', it.category, it.title, it.eventDate || it.date || '', it.url || '', it.summary, label[it.status] || it.status, it.editor, it.notes, it.draft, it.postedAt?.slice(0, 10) || '', it.postedUrl].map(esc).join(',');
  });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="uals-pr-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + [cols.map(esc).join(','), ...rows].join('\r\n'));
});

// ---- 設定 ----
app.get('/api/settings', (req, res) => res.json(publicSettings()));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  for (const k of ['openaiModel', 'postStyle', 'hashtags', 'maxChars', 'autoCrawlEnabled', 'autoCrawlHour', 'editors', 'xAccount']) if (k in b) db.settings[k] = b[k];
  if ('openaiApiKey' in b) {
    if (b.openaiApiKey === '') delete db.settings.openaiApiKey;
    else if (b.openaiApiKey) db.settings.openaiApiKey = String(b.openaiApiKey).trim();
  }
  save(); res.json(publicSettings());
});
app.post('/api/settings/test-ai', async (req, res) => {
  try { res.json(await ai.testConnection()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 自動巡回（毎日指定時刻） ----
setInterval(() => {
  const st = db.settings;
  if (!st.autoCrawlEnabled) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() === Number(st.autoCrawlHour ?? 6) && st.lastAutoCrawlDate !== today) {
    st.lastAutoCrawlDate = today; save();
    crawler.startRun(null, { trigger: 'auto' }).catch(e => console.error('自動巡回失敗:', e.message));
  }
}, 60 * 1000);

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });

app.listen(PORT, () => {
  console.log(`言語系学会連合 広報支援アプリ: http://localhost:${PORT}`);
  console.log(`データ保存先: ${DATA_DIR}  / AI: ${ai.available() ? ai.model() : '未設定'}`);
});
