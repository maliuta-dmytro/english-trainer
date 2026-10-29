// Легкі SVG-графіки без бібліотек. Специфікації: стовпчик ≤ 24px, заокруглений лише кінець даних (4px),
// 2px проміжок кольору поверхні між сегментами, сітка — тонкі суцільні лінії, підписи — текстовими кольорами.
import { esc } from './ui.js';

const PAD = { top: 12, right: 8, bottom: 26, left: 34 };
const GAP = 2;
const R = 4;

function niceMax(v) {
  if (v <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

// Прямокутник із заокругленим верхом (кінець даних) і прямим низом (базова лінія).
function topRounded(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// Спільна підказка, що слідує за курсором у межах контейнера.
function tooltip(el) {
  let tip = el.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    el.appendChild(tip);
  }
  return {
    show(html, evt) {
      tip.innerHTML = html;
      tip.style.opacity = '1';
      const box = el.getBoundingClientRect();
      const x = evt.clientX - box.left;
      const y = evt.clientY - box.top;
      const w = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(box.width - w, x - w / 2))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 14)}px`;
    },
    hide() { tip.style.opacity = '0'; },
  };
}

function responsive(el, draw) {
  let last = 0;
  const run = () => {
    const w = Math.round(el.clientWidth);
    if (w && w !== last) { last = w; draw(w); }
  };
  run();
  new ResizeObserver(run).observe(el);
}

function axes(width, height, max, ticks = 4) {
  const innerH = height - PAD.top - PAD.bottom;
  let out = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = PAD.top + innerH - (v / max) * innerH;
    out += `<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${y}" y2="${y}" class="${i ? 'grid' : 'baseline'}"/>`;
    out += `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" class="tick">${Math.round(v)}</text>`;
  }
  return out;
}

/**
 * Стовпчики з накопиченням.
 * rows: [{label, ...values}], series: [{id, color, label}], tip(row) → html
 */
export function stackedColumns(el, { rows, series, tip, height = 220, ariaLabel }) {
  el.classList.add('chart');
  const t = tooltip(el);
  responsive(el, (width) => {
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const totals = rows.map((r) => series.reduce((s, x) => s + (r[x.id] || 0), 0));
    const max = niceMax(Math.max(...totals));
    const band = innerW / rows.length;
    const barW = Math.min(24, band * 0.62);
    const labelEvery = band < 26 ? 2 : 1;

    let marks = '';
    let hits = '';
    rows.forEach((r, i) => {
      const x = PAD.left + band * i + (band - barW) / 2;
      let y = PAD.top + innerH;
      const visible = series.filter((s) => (r[s.id] || 0) > 0);
      visible.forEach((s, k) => {
        const h = ((r[s.id] || 0) / max) * innerH;
        const top = k === visible.length - 1;
        const segH = Math.max(0, h - (k > 0 ? GAP : 0));
        const segY = y - h;
        marks += top
          ? `<path d="${topRounded(x, segY, barW, segH, R)}" fill="${s.color}"/>`
          : `<rect x="${x}" y="${segY}" width="${barW}" height="${segH}" fill="${s.color}"/>`;
        y -= h;
      });
      if ((rows.length - 1 - i) % labelEvery === 0) {
        marks += `<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle" class="tick${r.highlight ? ' strong' : ''}">${esc(r.label)}</text>`;
      }
      hits += `<rect class="hit" data-i="${i}" x="${PAD.left + band * i}" y="${PAD.top}" width="${band}" height="${innerH}"/>`;
    });

    el.querySelector('svg')?.remove();
    el.insertAdjacentHTML('afterbegin', `
      <svg width="${width}" height="${height}" role="img" aria-label="${esc(ariaLabel)}">
        ${axes(width, height, max)}${marks}${hits}
      </svg>`);
    el.querySelectorAll('.hit').forEach((h) => {
      h.addEventListener('pointermove', (e) => t.show(tip(rows[h.dataset.i]), e));
      h.addEventListener('pointerleave', () => t.hide());
    });
  });
}

/** Звичайні стовпчики одного ряду; значення підписані на верхівках. */
export function columns(el, { values, labels, color, tip, height = 180, ariaLabel }) {
  el.classList.add('chart');
  const t = tooltip(el);
  responsive(el, (width) => {
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom - 14;
    const max = niceMax(Math.max(...values));
    const band = innerW / values.length;
    const barW = Math.min(24, band * 0.62);
    const top0 = PAD.top + 14;
    let marks = '';
    let hits = '';
    values.forEach((v, i) => {
      const x = PAD.left + band * i + (band - barW) / 2;
      const h = (v / max) * innerH;
      if (v > 0) marks += `<path d="${topRounded(x, top0 + innerH - h, barW, h, R)}" fill="${color}"/>`;
      marks += `<text x="${x + barW / 2}" y="${top0 + innerH - h - 5}" text-anchor="middle" class="value">${v}</text>`;
      marks += `<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle" class="tick">${esc(labels[i])}</text>`;
      hits += `<rect class="hit" data-i="${i}" x="${PAD.left + band * i}" y="${top0}" width="${band}" height="${innerH}"/>`;
    });
    el.querySelector('svg')?.remove();
    el.insertAdjacentHTML('afterbegin', `
      <svg width="${width}" height="${height}" role="img" aria-label="${esc(ariaLabel)}">
        <line x1="${PAD.left}" x2="${width - PAD.right}" y1="${top0 + innerH}" y2="${top0 + innerH}" class="baseline"/>
        ${marks}${hits}
      </svg>`);
    el.querySelectorAll('.hit').forEach((h) => {
      h.addEventListener('pointermove', (e) => t.show(tip(h.dataset.i), e));
      h.addEventListener('pointerleave', () => t.hide());
    });
  });
}

/** Легенда: кольоровий маркер поруч із текстом (сам текст — текстовим кольором). */
export const legend = (series) => `<div class="legend">${series.map((s) =>
  `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
