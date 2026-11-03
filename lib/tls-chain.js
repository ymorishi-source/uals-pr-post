// 中間証明書を送ってこないサーバーへの対応（AIA 追跡）
//
// 一部のサイト（例: dialectology-jp.org）はサーバー証明書だけを送り、中間 CA 証明書を
// 省略しているため、Node.js の標準の fetch では「UNABLE_TO_VERIFY_LEAF_SIGNATURE」で失敗する。
// ブラウザはこの場合、証明書の Authority Information Access (AIA) 拡張に書かれた URL から
// 発行者（中間 CA）の証明書を取り寄せて検証を続ける。ここでは同じことを行う。
//
// 検証そのものは一切緩めない:
//  - 取り寄せた中間証明書は、Node.js 同梱の信頼済みルート CA まで署名が連鎖することを
//    通常どおり OpenSSL が検証する（偽の中間証明書を混ぜても通らない）。
//  - 自己署名・ホスト名不一致・期限切れなどは従来どおりエラーになる。
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const { X509Certificate } = require('node:crypto');

const ROOTS = tls.rootCertificates.map(p => { try { return new X509Certificate(p); } catch { return null; } }).filter(Boolean);
const issuerCache = new Map(); // AIA URL -> PEM
const hostCache = new Map();   // host -> [PEM] （一度解決したホストは以後そのまま使う）

// AIA 追跡で対応できる検証エラー（＝中間証明書が欠けているだけの状態）
const CHAIN_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);
function isChainError(code) { return CHAIN_ERRORS.has(code); }

function caIssuerUrls(cert) {
  // infoAccess 例: "CA Issuers - URI:http://r11.i.lencr.org/\nOCSP - URI:http://..."
  return [...String(cert.infoAccess || '').matchAll(/CA Issuers - URI:(\S+)/g)].map(m => m[1]).filter(u => /^https?:/i.test(u));
}
function issuedByTrustedRoot(cert) { return ROOTS.some(r => cert.checkIssued(r)); }

// サーバーが提示する証明書を読み取るだけの接続。HTTP リクエストは一切送らず、
// 証明書を取得した時点で切断する（AIA の URL を知るためだけに使う）。
function peekLeafCertificate(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = sock.getPeerX509Certificate();
      sock.destroy();
      cert ? resolve(cert) : reject(new Error('証明書を取得できません'));
    });
    sock.setTimeout(10000, () => { sock.destroy(); reject(new Error('証明書の読み取りがタイムアウト')); });
    sock.on('error', reject);
  });
}

function getBuffer(url, { timeout = 10000, ca } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout, ca, headers: { 'User-Agent': 'UALS-PR-Assistant/1.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('タイムアウト')));
    req.on('error', reject);
  });
}

async function fetchIssuer(aiaUrl) {
  if (issuerCache.has(aiaUrl)) return issuerCache.get(aiaUrl);
  const r = await getBuffer(aiaUrl);
  if (r.status !== 200) throw new Error(`中間証明書の取得に失敗 (${aiaUrl}: HTTP ${r.status})`);
  const cert = new X509Certificate(r.buf); // DER / PEM どちらも受け付ける
  issuerCache.set(aiaUrl, cert);
  return cert;
}

// leaf から信頼済みルートの直下まで、欠けている中間証明書を集める
async function resolveMissingChain(leaf) {
  const pems = [];
  let cur = leaf;
  for (let hop = 0; hop < 3 && !issuedByTrustedRoot(cur); hop++) {
    const urls = caIssuerUrls(cur);
    if (!urls.length) throw new Error('証明書に発行者 URL (AIA) がありません');
    let issuer = null;
    for (const u of urls) {
      try {
        const c = await fetchIssuer(u);
        // 取得した証明書が本当に発行者か（署名が一致するか）を確認
        if (cur.checkIssued(c) && cur.verify(c.publicKey)) { issuer = c; break; }
      } catch { /* 次の URL を試す */ }
    }
    if (!issuer) throw new Error('発行者証明書を取得・確認できません');
    pems.push(issuer.toString());
    cur = issuer;
  }
  if (!issuedByTrustedRoot(cur)) throw new Error('信頼済みルート CA に連鎖しません');
  return pems;
}

// 補完した中間証明書を加えて HTTPS 取得（リダイレクト追従）。検証は通常どおり行われる。
function requestWithCa(url, extraPems, { headers, timeout }) {
  const ca = [...tls.rootCertificates, ...extraPems];
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { ca, headers, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('タイムアウト'), { name: 'TimeoutError' })));
    req.on('error', reject);
  });
}

async function fetchWithAia(url, { headers = {}, timeout = 25000, maxRedirects = 5 } = {}) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  let pems = hostCache.get(u.host);
  if (!pems) {
    const leaf = await peekLeafCertificate(u.hostname, port);
    pems = await resolveMissingChain(leaf);
    hostCache.set(u.host, pems);
  }
  let cur = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await requestWithCa(cur, pems, { headers, timeout });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      cur = new URL(r.headers.location, cur).href;
      continue;
    }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, finalUrl: cur, contentType: r.headers['content-type'] || '', buf: r.buf };
  }
  throw new Error('リダイレクトが多すぎます');
}

function hasResolvedChain(host) { return hostCache.has(host); }

module.exports = { isChainError, fetchWithAia, hasResolvedChain };
