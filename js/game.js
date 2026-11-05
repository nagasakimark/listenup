// プレイ画面のゲーム本体。
// 流れ: 曲が流れる → つぎのブランクの「歌われるころ」までに 入力できればそのまま進む /
//       まにあわなければ 曲が自動で止まり、正解した瞬間に自動で再開(送信ボタンなし)。
import { createYouTubePlayer, createClockPlayer, freshMount } from './player.js';
import { burst } from './fx.js';

const $ = (id) => document.getElementById(id);
const FRAC = { easy: 0.4, normal: 0.6, hard: 1 };
const GAP = { easy: 9, normal: 6 };   // ブランクどうしの最小のあき(秒)
const FALLBACK = ['love', 'friend', 'happy', 'dream', 'music', 'light', 'night', 'time', 'heart', 'smile', 'world', 'sing'];
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

export class Game {
  /** opt = { level, diff:'easy'|'normal'|'hard', mode:'choice'|'type' }, hooks = { onEnd(result), onQuit() } */
  constructor(song, opt, hooks) {
    this.song = song; this.opt = opt; this.hooks = hooks;
    this.score = 0; this.combo = 0; this.bestCombo = 0;
    this.state = 'loading';          // loading | playing | waiting | ended
    this.gate = true;                // 曲がほんとうに流れはじめる(広告がおわる)まで、ゲームを止めておく
    this.gateSince = 0; this.badSince = 0; this.samp = []; this.t0 = performance.now(); this.knownDur = 0; this.why = '';
    this.userPaused = false; this.slow = false; this.activeLine = -1; this.replays = 0;
    this.nudge = parseFloat(localStorage.getItem('lu.sync.' + song.id) || '0') || 0;
    this.build();
  }

  get shift() { return (this.song.offset || 0) + this.nudge; }

  // ---------- ブランクをえらぶ ----------
  build() {
    const { level, diff } = this.opt;
    this.lines = this.song.lines.map((l) => ({ ...l, tok: l.w }));
    const pool = [];
    this.lines.forEach((l, li) => l.tok.forEach((t, ti) => {
      const ok = t[3] <= level && /^[A-Za-z]{3,}$/.test(t[1]) && (diff === 'hard' || !t[5]);
      if (ok) pool.push([li, ti]);
    }));
    const want = Math.min(pool.length, Math.max(diff === 'easy' ? 7 : 5, Math.round(pool.length * FRAC[diff])));
    const perWord = diff === 'hard' ? 99 : 2;
    let picked = [];
    if (diff === 'hard') {
      // むずかしい: ぜんぶ ブランク(間かくなし)
      const cLine = {}, cWord = {};
      for (const [li, ti] of shuffle(pool.slice())) {
        if (picked.length >= want) break;
        const w = this.lines[li].tok[ti][1].toLowerCase();
        if ((cWord[w] || 0) >= perWord) continue;
        cLine[li] = (cLine[li] || 0) + 1; cWord[w] = (cWord[w] || 0) + 1; picked.push([li, ti]);
      }
    } else {
      // かんたん/ふつう: ブランクとブランクの間に「歌を聞く時間」をあける(歌いはじめの時刻で、かんたん9秒・ふつう6秒以上)
      const cand = pool.map(([li, ti]) => ({ li, ti, t: this.estimate(this.lines[li], ti), w: this.lines[li].tok[ti][1].toLowerCase() })).sort((x, y) => x.t - y.t);
      for (let gap = GAP[diff]; gap >= 1; gap *= 0.7) {
        picked = []; const cWord = {}; let last = -1e9;
        for (;;) {
          const ok = cand.filter((c) => c.t >= last + gap && (cWord[c.w] || 0) < perWord);
          if (!ok.length) break;
          const win = ok.filter((c) => c.t <= ok[0].t + gap * 0.8);       // 少し先までの候補からランダムに1つ(いつも同じ場所にならないように)
          const c = win[(Math.random() * win.length) | 0];
          picked.push([c.li, c.ti]); cWord[c.w] = (cWord[c.w] || 0) + 1; last = c.t;
        }
        if (picked.length >= Math.min(4, pool.length)) break;                // 少なすぎるときだけ間かくをせまくする
      }
      while (picked.length > want) picked.splice((Math.random() * picked.length) | 0, 1);   // 多すぎるときは間引く(間かくは広がるだけ)
    }
    picked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.blanks = picked.map(([li, ti], i) => {
      const t = this.lines[li].tok[ti];
      return { i, li, ti, ans: t[1].toLowerCase(), disp: t[1], ja: t[4] || '', time: this.estimate(this.lines[li], ti), extra: 0, typed: '', mistakes: 0, hints: 0, jaShown: diff === 'easy', wrongChoices: new Set(), status: 'pending', revealedFirst: false };
    });
    this.byPos = new Map(this.blanks.map((b) => [b.li + ':' + b.ti, b]));
    // えらぶモード用のにせの選択肢
    const words = new Set();
    this.lines.forEach((l) => l.tok.forEach((t) => { if (/^[A-Za-z]{3,}$/.test(t[1])) words.add(t[1].toLowerCase()); }));
    this.wordPool = [...words];
    this.total = this.blanks.length;
    this.stats = { perfect: 0, fixed: 0, helped: 0, skipped: 0 };
  }

