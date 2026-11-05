#!/usr/bin/env node
// songs.txt を読んで、YouTubeの曲ごとに songs/<id>.json を作る「曲プロセッサー」。
//   node tools/process-songs.mjs            … まだ処理していない曲だけ
//   node tools/process-songs.mjs --force    … 全部やり直し
//   node tools/process-songs.mjs --only ID  … 1曲だけ
//   node tools/process-songs.mjs --offline  … ネットなし(songs/src/<id>.lrc があるときのテスト用)
//
// 歌詞の入手元(上から順に試す):
//   1. songs/src/<id>.lrc  … 自分で置いた時間つき歌詞(LRC形式)
//   2. LRCLIB (lrclib.net) … 時間つき歌詞の公開データベース
//   3. YouTubeの英語字幕   … 公式字幕/自動字幕
import { scanLines, rejectReason } from './safety.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeLine } from './grade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONGS = path.join(ROOT, 'songs');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const OFFLINE = args.includes('--offline');
const VERIFY = args.includes('--verify');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = (...a) => console.log(...a);
const errors = [];
const secsOf = new Map();     // 動画ID → 動画の長さ(秒) (検索結果から)
const resolved = new Map();   // search: の行 → 見つけた動画ID(あとで songs.txt をURLに書きかえる)

async function get(url, opts = {}) {
  for (let i = 0; ; i++) {
    try { return await getOnce(url, opts); } catch (e) {
      if (i >= 3) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (i + 1)));   // YouTube に ブロックされにくいよう、まって やりなおす
    }
  }
}
async function getOnce(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 20000);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI', ...(opts.headers || {}) } });
  } finally { clearTimeout(timer); }
}

async function getRetry(url, tries = 4) {
  let r;
  for (let i = 0; i < tries; i++) {
    try { r = await get(url); if (r.status < 500 && r.status !== 429) return r; } catch (e) { if (i === tries - 1) throw e; }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return r;
}

// ---------- songs.txt ----------
function parseSongsTxt(quiet = false) {
  const file = path.join(ROOT, 'songs.txt');
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    const head = parts[0];
    const e = { raw: line, offset: 0, expect: null, id: null, search: null, genre: '', year: 0, allow: false, pin: false, extra: [] };
    const idm = head.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/) || (/^[A-Za-z0-9_-]{11}$/.test(head) ? [0, head] : null);
    if (idm) e.id = idm[1];
    else if (/^search:/i.test(head)) e.search = head.replace(/^search:/i, '').trim();
    else { if (!quiet) errors.push(`読めない行: ${line}`); continue; }
    for (const p of parts.slice(1)) {
      const om = p.match(/^offset\s*=\s*(-?[\d.]+)$/i);
      const gm = p.match(/^genre\s*=\s*(.+)$/i), ym = p.match(/^year\s*=\s*(\d{4})$/i);
      if (/^allow$/i.test(p)) { e.allow = true; e.extra.push(p); continue; }
      if (/^pin$/i.test(p)) { e.pin = true; e.extra.push(p); continue; }
      if (om) { e.offset = parseFloat(om[1]); e.extra.push(p); }
      else if (gm) { e.genre = gm[1].trim(); e.extra.push(p); }
      else if (ym) { e.year = +ym[1]; e.extra.push(p); }
      else if (p) e.expect = p;
    }
    if (e.search && !e.expect) e.expect = e.search;
    out.push(e);
  }
  return out;
}

// ---------- YouTube ----------
async function searchYouTube(q) {
  const r = await get('https://www.youtube.com/results?search_query=' + encodeURIComponent(q + ' official'));
  const html = await r.text();
  const ids = [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]);
  return [...new Set(ids)].slice(0, 5);
}


