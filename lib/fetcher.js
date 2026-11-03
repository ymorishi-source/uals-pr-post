// Web ページ・RSS の取得、文字コード変換、HTML→テキスト変換
const { toISODate } = require('./text');
const tlsChain = require('./tls-chain');

const UA = 'Mozilla/5.0 (compatible; UALS-PR-Assistant/1.0; +https://uals.net/)';
const TIMEOUT_MS = 25000;

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en;q=0.8',
};

async function fetchRaw(url) {
  // 以前に中間証明書を補完したホストは、最初から補完付きで取得する
  if (/^https:/i.test(url) && tlsChain.hasResolvedChain(new URL(url).host)) return fetchViaAia(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: HEADERS });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ok: res.ok, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '', buf };
  } catch (e) {
    const code = e?.cause?.code || '';
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw new Error('タイムアウト（25秒）');
    // サーバーが中間証明書を送ってこない場合は、ブラウザと同様に AIA から取り寄せて再検証する
    if (tlsChain.isChainError(code)) return fetchViaAia(url, code);
    if (/CERT|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(code)) throw new Error(`サーバー証明書を検証できません（${code}）。サイト側の証明書不備のため自動取得不可。手動で確認してください`);
    if (code === 'ENOTFOUND') throw new Error('ホスト名を解決できません（URL を確認してください）');
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') throw new Error(`接続できません（${code}）`);
    throw new Error(code ? `${e.message} (${code})` : e.message);
  } finally { clearTimeout(t); }
}

async function fetchViaAia(url, code) {
  try {
    return await tlsChain.fetchWithAia(url, { headers: HEADERS, timeout: TIMEOUT_MS });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('タイムアウト（25秒）');
    const c = e?.code || code || '';
    throw new Error(`サーバー証明書を検証できません（${c || e.message}）。中間証明書の自動補完も失敗しました。手動で確認してください`);
  }
}

function normCharset(cs) {
  cs = (cs || '').toLowerCase().replace(/['"]/g, '');
  if (['x-sjis', 'shift-jis', 'sjis', 'windows-31j', 'ms932', 'cp932'].includes(cs)) return 'shift_jis';
  if (['x-euc-jp', 'eucjp'].includes(cs)) return 'euc-jp';
  if (cs === 'utf8') return 'utf-8';
  return cs;
}
function metaCharset(buf) {
  const head = buf.subarray(0, 16384).toString('latin1');
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head) || /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head);
  return m ? normCharset(m[1]) : null;
}
function tryDecode(buf, cs) {
  try { return new TextDecoder(cs, { fatal: false }).decode(buf); } catch { return null; }
}
function badness(s) { // U+FFFD の比率
  const bad = (s.match(/�/g) || []).length;
  return s.length ? bad / s.length : 0;
}
function decodeBody(buf, contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const headerCs = m ? normCharset(m[1]) : null;
  const metaCs = metaCharset(buf);
  const candidates = [...new Set([headerCs, metaCs, 'utf-8', 'shift_jis', 'euc-jp'].filter(Boolean))];
  let best = null, bestScore = Infinity;
  for (const cs of candidates) {
    const s = tryDecode(buf, cs);
    if (s == null) continue;
    const score = badness(s);
    if (score < bestScore) { best = s; bestScore = score; }
    if (score < 0.001) break;
  }
  return best ?? buf.toString('utf8');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', laquo: '«', raquo: '»', times: '×', yen: '¥', rarr: '→', larr: '←' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function absUrl(href, base) {
  if (!href) return null;
  href = href.trim();
  if (/^(javascript:|mailto:|tel:|#|data:)/i.test(href)) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

// HTML → 行テキスト。リンクは「リンク文字 [URL]」の形で残す（AI が URL を拾えるように）
function htmlToText(html, baseUrl) {
  if (!html) return '';
  let s = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (m, q, href, inner) => {
    const txt = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const abs = absUrl(decodeEntities(href), baseUrl);
    if (!abs || !txt) return ' ' + inner + ' ';
    return ` ${txt} [${abs}] `;
  });
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6]|tr|td|th|dt|dd|section|article|header|footer|nav|aside|main|ul|ol|table|blockquote|pre|figure|figcaption|option|label|form)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/ /g, ' ').replace(/[ \t\r\f\v　]+/g, ' ');
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.join('\n');
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}
function discoverFeed(html, baseUrl) {
  const re = /<link\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(tag) && /rel\s*=\s*["'][^"']*alternate/i.test(tag)) {
      const h = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (h) { const u = absUrl(decodeEntities(h[1]), baseUrl); if (u && !/comments/i.test(u)) return u; }
    }
  }
  return null;
}
function frameUrls(html, baseUrl) {
  const out = []; const re = /<i?frame\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi; let m;
  let base;
  try { base = new URL(baseUrl); } catch { return out; }
  while ((m = re.exec(html))) {
    const u = absUrl(m[1], baseUrl);
    if (!u) continue;
    try { if (new URL(u).host === base.host && !out.includes(u)) out.push(u); } catch { /* skip */ }
  }
  return out.slice(0, 6);
}

// ページを取得して本文テキストにする（フレーム構造のサイトは子フレームも連結）
async function getPage(url) {
  const r = await fetchRaw(url);
  if (r.buf.length < 200 && !r.ok) throw new Error(`HTTP ${r.status}`);
  const html = decodeBody(r.buf, r.contentType);
  let text = htmlToText(html, r.finalUrl);
  const frames = frameUrls(html, r.finalUrl);
  for (const fu of frames) {
    try {
      const fr = await fetchRaw(fu);
      const fhtml = decodeBody(fr.buf, fr.contentType);
      text += '\n' + htmlToText(fhtml, fr.finalUrl);
    } catch { /* フレーム1枚の失敗は無視 */ }
  }
  return { url, finalUrl: r.finalUrl, status: r.status, title: extractTitle(html), text, feedUrl: discoverFeed(html, r.finalUrl), frames };
}

function stripCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const get = (tag) => {
      const r = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(b);
      return r ? decodeEntities(stripCdata(r[1])).trim() : '';
    };
    let link = get('link');
    if (isAtom || !link) {
      const r = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(b);
      if (r) link = decodeEntities(r[1]);
    }
    const title = htmlToText(get('title')).replace(/\n/g, ' ');
    const date = toISODate(get('pubDate') || get('published') || get('updated') || get('dc:date'));
    const descHtml = get('content:encoded') || get('description') || get('summary') || get('content');
    const description = htmlToText(stripCdata(descHtml)).slice(0, 1200);
    if (title || link) items.push({ title, link: link.trim(), date, description });
  }
  return items;
}
async function getFeed(url) {
  const r = await fetchRaw(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = decodeBody(r.buf, r.contentType);
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 2000))) throw new Error('RSS/Atom 形式ではありません');
  return parseFeed(xml);
}

module.exports = { getPage, getFeed, htmlToText, decodeEntities, fetchRaw, decodeBody, UA };