  /** 行の中で、その単語が歌い終わる時刻を文字数の割合で見積もる */
  estimate(line, ti) {
    const len = (t) => (t[0] + t[1] + t[2]).length + 1;
    const total = line.tok.reduce((n, t) => n + len(t), 0);
    const upto = line.tok.slice(0, ti + 1).reduce((n, t) => n + len(t), 0);
    const span = Math.max(1, Math.min(line.e - line.t, total / 13));
    return line.t + span * (upto / total) - 0.05;
  }

  get cursor() { return this.blanks.find((b) => b.status === 'pending') || null; }

  // ---------- 描画 ----------
  renderLines() {
    const frag = this.lines.map((l, li) => {
      const parts = l.tok.map((t, ti) => {
        const b = this.byPos.get(li + ':' + ti);
        if (!b) return `<span class="w">${esc(t[0] + t[1] + t[2])}</span>`;
        const chars = [...b.ans].map(() => '<i class="ch">&nbsp;</i>').join('');
        return `<span class="w">${esc(t[0])}<span class="blank" id="b${b.i}" data-i="${b.i}">${chars}</span>${esc(t[2])}</span>`;
      });
      return `<div class="line" id="l${li}">${parts.join(' ')}</div>`;
    });
    $('lines').innerHTML = frag.join('');
    this.lineEls = this.lines.map((_, i) => $('l' + i));
  }

  paintBlank(b) {
    const el = $('b' + b.i); if (!el) return;
    const chs = el.children;
    [...b.ans].forEach((c, k) => {
      const done = b.status !== 'pending';
      chs[k].className = 'ch' + (k < b.typed.length ? (b.hintIdx?.has(k) ? ' h' : ' f') : '');
      chs[k].textContent = done || k < b.typed.length ? b.disp[k] : ' ';
    });
    el.classList.toggle('ok', b.status === 'ok');
    el.classList.toggle('skip', b.status === 'skip');
    el.classList.toggle('active', b === this.cursor);
  }

  paintAll() { this.blanks.forEach((b) => this.paintBlank(b)); this.paintAnswer(); }

  paintAnswer() {
    const b = this.cursor, box = $('answer');
    if (!b) { box.innerHTML = '<span class="ans-tip">🎵 さいごまで きこう！</span>'; return; }
    const ja = b.jaShown && b.ja ? `<span class="ans-ja">いみ: ${esc(b.ja)}</span>` : '';
    if (this.opt.mode === 'choice') {
      if (b.choices?.length !== 4) b.choices = this.makeChoices(b);
      box.innerHTML = ja + b.choices.map((c, k) => `<button class="choice${b.wrongChoices.has(c) ? ' bad' : ''}" data-w="${c}"><kbd>${k + 1}</kbd>${c}</button>`).join('');
    } else {
      box.innerHTML = ja + `<span class="ans-tip">⌨️ キーボードで うってね（${b.ans.length}もじ）</span>`;
    }
  }

