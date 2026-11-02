// テキスト処理ユーティリティ（サーバー・クライアント共通ロジックはここに）

// X（Twitter）の文字数カウント。twitter-text v3 の重み付けに準拠：
// U+0000–U+10FF、一部の約物は 1、それ以外（日本語・絵文字など）は 2、URL は一律 23。上限 280。
function xLength(text) {
  if (!text) return 0;
  let n = 0;
  const rest = text.replace(/https?:\/\/[^\s]+/g, () => { n += 23; return ''; });
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

function normalizeUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) x.searchParams.delete(k);
    let s = x.host.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + (x.search || '');
    return s.replace(/\/index\.(html?|php)$/i, '');
  } catch { return u.trim().toLowerCase(); }
}

function normalizeTitle(t) {
  return (t || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function toISODate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d)) {
    const m = /(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return null;
  }
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function todayISO() { return toISODate(new Date()); }

module.exports = { xLength, normalizeUrl, normalizeTitle, toISODate, todayISO };