// ---------- 動画えらび・かくにん ----------
function walk(o, f) { if (o && typeof o === 'object') { f(o); for (const k of Object.keys(o)) walk(o[k], f); } }
const toSecs = (t) => (t || '').split(':').reduce((a, x) => a * 60 + (+x || 0), 0);
/** 検索結果ページ → [{id,title,channel,secs}] (タイトル・チャンネル・長さつき) */
async function searchCands(q) {
  const r = await get('https://www.youtube.com/results?search_query=' + encodeURIComponent(q));
  const html = await r.text();
  const i = html.indexOf('ytInitialData = ');
  const out = [];
  if (i >= 0) {
    const j = html.indexOf('</script>', i);
    try {
      const data = JSON.parse(html.slice(i + 16, j).replace(/;\s*$/, ''));
      walk(data, (o) => {
        if (o.videoRenderer && o.videoRenderer.videoId) {
          const v = o.videoRenderer;
          out.push({ id: v.videoId, title: (v.title?.runs || []).map((x) => x.text).join(''), channel: v.ownerText?.runs?.[0]?.text || '', secs: toSecs(v.lengthText?.simpleText) });
        }
      });
    } catch { /* ignore */ }
  }
  return out.filter((c, k) => out.findIndex((d) => d.id === c.id) === k);
}
const BAD_TITLE = /\b(live|performance|performs?|performed|cover|karaoke|reaction|react|instrumental|remix|slowed|sped|nightcore|8d|medley|scene|clip|behind|tutorial|piano|stage|concert|tour|mashup|extended|hour|loop|trailer|interview|making|rehearsal|acoustic|lesson|choreograph\w*|fancam|shorts|premiere|awards?|oscars?|grammys?|snl|episode|full movie|multilingual|languages|reprise|lyrics?|lyric video|sing[- ]?along|ver\.|version|duet|twin|sings|singing|d23|expo|toppop|wildlife|bbc|session|amv|anime|edit|soundtrack version|full video|unofficial)\b/i;
const words = (t) => (t || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').split(/[^a-z0-9']+/).filter((w) => w.length > 2);
/** 動画の点数。ことわる(null)・OKなら点数(大きいほどよい)。lrcDur=歌詞データの曲の長さ */
function scoreCand(c, expect, lrcDur, movie = false) {
  const [a0, ...t0] = (expect || '').split(' - ');
  const tw = words(t0.join(' - ') || a0), aw = words(a0);
  const hay = (c.title + ' ' + c.channel).toLowerCase();
  if (tw.length && tw.filter((w) => hay.includes(w)).length < Math.ceil(tw.length / 2)) return null;
  // 公式っぽいチャンネルだけ(ほかのひとの再アップロード・ファン動画は、きえたり ずれたりするので使わない)
  const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]/g, '');
  const ch = norm(c.channel);
  const artists = a0.split(/,|&|\bfeat\.?\b|\bx\b|\band\b/i).map(norm).filter((x) => x.length > 2);
  const isFan = /fan|playlist|lyrics?|hits|bestof|clips|tvshow|reupload|channel$/.test(ch);
  const chOK = !isFan && (artists.some((x) => ch.startsWith(x) || ch.startsWith(x.replace(/^the/, ''))) || /^(disney|waltdisney|pixar|illumination|dreamworks|universalpictures|warnerbros|nickelodeon|paramount|hybe|netflix$|sonypicturesanimation|ygentertainment|smtown|jype|atlanticrecords|columbiarecords|republicrecords|interscope|capitolrecords|warnerrecords|universalmusic|mountainapple|avicii)/.test(ch) || (/topic$/.test(ch) && artists.some((x) => ch.includes(x))));
  if (!chOK) return null;
  // 「アーティスト - 曲名」の形のタイトルは、アーティストが合っていること(別のひとのカバーをさける)
  const pre = (c.title.split(/\s[-–]\s/)[0] || '');
  if (/\s[-–]\s/.test(c.title) && !/- topic$/i.test(c.channel) && aw.length && !words(pre).some((w) => aw.includes(w)) && words(pre).length) return null;
  if (BAD_TITLE.test(c.title)) return null;
  if (movie) {   // 映画の歌は「映画の場面の公式ビデオ」だけ(音だけ・歌詞つき・ファン動画はだめ)
    if (/audio|visuali[sz]er|topic|lyric|karaoke/i.test(c.title + ' ' + c.channel)) return null;
    if (!/official (music )?video|\(from |from ["“]|music video|m\/v/i.test(c.title)) return null;
  }                       // ライブ・歌詞つき・カバー・ひとの動画など
  if (!c.secs) return null;
  let sc = 0;
  const lds = [].concat(lrcDur || []).filter(Boolean);
  if (lds.length) { const d = Math.min(...lds.map((x) => Math.abs(c.secs - x))); const tol = /official audio|visuali[sz]er|\(audio\)|audio only|topic$/i.test(c.title + ' ' + c.channel) ? 8 : 3; if (d > tol) return null; sc += d <= 1 ? 60 : d <= 2 ? 50 : 30; }
  if (/official (music )?video|\(official\)|official$/i.test(c.title)) sc += 30;
  else if (/official audio|visuali[sz]er/i.test(c.title)) sc += 15;
  if (/vevo|disney|records|official/i.test(c.channel)) sc += 15;
  if (/- topic$/i.test(c.channel)) sc += 10;
  return sc;
}
async function lrcDuration(artist, title) {
  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    const r = await getRetry('https://lrclib.net/api/search?' + q);
    const list = (await r.json()).filter((x) => x.syncedLyrics && (x.duration || 0) >= 60);
    const nLines = (x) => (x.syncedLyrics.match(/^\[\d/gm) || []).length;
    const mx = Math.max(0, ...list.map(nLines));
    return [...new Set(list.filter((x) => nLines(x) >= mx * 0.7).map((x) => Math.round(x.duration)))];
  } catch { return []; }
}
async function bestVideo(expect, lrcDur, movie = false) {
  const [a0, ...t0] = expect.split(' - ');
  const qs = [`${a0} ${t0.join(' - ')} official video`, ...(movie ? [`${t0.join(' - ')} from official video disney`] : []), `${a0} ${t0.join(' - ')} official audio`, `${a0} - Topic ${t0.join(' - ')}`];
  let all = [];
  for (const q of qs) { try { all = all.concat(await searchCands(q)); } catch { /* ignore */ } await new Promise((r) => setTimeout(r, 1200)); }
  const scored = all.map((c) => ({ c, sc: scoreCand(c, expect, lrcDur, movie) })).filter((x) => x.sc !== null).sort((a, b) => b.sc - a.sc);
  return scored.length ? scored[0].c : null;
}
/** いまの曲すべての動画をかくにんして、ダメなものは えらびなおす。結果は songs/VIDEOS.txt */
async function verifyAll() {
  const file = path.join(ROOT, 'songs.txt');
  let txt = fs.readFileSync(file, 'utf8');
  const rep = [];
  for (const e of parseSongsTxt(true)) {
    if (!e.id || !e.expect || e.pin) continue;
    const jf = path.join(SONGS, e.id + '.json');
    if (!fs.existsSync(jf)) continue;
    const sj = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const [a0, ...t0] = e.expect.split(' - ');
    const ld = await lrcDuration(a0, t0.join(' - '));
    let cands = [];
    try { cands = await searchCands(`${a0} ${t0.join(' - ')} official video`); } catch { /* ignore */ }
    let me = cands.find((c) => c.id === e.id);
    if (!me) { try { me = (await searchCands(e.id)).find((c) => c.id === e.id); } catch { /* ignore */ } }
    const desc = me ? `「${me.title}」/${me.channel}/${me.secs}s` : '(動画情報なし)';
    const movie = e.genre === 'アニメ・映画';
    const ok = me && scoreCand(me, e.expect, ld, movie) !== null;
    if (ok) { rep.push(`OK     ${e.expect}  ${desc}  歌詞${ld.join('/')}s`); sj.vdur = me.secs; sj.dur = me.secs; fs.writeFileSync(jf, JSON.stringify(sj)); continue; }
    await new Promise((r) => setTimeout(r, 1200));
    const b = await bestVideo(e.expect, ld, movie);
    if (b && b.id !== e.id) {
      rep.push(`FIXED  ${e.expect}  ${desc} → 「${b.title}」/${b.channel}/${b.secs}s  歌詞${ld.join('/')}s`);
      txt = txt.split(e.id).join(b.id); secsOf.set(b.id, b.secs);
      fs.rmSync(jf);
    } else {
      rep.push(`BAD    ${e.expect}  ${desc}  歌詞${ld.join('/')}s  ← 公式で長さの合う動画が見つからないので外した`);
      txt = txt.split('\n').map((l) => (l.includes(e.id) && !l.startsWith('#') ? '# 動画なし(外した): ' + l : l)).join('\n');
      fs.rmSync(jf);
    }
  }
  fs.writeFileSync(file, txt);
  fs.writeFileSync(path.join(SONGS, 'VIDEOS.txt'), '# 動画のかくにん結果 (OK=タイトル・長さが合う / FIXED=えらびなおした / BAD=見つからない)\n' + rep.join('\n') + '\n');
  log('\n' + rep.join('\n'));
}

async function oembed(id) {
  const r = await get(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`);
  if (r.status === 401 || r.status === 403) return { embeddable: false };
  if (!r.ok) throw new Error('oEmbed HTTP ' + r.status);
  const j = await r.json();
  return { embeddable: true, title: j.title, author: j.author_name };
}

async function watchInfo(id) {
  const r = await get('https://www.youtube.com/watch?v=' + id + '&hl=en');
  const html = await r.text();
  const dur = Number((html.match(/"lengthSeconds":"(\d+)"/) || [])[1]) || Math.round(Number((html.match(/"approxDurationMs":"(\d+)"/) || [])[1]) / 1000) || 0;
  let tracks = [];
  const m = html.match(/"captionTracks":(\[.*?\]),"(?:audioTracks|translationLanguages)"/);
  if (m) { try { tracks = JSON.parse(m[1]); } catch { /* ignore */ } }
  return { dur, tracks };
}

function cleanMeta(title, author, expect) {
  if (expect && expect.includes(' - ')) {
    const [a, ...t] = expect.split(' - ');
    return { artist: a.trim(), title: t.join(' - ').trim() };
  }
  let t = (title || '').replace(/[\(\[](official|lyrics?|lyric video|audio|music video|video|hd|hq|4k|remastered[^\)\]]*|mv|m\/v)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*\|.*$/, '').replace(/\s{2,}/g, ' ').trim();
  let a = (author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*official.*$/i, '').trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) { a = m[1].trim(); t = m[2].trim(); }
  return { artist: a, title: t };
}

// ---------- 歌詞 ----------
function parseLrc(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) rows.push({ t: Number(s[1]) * 60 + Number(s[2]), text: body });
  }
  rows.sort((a, b) => a.t - b.t);
  const lines = [];
  rows.forEach((r, i) => {
    const next = rows[i + 1] ? rows[i + 1].t : r.t + 5;
    if (r.text && !/^[\[\(].*[\]\)]$/.test(r.text)) lines.push({ t: r.t, e: Math.min(next, r.t + 9), text: r.text });
  });
  return lines;
}

async function fromLrclib(artist, title, dur) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  const r = await getRetry('https://lrclib.net/api/search?' + q);
  if (!r.ok) throw new Error('LRCLIB HTTP ' + r.status);
  let list = (await r.json()).filter((x) => x.syncedLyrics && (x.duration || 0) >= 60);
  if (!list.length) return null;
  const nLines = (x) => (x.syncedLyrics.match(/^\[\d/gm) || []).length;
  // 動画の長さがわかるときは近いもの、わからないときは行数が多い(=完全な)ものを選ぶ
  list.sort(dur ? (a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur) : (a, b) => nLines(b) - nLines(a));
  const best = list[0];
  return { lines: parseLrc(best.syncedLyrics), note: `${best.artistName} - ${best.trackName} (${Math.round(best.duration)}s)`, dur: Math.round(best.duration) };
}

async function fromCaptions(tracks) {
  const en = tracks.filter((t) => /^en/.test(t.languageCode));
  const tr = en.find((t) => t.kind !== 'asr') || en[0];
  if (!tr) return null;
  const r = await get(tr.baseUrl + '&fmt=json3');
  if (!r.ok) throw new Error('captions HTTP ' + r.status);
  const j = await r.json();
  const lines = [];
  for (const ev of j.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim();
    if (!text || /^[\[\(♪].*[\]\)♪]$/.test(text)) continue;
    const t = ev.tStartMs / 1000;
    if (lines.length && lines[lines.length - 1].text === text) continue;
    lines.push({ t, e: t + (ev.dDurationMs || 3000) / 1000, text });
  }
  return { lines, note: tr.kind === 'asr' ? '自動字幕' : '公式字幕' };
}

// ---------- 1曲 ----------
async function processOne(e) {
  let id = e.id;
  if (!id) {
    log(`🔎 検索: ${e.search}`);
    const [sa, ...st] = e.search.split(' - ');
    const ld = await lrcDuration(sa, st.join(' - '));
    const b = await bestVideo(e.search, ld, e.genre === 'アニメ・映画');
    if (!b) throw new Error(`曲の長さ(${ld.join('/') || '?'}秒)と合う公式っぽい動画が見つかりません。URLを直接書いてください`);
    id = b.id; e._secs = b.secs;
    resolved.set(e.raw, id);
    log(`   → ${id} 「${b.title}」/${b.channel}/${b.secs}s (歌詞${ld.join('/')}s)`);
  }
  const out = path.join(SONGS, id + '.json');
  if (fs.existsSync(out) && !FORCE && !ONLY) { log(`⏭  ${id} 処理ずみ`); return; }

  let meta = { title: '', author: '' }, dur = 0, tracks = [];
  const [a0, ...t0] = (e.expect || '').split(' - ');
  try {
    if (!OFFLINE) {
      const o = await oembed(id);
      if (!o.embeddable) throw new Error('この動画は埋め込み(再生)が許可されていません。別の動画を選んでください');
      meta = o;
      try { const w = await watchInfo(id); dur = w.dur; tracks = w.tracks; } catch (err) { log('   (動画情報の取得に失敗: ' + err.message + ')'); }
    }
  } catch (err) {
    if (!OFFLINE) throw err;
  }
  if (!dur) dur = e._secs || secsOf.get(id) || 0;
  if (!dur && !OFFLINE) { try { const c = (await searchCands(id)).find((x) => x.id === id); if (c) dur = c.secs; } catch { /* ignore */ } }
  const { artist, title } = cleanMeta(meta.title, meta.author, e.expect);
  if (e.expect && meta.title && !e.pin) {
    const hay = (meta.title + ' ' + meta.author).toLowerCase();
    const want = [a0, t0.join(' - ')].join(' ').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2);
    const hit = want.filter((w) => hay.includes(w)).length;
    if (want.length && hit < Math.ceil(want.length / 2)) throw new Error(`動画タイトル「${meta.title}」が指定「${e.expect}」と違うようです。URLを確認してください`);
  }
  log(`🎵 ${id}  ${artist} - ${title}  (${dur || '?'}s)`);

  let res = null, source = '';
  const manual = path.join(SONGS, 'src', id + '.lrc');
  if (fs.existsSync(manual)) { res = { lines: parseLrc(fs.readFileSync(manual, 'utf8')), note: 'manual' }; source = 'manual'; }
  if ((!res || !res.lines.length) && !OFFLINE) {
    try { res = await fromLrclib(artist, title, dur); source = 'lrclib'; } catch (err) { log('   LRCLIB: ' + err.message); }
  }
  if ((!res || !res.lines.length) && !OFFLINE) {
    try { res = await fromCaptions(tracks); source = 'captions'; } catch (err) { log('   字幕: ' + err.message); }
  }
  if (!res || res.lines.length < 4) throw new Error('時間つき歌詞が見つかりませんでした (songs/src/' + id + '.lrc に自分で置くこともできます)');
  log(`   歌詞: ${source} ${res.note || ''} / ${res.lines.length}行`);

  const lines = res.lines.map((l) => ({ t: +l.t.toFixed(2), e: +l.e.toFixed(2), w: tokenizeLine(l.text) })).filter((l) => l.w.length);
  const counts = [0, 1, 2, 3, 4].map((lv) => lines.reduce((n, l) => n + l.w.filter((w) => w[3] <= lv && w[1].length >= 3 && !w[5]).length, 0));
  const words = lines.reduce((n, l) => n + l.w.length, 0);
  const sc = scanLines(lines);
  if ((Object.keys(sc.strong).length || Object.keys(sc.hard).length) && !e.allow) throw new Error('歌詞に ふさわしくない内容: ' + rejectReason(sc) + ' (先生が OK なら songs.txt の その行に「| allow」を足す)');
  if (counts[4] < 12) throw new Error(`英語のブランク候補が少なすぎます(${counts[4]}こ)。英語が多い曲を選んでください`);
  const song = { id, yt: id, diff: calcDiff(lines), title, artist, dur: dur || res.dur || Math.ceil(lines[lines.length - 1].e + 5), lrcDur: res.dur || 0, source, offset: e.offset, lines };
  fs.writeFileSync(out, JSON.stringify(song));
  log(`   ✅ 保存 ${out.replace(ROOT + '/', '')}  総語数${words}  ブランク候補(小5/小6/中1/中2/中3)=${counts.join('/')}`);
}

// むずかしさ 1〜3: 英語のはやさ(1秒あたりの語数) と、中3でもならわない語の割合
function calcDiff(lines) {
  const en = lines.flatMap((l) => l.w.filter((w) => w[1]));
  if (!lines.length || !en.length) return 2;
  const span = Math.max(30, lines[lines.length - 1].e - lines[0].t);
  const wps = en.length / span;
  const hard = en.filter((w) => w[3] >= 5 && !w[5]).length / en.length;
  const score = wps / 2.2 + hard * 2;
  return score < 0.8 ? 1 : score < 1.2 ? 2 : 3;
}

function rebuildIndex() {
  const meta = new Map(parseSongsTxt(true).map((e) => [e.id || resolved.get(e.raw), e]));
  const idx = [];
  for (const f of fs.readdirSync(SONGS)) {
    if (!f.endsWith('.json') || f === 'index.json' || f === 'demo.json') continue;
    const s = JSON.parse(fs.readFileSync(path.join(SONGS, f), 'utf8'));
    const counts = [0, 1, 2, 3, 4].map((lv) => s.lines.reduce((n, l) => n + l.w.filter((w) => w[3] <= lv && w[1].length >= 3 && !w[5]).length, 0));
    const m = meta.get(s.id) || {};
    idx.push({ id: s.id, yt: s.yt, title: s.title, artist: s.artist, dur: s.dur, genre: m.genre || '', year: m.year || 0, diff: s.diff || calcDiff(s.lines), counts, mtime: fs.statSync(path.join(SONGS, f)).mtimeMs });
  }
  // songs.txt の並び順に表示
  const order = parseSongsTxt(true).map((e) => e.id).filter(Boolean);
  idx.sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999) || a.mtime - b.mtime);
  idx.forEach((x) => delete x.mtime);
  // 先生のチェック用: 気になることばを含む曲の一覧
  const rev = [];
  for (const x of idx) {
    const sj = JSON.parse(fs.readFileSync(path.join(SONGS, x.id + '.json'), 'utf8'));
    const sc = scanLines(sj.lines);
    const f = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
    const bad = rejectReason(sc);
    if (bad || Object.keys(sc.review).length) rev.push(`${x.artist} - ${x.title}\n   ${bad ? '【要注意】' + bad + '\n   ' : ''}${f(sc.review)}`);
  }
  fs.writeFileSync(path.join(SONGS, 'REVIEW.txt'), '# 歌詞に気になることばを含む曲 (先生チェック用。自動で作られます)\n\n' + rev.join('\n\n') + '\n');
  fs.writeFileSync(path.join(SONGS, 'index.json'), JSON.stringify(idx));
  log(`\n📚 songs/index.json  ${idx.length}曲`);
}

// ---------- main ----------
fs.mkdirSync(path.join(SONGS, 'src'), { recursive: true });
if (VERIFY) await verifyAll();
let entries = parseSongsTxt();
if (ONLY) entries = entries.filter((e) => e.id === ONLY);
for (const e of entries) {
  if (!OFFLINE) await new Promise((res) => setTimeout(res, 2500));
  try { await processOne(e); } catch (err) { errors.push(`${e.raw}\n     → ${err.message}`); log('   ❌ ' + err.message); }
}
rebuildIndex();
// 検索で見つけた曲は URL に書きかえて固定する(あとで検索結果が変わっても同じ動画のまま)
if (resolved.size) {
  const file = path.join(ROOT, 'songs.txt');
  const out = fs.readFileSync(file, 'utf8').split('\n').map((l) => {
    const raw = l.replace(/\s+#.*$/, '').trim();
    const e = entries.find((x) => x.raw === raw && resolved.has(raw));
    return e && fs.existsSync(path.join(SONGS, resolved.get(raw) + '.json')) ? [`https://www.youtube.com/watch?v=${resolved.get(raw)}`, e.expect, ...e.extra].join(' | ') : l;
  });
  fs.writeFileSync(file, out.join('\n'));
}
if (errors.length) {
  log('\n⚠️  うまくいかなかった曲:\n' + errors.map((x) => ' - ' + x).join('\n'));
  fs.writeFileSync(path.join(SONGS, 'REPORT.txt'), errors.join('\n') + '\n');
} else if (fs.existsSync(path.join(SONGS, 'REPORT.txt'))) fs.rmSync(path.join(SONGS, 'REPORT.txt'));