  makeChoices(b) {
    const near = this.wordPool.filter((w) => w !== b.ans && Math.abs(w.length - b.ans.length) <= 2);
    const far = this.wordPool.filter((w) => w !== b.ans && !near.includes(w));
    let others = shuffle(near).slice(0, 3);
    if (others.length < 3) others = others.concat(shuffle(far)).slice(0, 3);
    for (const f of shuffle(FALLBACK.slice())) { if (others.length >= 3) break; if (f !== b.ans && !others.includes(f)) others.push(f); }
    return shuffle([b.ans, ...others]);
  }

  centerLine(idx) {
    const el = this.lineEls[Math.max(0, idx)]; if (!el) return;
    const box = $('lyrics');
    const ty = box.clientHeight * 0.42 - (el.offsetTop + el.offsetHeight / 2);
    $('lines').style.transform = `translateY(${Math.min(box.clientHeight * 0.3, ty)}px)`;
  }

  setActiveLine(idx) {
    if (idx === this.activeLine) return;
    this.activeLine = idx;
    this.lineEls.forEach((el, i) => { el.classList.toggle('cur', i === idx); el.classList.toggle('near', Math.abs(i - idx) === 1); });
    this.centerLine(idx);
  }

  // ---------- 開始・ループ ----------
  async start() {
    $('p-title').textContent = this.song.title; $('p-artist').textContent = this.song.artist;
    $('p-score').textContent = '0'; $('p-combo').textContent = ''; $('p-bar').style.width = '0';
    $('video-msg').hidden = true; $('tap-start').hidden = true; $('sync-pop').hidden = true;
    $('sync-val').textContent = this.nudge.toFixed(1);
    $('video-box').classList.toggle('demo', !this.song.yt);
    $('t-pause').classList.remove('on'); $('t-slow').classList.remove('on');
    this.renderLines(); this.paintAll();
    this.setActiveLine(0);
    const h = {
      onEnded: () => this.finish(),
      onError: (m) => this.videoError(m),
      onState: (playing, raw) => { this.isPlaying = playing; this.rawState = raw; },
    };
    try {
      this.startAt = Math.max(0, (this.song.lines[0]?.t || 0) + this.shift - 4);
      if (this.song.yt) this.player = await createYouTubePlayer($('video-box'), this.song.yt, h, this.startAt);
      else { this.player = createClockPlayer($('video-box'), this.song.dur, h); $('yt').textContent = '🎵'; }
    } catch (e) { this.videoError(e.message); return; }
    if (this.dead) { this.player.destroy(); return; }
    this.state = 'playing';
    this.setGate(true);
    if (!this.song.yt) this.player.seek(this.startAt);
    this.player.play();
    if (/[?&]debug/.test(location.search)) {
      const d = document.createElement('pre'); d.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:99;background:#000c;color:#0f0;font:11px monospace;padding:4px;margin:0;pointer-events:none;max-width:60vw';
      document.body.appendChild(d); this.dbgEl = d;
      this.dbg = (s) => { const p = this.player; d.textContent = `gate=${this.gate} songState=${s} (${this.why}) state=${this.state}/${this.rawState}\nplaying=${this.isPlaying} t=${p.time().toFixed(1)} dur=${p.duration()} exp=${this.song.lrcDur || this.song.dur}\nid=${p.videoId && p.videoId()} adState=${p.adState && p.adState()} known=${this.knownDur}\n${(this.events || []).join('\n')}`; };
    }
    this.loop = setInterval(() => this.tick(), 60);
    setTimeout(() => { if (!this.dead && !this.isPlaying && this.state === 'playing' && !this.userPaused) $('tap-start').hidden = false; }, 3000);
    this.focusInput();
  }

