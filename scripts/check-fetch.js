// 取得テスト: node scripts/check-fetch.js <URL> [--feed]
const { getPage, getFeed } = require('../lib/fetcher');
(async () => {
  const url = process.argv[2];
  if (!url) { console.error('usage: node scripts/check-fetch.js <URL> [--feed]'); process.exit(1); }
  if (process.argv.includes('--feed')) {
    const items = await getFeed(url);
    console.log(JSON.stringify(items.slice(0, 5), null, 2), `... ${items.length} items`);
  } else {
    const p = await getPage(url);
    console.log(`title: ${p.title}\nfinal: ${p.finalUrl}\nfeed: ${p.feedUrl}\nframes: ${p.frames.join(', ')}\nlines: ${p.text.split('\n').length}\n---`);
    console.log(p.text.slice(0, 1500));
  }
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
