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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeLine } from './grade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONGS = path.join(ROOT, 'songs');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const OFFLINE = args.includes('--offline');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = (...a) => console.log(...a);
const errors = [];

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 20000);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI', ...(opts.headers || {}) } });
  } finally { clearTimeout(timer); }
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
    const e = { raw: line, offset: 0, expect: null, id: null, search: null };
    const idm = head.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/) || (/^[A-Za-z0-9_-]{11}$/.test(head) ? [0, head] : null);
    if (idm) e.id = idm[1];
    else if (/^search:/i.test(head)) e.search = head.replace(/^search:/i, '').trim();
    else { if (!quiet) errors.push(`読めない行: ${line}`); continue; }
    for (const p of parts.slice(1)) {
      const om = p.match(/^offset\s*=\s*(-?[\d.]+)$/i);
      if (om) e.offset = parseFloat(om[1]);
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
  const dur = Number((html.match(/"lengthSeconds":"(\d+)"/) || [])[1]) || 0;
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
  const r = await get('https://lrclib.net/api/search?' + q);
  if (!r.ok) throw new Error('LRCLIB HTTP ' + r.status);
  const list = (await r.json()).filter((x) => x.syncedLyrics);
  if (!list.length) return null;
  list.sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
  const best = list[0];
  return { lines: parseLrc(best.syncedLyrics), note: `${best.artistName} - ${best.trackName} (${Math.round(best.duration)}s)` };
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
    const ids = await searchYouTube(e.search);
    if (!ids.length) throw new Error('YouTube検索で見つかりません。URLを直接書いてください');
    id = ids[0];
    log(`   → ${id} (候補: ${ids.join(', ')})`);
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
  const { artist, title } = cleanMeta(meta.title, meta.author, e.expect);
  if (e.expect && meta.title) {
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
  const song = { id, yt: id, title, artist, dur: dur || Math.ceil(lines[lines.length - 1].e + 5), source, offset: e.offset, lines };
  fs.writeFileSync(out, JSON.stringify(song));
  log(`   ✅ 保存 ${out.replace(ROOT + '/', '')}  総語数${words}  ブランク候補(小5/小6/中1/中2/中3)=${counts.join('/')}`);
}

function rebuildIndex() {
  const idx = [];
  for (const f of fs.readdirSync(SONGS)) {
    if (!f.endsWith('.json') || f === 'index.json' || f === 'demo.json') continue;
    const s = JSON.parse(fs.readFileSync(path.join(SONGS, f), 'utf8'));
    const counts = [0, 1, 2, 3, 4].map((lv) => s.lines.reduce((n, l) => n + l.w.filter((w) => w[3] <= lv && w[1].length >= 3 && !w[5]).length, 0));
    idx.push({ id: s.id, yt: s.yt, title: s.title, artist: s.artist, dur: s.dur, counts, mtime: fs.statSync(path.join(SONGS, f)).mtimeMs });
  }
  // songs.txt の並び順に表示
  const order = parseSongsTxt(true).map((e) => e.id).filter(Boolean);
  idx.sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999) || a.mtime - b.mtime);
  idx.forEach((x) => delete x.mtime);
  fs.writeFileSync(path.join(SONGS, 'index.json'), JSON.stringify(idx));
  log(`\n📚 songs/index.json  ${idx.length}曲`);
}

// ---------- main ----------
fs.mkdirSync(path.join(SONGS, 'src'), { recursive: true });
let entries = parseSongsTxt();
if (ONLY) entries = entries.filter((e) => e.id === ONLY);
for (const e of entries) {
  try { await processOne(e); } catch (err) { errors.push(`${e.raw}\n     → ${err.message}`); log('   ❌ ' + err.message); }
}
rebuildIndex();
if (errors.length) {
  log('\n⚠️  うまくいかなかった曲:\n' + errors.map((x) => ' - ' + x).join('\n'));
  fs.writeFileSync(path.join(SONGS, 'REPORT.txt'), errors.join('\n') + '\n');
} else if (fs.existsSync(path.join(SONGS, 'REPORT.txt'))) fs.rmSync(path.join(SONGS, 'REPORT.txt'));