  videoError(msg) {
    $('video-msg').hidden = false; $('video-msg').innerHTML = `<div>⚠️ ${esc(msg)}<br><small>✕ で もどって ほかの きょくを えらんでね</small></div>`;
    this.state = 'error';
  }

  tick() {
    if (this.dead || !this.player || this.state === 'ended' || this.state === 'error') return;
    if (this.checkGate()) return;
    const t = this.player.time() - this.shift;
    // 今の行
    let idx = -1;
    for (let i = 0; i < this.lines.length; i++) { if (this.lines[i].t - 0.2 <= t) idx = i; else break; }
    const b = this.cursor;
    if (this.state === 'waiting' && b) idx = b.li;
    this.setActiveLine(Math.max(idx, 0));
    const d = (this.player.duration && this.player.duration()) || this.song.dur || 1;
    $('p-bar').style.width = Math.min(100, (this.player.time() / d) * 100) + '%';
    if (this.isPlaying && !$('tap-start').hidden) $('tap-start').hidden = true;
    if (this.state === 'playing' && b && t >= b.time + b.extra) {
      this.player.pause(); this.state = 'waiting';
    }
    // 歌詞のおわり
    const lastEnd = this.lines[this.lines.length - 1].e;
    if (!b && t > lastEnd + 2.5) this.finish();
  }

  // ---------- こうこく待ち ----------
  /**
   * 広告かどうか。YouTubeに公式の合図がなく、広告中でも「曲の長さ・ID」を返すことがあるので、
   * いちばん確かな「曲の時計が、ほんとうに現実の時間どおりに進んでいるか」を主に見る。
   * 戻り値: true=曲が流れている / false=広告(または止まっている) / null=まだ判断できない
   */
  songState() {
    if (this.player.kind !== 'youtube') return true;
    const p = this.player, now = performance.now(), t = p.time();
    if (p.adState && p.adState() === 1) { this.why = 'adState'; return false; }          // 内部APIが広告と答えた
    const id = p.videoId && p.videoId();
    if (id && id !== this.song.yt) { this.why = 'id'; return false; }
    const d = p.duration(), exp = this.song.lrcDur || this.song.dur || 0;
    if (this.knownDur) { if (d > 0 && Math.abs(d - this.knownDur) > 3) { this.why = 'dur!=known'; return false; } }       // 曲が始まったときに覚えた本当の長さ
    else if (d > 0 && exp && d <= 90 && d < exp * 0.6) { this.why = 'dur short'; return false; }                        // 広告は短い
    // 時計が進んでいるか(ブランク待ちなどで曲を止めているときは調べない)
    if (!this.isPlaying) { this.samp = []; this.why = 'not playing'; return this.rawState === 3 ? null : (this.gate ? false : null); }
    this.samp.push({ t, w: now });
    while (this.samp.length > 2 && now - this.samp[1].w >= 1100) this.samp.shift();
    const o = this.samp[0];
    if (now - o.w < 1000) { this.why = 'measuring'; return null; }
    const dt = t - o.t, dw = ((now - o.w) / 1000) * (this.slow ? 0.75 : 1);
    if (!(dt > Math.max(0.5, dw * 0.6) && dt < dw * 1.6 + 0.3)) { this.why = 'clock stopped'; return false; }
    // 曲の頭だし位置(start)よりずっと手前なら、まだ広告の時間を見ている
    if (this.gate && this.startAt >= 5 && t < this.startAt - 1.5) { this.why = 'before start'; return false; }
    this.why = 'ok'; return true;
  }
  log(m) { (this.events = this.events || []).push(((performance.now() - this.t0) / 1000).toFixed(1) + 's ' + m); this.events = this.events.slice(-6); }
  setGate(on) {
    this.gate = on; this.gateSince = performance.now(); this.samp = [];
    $('gate').hidden = !on; $('gate-force').hidden = true;
    $('video-box').classList.toggle('gated', on); $('s-play').classList.toggle('gating', on);
  }
  /** @returns {boolean} true なら、このtickではゲームを進めない */
  checkGate() {
    const s = this.songState();
    if (this.dbg) this.dbg(s);
    const running = this.state === 'playing' && !this.userPaused;
    if (this.gate) {
      if (s === true) {
        const d = this.player.duration(); if (d > 0) this.knownDur = d;
        this.setGate(false); this.log('song start');
        return false;
      }
      if (performance.now() - this.gateSince > 12000) $('gate-force').hidden = false;   // 見分けに失敗したときの保険
      return true;
    }
    // ゲーム中に広告(途中広告)が入ったら、また止める。曲を止めているとき(ブランク待ち・一時停止)は調べない
    if (this.player.kind === 'youtube' && running && s === false) {
      this.badSince = this.badSince || performance.now();
      const adNow = this.player.adState && this.player.adState() === 1;
      if (adNow || performance.now() - this.badSince > 3000) { this.badSince = 0; this.setGate(true); this.log('ad detected: ' + this.why); return true; }
    } else { this.badSince = 0; if (!running) this.samp = []; }
    return false;
  }
  forceStart() { if (this.gate) { this.setGate(false); if (!this.userPaused && this.state === 'playing') this.player.play(); } }

