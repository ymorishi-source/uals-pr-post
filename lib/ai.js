// OpenAI API 連携（Chat Completions, JSON Schema 出力）。依存ライブラリなしで fetch を直接使う。
const { db } = require('./db');
const { xLength, todayISO } = require('./text');

const CATEGORIES = ['大会', '研究会・講演会', '発表募集', '論文投稿募集', '刊行', '公募・助成', '会務', 'その他'];

function apiKey() { return (db.settings.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(); }
function model() { return (db.settings.openaiModel || process.env.OPENAI_MODEL || 'gpt-5-mini').trim(); }
function available() { return !!apiKey(); }

async function chat({ messages, schema, schemaName = 'result', maxTokens = 4000 }) {
  const key = apiKey();
  if (!key) throw new Error('OpenAI API キーが設定されていません（設定画面から登録してください）');
  const body = { model: model(), messages };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  body.max_completion_tokens = maxTokens;
  // 推論モデル（gpt-5 系・o 系）は思考トークンも上限に含まれるため、推論量を抑えて本文を確保する
  if (/^(gpt-5|o\d)/.test(body.model)) body.reasoning_effort = db.settings.reasoningEffort || 'low';

  let res = await post(key, body);
  if (!res.ok && res.status === 400 && body.reasoning_effort) {
    const err = await res.text();
    if (/reasoning_effort|reasoning/i.test(err)) { delete body.reasoning_effort; res = await post(key, body); }
    else res = { ok: false, status: 400, text: async () => err };
  }
  if (!res.ok) {
    const err = await res.text();
    // 古いモデル向けのフォールバック（max_completion_tokens / json_schema 非対応など）
    if (res.status === 400 && /max_completion_tokens|response_format|json_schema/i.test(err)) {
      delete body.max_completion_tokens; body.max_tokens = maxTokens;
      if (schema) body.response_format = { type: 'json_object' };
      res = await post(key, body);
      if (!res.ok) throw new Error(`OpenAI API エラー ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } else {
      throw new Error(`OpenAI API エラー ${res.status}: ${err.slice(0, 300)}`);
    }
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new Error('モデルが応答を拒否しました: ' + msg.refusal);
  const content = (msg?.content || '').trim();
  if (schema) {
    try { return JSON.parse(content); } catch { 
      const m = /\{[\s\S]*\}/.exec(content); if (m) return JSON.parse(m[0]);
      throw new Error('AI の応答を JSON として解釈できませんでした');
    }
  }
  return content;
}
function post(key, body) {
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
}

const ITEM_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'url', 'date', 'eventDate', 'category', 'summary', 'importance'],
        properties: {
          title: { type: 'string', description: '告知の見出し（学会名は含めない、40字以内）' },
          url: { type: ['string', 'null'], description: '詳細ページの絶対URL。本文中の [URL] から該当するものを選ぶ。なければ null' },
          date: { type: ['string', 'null'], description: '掲載日 YYYY-MM-DD。不明なら null' },
          eventDate: { type: ['string', 'null'], description: '開催日・締切など日付情報の要約（例: 2026年12月6日（土）、締切 2026-11-30）。なければ null' },
          category: { type: 'string', enum: CATEGORIES },
          summary: { type: 'string', description: '日本語で2〜3文。日時・会場（オンライン含む）・テーマ・締切など広報に必要な事実を含める' },
          importance: { type: 'integer', description: '広報価値 1(低)〜3(高)。大会・公開講演・CFP は 3' },
        },
      },
    },
  },
};

const SYSTEM_EXTRACT = `あなたは「言語系学会連合」（UALS）の広報編集委員を補助するアシスタントです。
加盟学会のウェブサイトに新しく追加されたテキストから、連合として会員・一般に広報する価値のある「お知らせ」を抽出し、JSON で返します。

抽出対象: 大会・研究会・講演会・シンポジウム・ワークショップの開催案内、発表募集（CFP）、論文投稿募集、学会誌・刊行物の発行、公募・助成・賞、重要な会務連絡（総会など）。
除外対象: ナビゲーションメニュー、著作権表示、カウンター、日付ウィジェット、会員限定の事務連絡、過去（開催済み・締切済み）の情報、単なるリンク一覧、意味の取れない断片。
注意:
- 同じ告知が複数回出ていれば 1 件にまとめる。
- URL は本文中の [ ] 内に示された絶対URLのうち、その告知の詳細ページに最もふさわしいものを選ぶ。該当がなければ null。
- 推測で情報を補わない。本文にない日時や会場を書かない。
- 該当するものがなければ items を空配列にする。`;

async function extractItems({ society, pages }) {
  const today = todayISO();
  const parts = pages.map(p => `■ ページ: ${p.url}\n${p.text}`).join('\n\n');
  const user = `今日の日付: ${today}\n学会名: ${society.name}${society.short ? `（${society.short}）` : ''}\n学会サイト: ${society.url}\n\n以下は新しく追加されたテキストです。\n\n${parts.slice(0, 60000)}`;
  const out = await chat({
    messages: [{ role: 'system', content: SYSTEM_EXTRACT }, { role: 'user', content: user }],
    schema: ITEM_SCHEMA, schemaName: 'announcements', maxTokens: 12000,
  });
  return Array.isArray(out.items) ? out.items : [];
}

function styleGuide() {
  return db.settings.postStyle || `実際の @uals_pr の投稿と同じ書式・分量にする（全体で 4〜7 行、日本語 120 字程度まで）：
1 行目：【学会名】（墨付き括弧【】で囲む。正式名称のみ。略称や法人格は付けない）
2 行目：空行
3 行目：件名。「〜開催のお知らせ」「〜募集のお知らせ」「〜公開のお知らせ」のように「〜のお知らせ」で終える
4 行目以降：「日時：」「日程：」「場所：」「会場：」「テーマ：」「講師：」「締切：」のうち重要なもの 2〜4 行だけを「項目名：内容」の形で。内容説明・方式・懇親会・定員などの付随情報は書かない
最後：空行のあと詳細ページの URL を 1 つ
・日付は「1月10日（日）13:30〜16:45」のように月日＋曜日＋時刻。年をまたぐ場合だけ年を入れる
・敬体。絵文字・記号の装飾・煽り表現は使わない
・ハッシュタグは指定されたもの以外付けない（指定が空なら付けない）`;
}

async function draftPost({ item, society }) {
  const hashtags = (db.settings.hashtags || '').trim() || '（なし）';
  const limit = Number(db.settings.maxChars) || 280;
  const sys = `あなたは「言語系学会連合」（UALS）の公式 X（旧Twitter）アカウントの広報担当です。加盟学会の告知を会員・研究者・学生に紹介する投稿文を日本語で 1 本作成します。
スタイル:
${styleGuide()}
制約:
- X の文字数カウント（全角 2・半角 1・URL 23）で ${limit} 以内。日本語なら概ね ${Math.floor((limit - 30) / 2)} 文字以内が目安
- 投稿文のみを出力し、前置きや説明は書かない
- 告知にない情報を創作しない`;
  const user = `学会名: ${society.name}${society.short ? `（${society.short}）` : ''}
件名: ${item.title}
分類: ${item.category || ''}
日付情報: ${item.eventDate || item.date || '不明'}
概要: ${item.summary || ''}
URL: ${item.url || society.url}
ハッシュタグ: ${hashtags}
${item.notes ? `担当者メモ: ${item.notes}` : ''}`;
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  let text = clean(await chat({ messages: msgs, maxTokens: 3000 }));
  for (let i = 0; i < 3 && xLength(text) > limit; i++) {
    const over = xLength(text) - limit;
    msgs.push({ role: 'assistant', content: text });
    msgs.push({ role: 'user', content: `この投稿文は X の文字数制限を ${over} 超えています（現在 ${xLength(text)}、上限 ${limit}。全角 1 字が 2、URL は 23 と数えます）。【学会名】・件名・URL は残し、項目行を減らすか短くして、必ず上限以内に収めてください。投稿文のみ出力。` });
    text = clean(await chat({ messages: msgs, maxTokens: 3000 }));
  }
  return text;
}

function clean(t) { return (t || '').trim().replace(/^```[a-z]*\n?|```$/g, '').replace(/^["「]|["」]$/g, '').replace(/[ \t]+$/gm, '').trim(); }

async function draftNews({ item, society }) {
  const sys = `あなたは「言語系学会連合」（UALS）ウェブサイトの「お知らせ」記事を書く広報担当です。加盟学会の告知を転載・紹介する記事を日本語で作成します。
形式（uals.net の既存記事に合わせる）:
1 行目: 記事タイトル（例「○○学会 第N回大会のご案内」「○○学会 2026年度研究会 開催・発表募集のご案内」）
2 行目: 空行
3 行目以降: 「・項目名：内容」の箇条書き（テーマ、日時、会場／開催形式、講師・発表者、参加費、申込方法、締切など、分かっている項目だけ）
最後に「・詳細：URL」
注意: 告知にない情報は書かない。敬体。前置きや説明は出力しない。`;
  const user = `学会名: ${society.name}${society.short ? `（${society.short}）` : ''}
件名: ${item.title}
分類: ${item.category || ''}
日付情報: ${item.eventDate || item.date || '不明'}
概要: ${item.summary || ''}
元テキスト（抜粋）:
${(item.raw || '').slice(0, 4000)}
URL: ${item.url || society.url}`;
  return clean(await chat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 4000 }));
}

async function testConnection() {
  const t = await chat({ messages: [{ role: 'user', content: '「接続OK」とだけ返答してください。' }], maxTokens: 300 });
  return { ok: true, model: model(), reply: t };
}

module.exports = { available, model, extractItems, draftPost, draftNews, testConnection, CATEGORIES, styleGuide };
