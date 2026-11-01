// Лінійні іконки для плашок показників (24×24, колір — currentColor).
const PATHS = {
  plane: '<path d="M10.5 13.5 3 11l1.5-1.5 7 1 4-4.5a2 2 0 0 1 3 3l-4.5 4 1 7L18.5 21 16 13.5"/><path d="m6 17-2 4 4-2"/>',
  flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-3 5-3 8a6 6 0 0 0 6 6z"/>',
  cards: '<rect x="6" y="3" width="14" height="16" rx="3"/><path d="M4 7v11a3 3 0 0 0 3 3h9"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  trend: '<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
};

export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;

// Плашка показника: іконка в колі, велике число, підпис.
export const statTile = (ico, num, label) =>
  `<div class="stat"><span class="ico">${icon(ico)}</span><div><div class="num">${num}</div><div class="label">${label}</div></div></div>`;
