// Плеєр фрагмента з однаковим інтерфейсом для файлу (audio/video) і YouTube (IFrame API).
// Тримає відтворення в межах [start, end]: дійшли до кінця — пауза.

export function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

let ytReady;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  ytReady ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('Не вдалося завантажити плеєр YouTube. Перевір інтернет.')); };
    document.head.appendChild(s);
  });
  return ytReady;
}

function withRange(core, { start, end, onTime }) {
  let timer = 0;
  let maxReached = start;
  const tick = () => {
    const t = core.time();
    if (t > maxReached) maxReached = t;
    if (t >= end - 0.05 && core.playing()) { core.pause(); core.seek(end); }
    onTime?.(t);
  };
  timer = setInterval(tick, 200);
  return {
    el: core.el,
    play() {
      const t = core.time();
      if (t < start || t >= end - 0.1) core.seek(start);
      core.play();
    },
    pause: () => core.pause(),
    toggle() { if (core.playing()) core.pause(); else this.play(); },
    back(sec = 5) { core.seek(Math.max(start, core.time() - sec)); },
    seek: (t) => core.seek(Math.min(end, Math.max(start, t))),
    playFrom(t) { core.seek(Math.max(start, t)); core.play(); },
    setRate: (r) => core.setRate(r),
    time: () => core.time(),
    playing: () => core.playing(),
    // Яку частку фрагмента вже прослухано (за найдальшою точкою).
    progress: () => Math.min(1, Math.max(0, (maxReached - start) / Math.max(1, end - start))),
    destroy() { clearInterval(timer); core.destroy(); },
  };
}

export function filePlayer(blob, { isVideo = false, ...range }) {
  const url = URL.createObjectURL(blob);
  const el = document.createElement(isVideo ? 'video' : 'audio');
  el.src = url;
  el.preload = 'auto';
  el.playsInline = true;
  el.preservesPitch = true;
  el.className = isVideo ? 'media' : 'media audio-only';
  el.currentTime = range.start;
  return withRange({
    el,
    play: () => el.play().catch(() => {}),
    pause: () => el.pause(),
    seek: (t) => { el.currentTime = t; },
    time: () => el.currentTime,
    playing: () => !el.paused,
    setRate: (r) => { el.playbackRate = r; },
    destroy: () => { el.pause(); URL.revokeObjectURL(url); },
  }, range);
}

// YouTube підтримує лише свої швидкості (0.25, 0.5, 0.75, 1, 1.25…) — беремо найближчу.
export async function youtubePlayer(videoId, range) {
  await loadYouTubeApi();
  const host = document.createElement('div');
  host.className = 'yt-wrap';
  const inner = document.createElement('div');
  host.appendChild(inner);
  document.body.appendChild(host); // IFrame API потребує елемент у DOM; потім view перенесе його
  const yt = await new Promise((resolve, reject) => {
    const p = new window.YT.Player(inner, {
      videoId,
      playerVars: { start: Math.floor(range.start), playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => resolve(p),
        onError: (e) => reject(new Error(e.data === 101 || e.data === 150
          ? 'Власник відео заборонив вбудовування. Обери інше відео.'
          : 'YouTube не зміг відтворити це відео.')),
      },
    });
  });
  return withRange({
    el: host,
    play: () => yt.playVideo(),
    pause: () => yt.pauseVideo(),
    seek: (t) => yt.seekTo(t, true),
    time: () => yt.getCurrentTime() || 0,
    playing: () => yt.getPlayerState() === window.YT.PlayerState.PLAYING,
    setRate: (r) => {
      const rates = yt.getAvailablePlaybackRates?.() || [1];
      yt.setPlaybackRate(rates.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), 1));
    },
    destroy: () => { yt.destroy(); host.remove(); },
  }, range);
}
