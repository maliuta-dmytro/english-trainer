// YouTube Data API v3: канал за посиланням і список його відео.
// Ключ передається заголовком X-Goog-Api-Key (не в адресі запиту). Квота: ~1–3 одиниці на оновлення каналу.
import { getSetting } from './db.js';

const API = 'https://www.googleapis.com/youtube/v3';

export class YouTubeError extends Error {}

async function call(path, params) {
  const key = await getSetting('youtubeKey', '');
  if (!key) throw new YouTubeError('Додай ключ YouTube Data API у «⚙ Налаштуваннях».');
  let res;
  try {
    res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { 'X-Goog-Api-Key': key } });
  } catch {
    throw new YouTubeError('Немає з\'єднання з YouTube.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason || data.error?.status || '';
    if (/keyInvalid|API_KEY_INVALID/i.test(reason) || /API key not valid/i.test(data.error?.message || '')) {
      throw new YouTubeError('Ключ YouTube Data API не прийнято. Перевір його в «Налаштуваннях».');
    }
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used|is disabled/i.test(data.error?.message || '')) {
      throw new YouTubeError('YouTube Data API v3 не увімкнено для цього ключа. Увімкни його в Google Cloud Console (APIs & Services → Library).');
    }
    if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) throw new YouTubeError('Вичерпано денну квоту YouTube Data API. Спробуй завтра.');
    if (/referer|referrer/i.test(reason + (data.error?.message || ''))) {
      throw new YouTubeError('Ключ обмежено іншими адресами сайту. Додай адресу тренажера в обмеження ключа (HTTP referrers).');
    }
    throw new YouTubeError(`Помилка YouTube (${res.status}): ${data.error?.message || 'невідома помилка'}`);
  }
  return data;
}

// Посилання на канал → параметр для channels.list.
export function parseChannelInput(input) {
  const s = String(input).trim();
  let m = s.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || s.match(/^(UC[\w-]{22})$/);
  if (m) return { id: m[1] };
  m = s.match(/youtube\.com\/(@[\w.-]+)/) || s.match(/^(@[\w.-]+)$/);
  if (m) return { forHandle: m[1] };
  m = s.match(/youtube\.com\/(?:user|c)\/([\w.-]+)/);
  if (m) return { forUsername: m[1] };
  if (/^[\w.-]+$/.test(s)) return { forHandle: `@${s}` };
  return null;
}

const bestThumb = (t = {}) => (t.medium || t.high || t.default || {}).url || '';

export async function resolveChannel(input) {
  const q = parseChannelInput(input);
  if (!q) throw new YouTubeError('Не схоже на посилання на канал. Приклад: https://www.youtube.com/@TED');
  const data = await call('channels', { part: 'snippet,contentDetails', ...q });
  const ch = data.items?.[0];
  if (!ch) throw new YouTubeError('Канал не знайдено. Перевір посилання (найнадійніше — з @ у адресі).');
  return {
    id: ch.id,
    title: ch.snippet.title,
    handle: ch.snippet.customUrl || '',
    thumb: bestThumb(ch.snippet.thumbnails),
    uploads: ch.contentDetails.relatedPlaylists.uploads,
  };
}

// ISO 8601 (PT1H2M3S) → секунди.
export function parseDuration(iso) {
  const m = String(iso).match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

// Сторінка відео з плейлиста завантажень каналу (до 50), з тривалістю й наявністю субтитрів.
export async function listVideos(uploads, pageToken = '') {
  const page = await call('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
  const ids = (page.items || []).map((it) => it.contentDetails.videoId);
  if (!ids.length) return { videos: [], next: null };
  const details = await call('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') });
  const videos = (details.items || [])
    .filter((v) => v.snippet.liveBroadcastContent === 'none' && v.status?.embeddable !== false)
    .map((v) => ({
      id: v.id,
      title: v.snippet.title,
      published: v.snippet.publishedAt,
      thumb: bestThumb(v.snippet.thumbnails),
      duration: parseDuration(v.contentDetails.duration),
      captions: v.contentDetails.caption === 'true',
    }))
    .sort((a, b) => b.published.localeCompare(a.published));
  return { videos, next: page.nextPageToken || null };
}

export const fmtDuration = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
