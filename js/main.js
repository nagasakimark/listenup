import { Game } from './game.js';
import { confetti } from './fx.js';

const $ = (id) => document.getElementById(id);
const LEVELS = [
  { short: '小5', full: '小学5年', sub: 'New Horizon 5', c: 'var(--lvl0)' },
  { short: '小6', full: '小学6年', sub: 'New Horizon 6', c: 'var(--lvl1)' },
  { short: '中1', full: '中学1年', sub: 'New Horizon 1', c: 'var(--lvl2)' },
  { short: '中2', full: '中学2年', sub: 'New Horizon 2', c: 'var(--lvl3)' },
  { short: '中3', full: '中学3年', sub: 'New Horizon 3', c: 'var(--lvl4)' },
];
const DIFFS = [['easy', 'かんたん', 'ブランク すくなめ'], ['normal', 'ふつう', 'ブランク ふつう'], ['hard', 'むずかしい', 'ぜんぶ ブランク']];
const MODES = [['choice', 'えらぶ', '4つから タップ'], ['type', 'タイピング', 'キーボードで入力']];

const store = {
  get: (k, d) => { try { const v = localStorage.getItem('lu.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('lu.' + k, JSON.stringify(v)); } catch { /* */ } },
};
const S = { level: store.get('level', null), diff: store.get('diff', 'normal'), mode: store.get('mode', null), songs: [], page: 0, song: null, game: null };

// ---------- 画面切りかえ ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
}

// ---------- 1. レベル ----------
function buildLevels() {
  $('levels').innerHTML = LEVELS.map((l, i) => `<button class="lv-btn" data-lv="${i}" style="background:${l.c}"><span>${i < 2 ? '小学校' : '中学校'}</span><b>${l.short.slice(1)}</b><span>年生</span><i>${l.sub}</i></button>`).join('');
  $('levels').onclick = (e) => {
    const b = e.target.closest('.lv-btn'); if (!b) return;
    S.level = +b.dataset.lv; store.set('level', S.level);
    if (store.get('mode', null) === null) S.mode = S.level <= 1 ? 'choice' : 'type';
    S.page = 0; goSongs();
  };
}
function paintLevelChips() {
  for (const id of ['btn-level', 'btn-level2']) {
    const b = $(id); if (S.level === null) continue;
    b.textContent = `${LEVELS[S.level].full} ▾`; b.style.background = LEVELS[S.level].c;
  }
}

// ---------- 2. 曲えらび ----------
async function loadSongs() {
  try { const r = await fetch('songs/index.json', { cache: 'no-cache' }); S.songs = r.ok ? await r.json() : []; } catch { S.songs = []; }
  if (location.hash === '#demo') S.songs.push({ id: 'demo', yt: null, title: 'デモ曲 (おんがくなし)', artist: 'Listen Up!', dur: 62, counts: [20, 20, 20, 20, 20] });
}
function goSongs() { paintLevelChips(); show('s-songs'); renderGrid(); }
function perPage() {
  const g = $('grid'); const w = g.clientWidth || innerWidth, h = g.clientHeight || innerHeight * 0.75;
  const cols = Math.max(2, Math.min(4, Math.floor(w / 270))), rows = Math.max(1, Math.min(3, Math.floor(h / 240)));
  g.style.setProperty('--cols', cols); g.style.setProperty('--rows', rows);
  return cols * rows;
}
function stars(id) { const b = store.get(`best.${id}.${S.level}`, null); return b ? '★'.repeat(b.stars) + '☆'.repeat(3 - b.stars) : ''; }
function renderGrid() {
  const empty = S.songs.length === 0;
  $('empty').hidden = !empty; $('grid').hidden = empty;
  $('btn-prev').hidden = $('btn-next').hidden = $('pager').hidden = empty;
  if (empty) return;
  const n = perPage(), pages = Math.max(1, Math.ceil(S.songs.length / n));
  S.page = Math.min(S.page, pages - 1);
  $('pager').textContent = `${S.page + 1} / ${pages}`;
  $('btn-prev').disabled = S.page === 0; $('btn-next').disabled = S.page >= pages - 1;
  $('btn-prev').style.opacity = S.page === 0 ? .3 : 1; $('btn-next').style.opacity = S.page >= pages - 1 ? .3 : 1;
  $('grid').innerHTML = S.songs.slice(S.page * n, S.page * n + n).map((s) => {
    const th = s.yt ? `https://i.ytimg.com/vi/${s.yt}/mqdefault.jpg` : '';
    const c = s.counts?.[S.level] ?? 0;
    return `<button class="card-song" data-id="${s.id}"><div class="th" style="${th ? `background-image:url(${th})` : 'background:linear-gradient(135deg,#5149c9,#14123a)'}"></div><div class="tx"><b>${s.title}</b><span>${s.artist}</span><em>${stars(s.id) || (c ? `ブランク ${c}こ〜` : 'ことばが すくない')}</em></div></button>`;
  }).join('');
}

// ---------- 3. 設定 ----------
function openSetup(id) {
  S.song = S.songs.find((s) => s.id === id); if (!S.song) return;
  const s = S.song;
  $('setup-img').src = s.yt ? `https://i.ytimg.com/vi/${s.yt}/mqdefault.jpg` : ''; $('setup-img').style.display = s.yt ? '' : 'none';
  $('setup-title').textContent = s.title; $('setup-artist').textContent = s.artist;
  paintLevelChips(); paintSetup(); show('s-setup');
}
function paintSetup() {
  const c = S.song.counts?.[S.level] ?? 0;
  $('setup-count').textContent = c < 4 ? `${LEVELS[S.level].full}で わかる ことばは すくなめの きょくです` : `${LEVELS[S.level].full}で ならう ことばが ${c}こ でてくるよ`;
  const seg = (id, items, cur, key) => {
    $(id).innerHTML = items.map(([v, l, sm]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${l}<small>${sm}</small></button>`).join('');
    $(id).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S[key] = b.dataset.v; store.set(key, S[key]); paintSetup(); };
  };
  seg('seg-diff', DIFFS, S.diff, 'diff'); seg('seg-mode', MODES, S.mode || 'choice', 'mode');
}

// ---------- 4. プレイ ----------
async function play() {
  const meta = S.song;
  S.mode = S.mode || 'choice';
  let song;
  try { const r = await fetch(`songs/${meta.id}.json`, { cache: 'no-cache' }); song = await r.json(); } catch { alert('きょくを よみこめませんでした'); return; }
  show('s-play');
  S.game?.destroy();
  const g = S.game = new Game(song, { level: S.level, diff: S.diff, mode: S.mode }, {
    onEnd: (r) => showResult(r),
  });
  document.querySelector('#s-play').dataset.mode = S.mode;
  await g.start();
}

function leavePlay(to) { $('pause').hidden = true; S.game?.destroy(); S.game = null; if (to === 'songs') goSongs(); }

// ---------- 5. けっか ----------
function showResult(r) {
  const key = `best.${S.song.id}.${S.level}`, prev = store.get(key, null);
  if (!prev || r.score > prev.score) store.set(key, { score: r.score, stars: r.stars });
  $('r-stars').innerHTML = [1, 2, 3].map((i) => `<span class="${i <= r.stars ? 'on' : 'off'}">★</span>`).join('');
  $('r-title').textContent = r.stars === 3 ? 'すばらしい！ ' + S.song.title : r.stars === 2 ? 'いいね！ ' + S.song.title : 'ナイストライ！ ' + S.song.title;
  $('r-score').textContent = r.score; $('r-acc').textContent = r.acc + '%'; $('r-combo').textContent = r.bestCombo;
  $('r-miss').innerHTML = r.missed.length ? '<div class="label">もういちど ききたい ことば</div>' + r.missed.slice(0, 10).map((m) => `<span class="m"><b>${m.w}</b>${m.ja ? `<small>${m.ja}</small>` : ''}</span>`).join('') : '<div class="label">ぜんぶ じぶんの 力で できたね！🎉</div>';
  show('s-result');
  if (r.stars >= 2) confetti();
}

// ---------- イベント ----------
function bind() {
  $('btn-level').onclick = $('btn-level2').onclick = () => show('s-level');
  $('btn-prev').onclick = () => { S.page--; renderGrid(); };
  $('btn-next').onclick = () => { S.page++; renderGrid(); };
  $('grid').onclick = (e) => { const c = e.target.closest('.card-song'); if (c) openSetup(c.dataset.id); };
  $('btn-setup-back').onclick = () => goSongs();
  $('btn-start').onclick = play;
  $('btn-demo').onclick = () => { location.hash = '#demo'; loadSongs().then(() => { S.song = S.songs.find((s) => s.id === 'demo'); renderGrid(); openSetup('demo'); }); };
  $('btn-quit').onclick = () => { $('pause').hidden = false; S.game?.player?.pause(); };
  $('pz-resume').onclick = () => { $('pause').hidden = true; const g = S.game; if (g && g.state !== 'waiting' && !g.userPaused) g.player.play(); g?.focusInput(); };
  $('pz-quit').onclick = () => leavePlay('songs');
  $('r-again').onclick = play;
  $('r-next').onclick = () => { S.game?.destroy(); S.game = null; goSongs(); };

  $('answer').onclick = (e) => { const b = e.target.closest('.choice'); if (b) S.game?.choose(b.dataset.w); else S.game?.focusInput(); };
  $('lyrics').onclick = () => S.game?.focusInput();
  $('t-replay').onclick = () => S.game?.replay();
  $('t-hint').onclick = () => S.game?.hint();
  $('t-skip').onclick = () => S.game?.skip();
  $('t-slow').onclick = () => S.game?.toggleSlow();
  $('t-pause').onclick = () => S.game?.togglePause();
  $('t-sync').onclick = () => { $('sync-pop').hidden = !$('sync-pop').hidden; };
  $('sync-minus').onclick = () => S.game?.setNudge(-0.5);
  $('sync-plus').onclick = () => S.game?.setNudge(0.5);
  $('tap-start').onclick = () => { $('tap-start').hidden = true; S.game?.player?.play(); S.game?.focusInput(); };

  // キーボード
  addEventListener('keydown', (e) => {
    const g = S.game; if (!g || !$('s-play').classList.contains('on') || !$('pause').hidden) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); g.replay(); }
    else if (e.key === 'Tab') { e.preventDefault(); g.skip(); }
    else if (e.key === ' ') { e.preventDefault(); g.togglePause(); }
    else if (e.key === 'Escape') { $('btn-quit').click(); }
    else if (/^[1-4]$/.test(e.key) && S.mode === 'choice') g.chooseIndex(+e.key - 1);
    else if (e.key.length === 1 && S.mode === 'type') { e.preventDefault(); g.typeChar(e.key); }
  });
  // IME(日本語入力)がオンでも英字を拾う
  $('kbd').addEventListener('input', (e) => {
    if (e.isComposing) return;
    for (const ch of $('kbd').value) S.game?.typeChar(ch);
    $('kbd').value = '';
  });
  $('kbd').addEventListener('compositionend', () => { for (const ch of $('kbd').value) S.game?.typeChar(ch); $('kbd').value = ''; });
  document.addEventListener('visibilitychange', () => S.game?.hidden());
  addEventListener('resize', () => { if ($('s-songs').classList.contains('on')) renderGrid(); if (S.game) S.game.centerLine(Math.max(0, S.game.activeLine)); });
}

window.__lu = S;
(async function init() {
  buildLevels(); bind();
  await loadSongs();
  if (S.level === null) show('s-level'); else goSongs();
  if (S.mode === null) S.mode = S.level !== null && S.level <= 1 ? 'choice' : 'type';
})();