  // ---------- 入力 ----------
  focusInput() { if (this.opt.mode === 'type') $('kbd').focus({ preventScroll: true }); }

  typeChar(ch) {
    if (this.gate) return;
    const b = this.cursor; if (!b || this.opt.mode !== 'type' || this.dead) return;
    ch = ch.toLowerCase(); if (!/^[a-z]$/.test(ch)) return;
    const exp = b.ans[b.typed.length];
    if (ch === exp) { b.typed += ch; this.paintBlank(b); if (b.typed.length === b.ans.length) this.complete(b, b.mistakes || b.hints ? 'fixed' : 'perfect'); }
    else this.wrong(b);
  }

  wrong(b, choice) {
    if (this.gate) return;
    b.mistakes++; this.combo = 0; this.updateHud();
    const el = $('b' + b.i);
    if (choice) { b.wrongChoices.add(choice); this.paintAnswer(); if (b.mistakes >= 2) { b.hints++; this.complete(b, 'helped'); return; } }
    else if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
    if (!choice && b.mistakes % 3 === 0) this.revealLetter(b);   // まちがいが3回で1もじヒント
    if (!b.jaShown && b.ja && b.mistakes >= 1) { b.jaShown = true; this.paintAnswer(); }
  }

  revealLetter(b) {
    if (b.typed.length >= b.ans.length) return;
    b.hintIdx = b.hintIdx || new Set(); b.hintIdx.add(b.typed.length);
    b.typed += b.ans[b.typed.length]; b.hints++;
    this.paintBlank(b);
    if (b.typed.length === b.ans.length) this.complete(b, 'helped');
  }

  choose(word) {
    if (this.gate) return;
    const b = this.cursor; if (!b || this.opt.mode !== 'choice' || this.state === 'ended') return;
    if (word === b.ans) {
      const btn = [...$('answer').querySelectorAll('.choice')].find((x) => x.dataset.w === word); if (btn) btn.classList.add('good');
      b.typed = b.ans; this.complete(b, b.mistakes || b.hints ? 'fixed' : 'perfect');
    } else this.wrong(b, word);
  }

  chooseIndex(k) { const b = this.cursor; if (b?.choices?.[k]) this.choose(b.choices[k]); }

  hint() {
    if (this.gate) return;
    const b = this.cursor; if (!b) return;
    if (!b.jaShown && b.ja) { b.jaShown = true; this.paintAnswer(); return; }
    b.hints++;
    if (this.opt.mode === 'type') this.revealLetter(b);
    else { const bad = b.choices.find((c) => c !== b.ans && !b.wrongChoices.has(c)); if (bad) { b.wrongChoices.add(bad); this.paintAnswer(); } }
  }

  skip() {
    if (this.gate) return; const b = this.cursor; if (!b) return; b.typed = b.ans; this.complete(b, 'skip'); }

