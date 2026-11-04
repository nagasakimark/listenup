// 再生アダプター: YouTube IFrame API と、音なしの「時計」プレイヤーを同じ形で使えるようにする。
// player = { time(), play(), pause(), seek(sec), rate(r), destroy(), kind }
// handlers = { onEnded(), onError(msg), onState(playing:boolean) }

let apiPromise = null;
export function loadYT() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('YouTubeを読みこめません')); };
    document.head.appendChild(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { apiPromise = null; reject(new Error('YouTubeを読みこめません')); } }, 12000);
  });
  return apiPromise;
}

/** #video-box の中の再生部分(#yt / iframe)だけを新しく作りなおす(メッセージ用の要素は残す) */
export function freshMount(box) {
  box.querySelectorAll('#yt, iframe').forEach((e) => e.remove());
  const d = document.createElement('div'); d.id = 'yt'; box.prepend(d);
  return d;
}

export async function createYouTubePlayer(box, videoId, h) {
  await loadYT();
  freshMount(box);
  return new Promise((resolve, reject) => {
    let ready = false;
    const p = new window.YT.Player('yt', {
      videoId,
      width: '100%', height: '100%',
      playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, cc_load_policy: 0, origin: location.origin },
      events: {
        onReady: () => {
          ready = true;
          resolve({
            kind: 'youtube',
            time: () => (p.getCurrentTime ? p.getCurrentTime() : 0),
            play: () => p.playVideo(),
            pause: () => p.pauseVideo(),
            seek: (s) => p.seekTo(Math.max(0, s), true),
            rate: (r) => p.setPlaybackRate(r),
            duration: () => { try { return p.getDuration(); } catch { return 0; } },
            videoId: () => { try { return p.getVideoData().video_id || ''; } catch { return ''; } },
            destroy: () => { try { p.destroy(); } catch { /* */ } },
          });
        },
        onStateChange: (e) => {
          const S = window.YT.PlayerState;
          if (e.data === S.ENDED) h.onEnded();
          h.onState(e.data === S.PLAYING);
        },
        onError: (e) => {
          const msg = e.data === 101 || e.data === 150 ? 'この動画は、持ち主の設定で ここでは 再生できません。' : 'この動画を 再生できませんでした。';
          if (!ready) reject(new Error(msg)); else h.onError(msg);
        },
      },
    });
  });
}

/** 音なしの時計プレイヤー(デモ曲・練習用) */
export function createClockPlayer(box, duration, h) {
  freshMount(box);
  let base = 0, startedAt = 0, playing = false, speed = 1, raf = null;
  const now = () => (playing ? base + ((performance.now() - startedAt) / 1000) * speed : base);
  const tick = () => { if (playing && now() >= duration) { playing = false; base = duration; h.onState(false); h.onEnded(); return; } raf = requestAnimationFrame(tick); };
  return {
    kind: 'clock',
    time: now,
    play() { if (!playing) { startedAt = performance.now(); playing = true; h.onState(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); } },
    pause() { if (playing) { base = now(); playing = false; h.onState(false); } },
    seek(s) { base = Math.max(0, s); startedAt = performance.now(); },
    rate(r) { base = now(); startedAt = performance.now(); speed = r; },
    duration: () => duration,
    destroy() { cancelAnimationFrame(raf); playing = false; },
  };
}