  complete(b, how) {
    b.status = how === 'skip' ? 'skip' : 'ok';
    let pts = 0;
    if (how === 'perfect') { this.combo++; this.bestCombo = Math.max(this.bestCombo, this.combo); pts = 100 + Math.min(this.combo, 10) * 10; this.stats.perfect++; }
    else if (how === 'fixed') { pts = 50; this.stats.fixed++; }
    else if (how === 'helped') { pts = 20; this.stats.helped++; b.missed = true; this.combo = 0; }
    else { this.stats.skipped++; b.missed = true; this.combo = 0; }
    this.score += pts;
    b.how = how;
    this.paintBlank(b);
    const el = $('b' + b.i);
    if (el && how !== 'skip') { const r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, how === 'perfect' ? '#35e6a0' : '#ffb020', how === 'perfect' ? 22 : 10); }
    this.updateHud(how === 'perfect');
    this.paintAll();
    if (this.state === 'waiting') { this.state = 'playing'; if (!this.userPaused) this.player.play(); }
    this.focusInput();
  }

  updateHud(pop) {
    $('p-score').textContent = this.score;
    const c = $('p-combo');
    c.textContent = this.combo >= 2 ? `🔥 ${this.combo} COMBO` : '';
    if (pop && this.combo >= 2) { c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
  }

  // ---------- そうさ ----------
  replay() {
    if (this.gate) return;
    if (this.state === 'ended' || this.state === 'error') return;
    const b = this.cursor;
    const li = this.state === 'waiting' && b ? b.li : Math.max(0, this.activeLine);
    if (b) b.extra = Math.min(2.4, b.extra + 0.4);   // 聞きなおすたびに、止まる位置を少しあとにずらす
    this.player.seek(this.lines[li].t + this.shift - 0.5);
    this.state = 'playing'; this.userPaused = false; $('t-pause').classList.remove('on');
    this.player.play(); this.focusInput();
  }
  togglePause() {
    if (this.state === 'ended' || this.state === 'error') return;
    this.userPaused = !this.userPaused;
    $('t-pause').classList.toggle('on', this.userPaused);
    $('t-pause').firstChild.textContent = this.userPaused ? '▶' : '⏸';
    $('t-pause').querySelector('span').textContent = this.userPaused ? 'つづき' : 'とめる';
    if (this.userPaused) this.player.pause(); else if (this.state === 'playing') this.player.play();
  }
  toggleSlow() { this.slow = !this.slow; this.player.rate(this.slow ? 0.75 : 1); $('t-slow').classList.toggle('on', this.slow); }
  setNudge(d) {
    this.nudge = Math.round((this.nudge + d) * 10) / 10;
    localStorage.setItem('lu.sync.' + this.song.id, String(this.nudge));
    $('sync-val').textContent = this.nudge.toFixed(1);
  }
  hidden() { if (document.hidden && this.state === 'playing') { this.player?.pause(); this.userPaused = true; $('t-pause').classList.add('on'); } }

  // ---------- おわり ----------
  finish() {
    if (this.state === 'ended' || this.dead) return;
    this.state = 'ended'; clearInterval(this.loop); this.player?.pause();
    const s = this.stats, n = Math.max(1, this.total);
    const acc = (s.perfect + s.fixed * 0.5 + s.helped * 0.2) / n;
    const stars = this.total === 0 ? 3 : acc >= 0.8 ? 3 : acc >= 0.5 ? 2 : 1;
    const missed = this.blanks.filter((b) => b.missed).map((b) => ({ w: b.ans, ja: b.ja }));
    this.hooks.onEnd({ score: this.score, acc: Math.round(acc * 100), bestCombo: this.bestCombo, stars, missed, total: this.total });
  }

  destroy() { this.dead = true; this.state = 'ended'; clearInterval(this.loop); this.dbgEl?.remove(); try { this.player?.destroy(); } catch { /* */ } freshMount($('video-box')); }
}
