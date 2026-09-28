/**
 * status.js (WP6): Datenlage, citations (spec 1.5, 7). Pure helpers; strings come from the page i18n passed in.
 * Round 3 fixes: the „Noch offen“ row is gone (the Datenlage dots say what exists; „offen“ is a retired status word).
 * Round 3 (D23, Tom's decision): the status of how a number was matched to its race (chips, reasons, per-field
 * marks, source confidence) is retired. The data may keep bib.ident and the conf fields; nothing here reads or
 * renders them.
 */

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DL = ['result', 'date', 'power', 'weather', 'photos'];

export function datenlage(race, photos) {
  const c = (race && race.completeness) || {};
  const out = {};
  for (const k of DL) out[k] = Boolean(race && c[k]);
  if (race && photos) out.photos = photos.length > 0;
  return out;
}

export function dlHTML(dl, i18n) {
  const have = DL.filter((k) => dl[k]);
  const open = DL.filter((k) => !dl[k]);
  const name = (k) => i18n.t(`dl.${k}`);
  const label = `${i18n.t('dl.aria', { have: have.length })}.` + (have.length ? ` ${i18n.t('dl.have')}: ${have.map(name).join(', ')}.` : '')
    + (open.length ? ` ${i18n.t('d.missing')}: ${open.map(name).join(', ')}.` : '');
  const dots = DL.map((k) => `<i${dl[k] ? ' data-on' : ''} title="${esc(`${name(k)}: ${i18n.t(dl[k] ? 'dl.on' : 'dl.off')}`)}"></i>`).join('');
  return `<span class="rs-dl" role="img" aria-label="${esc(label)}"><span class="rs-dl__k" aria-hidden="true">${esc(i18n.t('dl.title'))}</span><span class="rs-dl__dots" aria-hidden="true">${dots}</span></span>`;
}

/** D4: a photo may ship when the rights are mine or licensed and nobody in it needs a decision. */
export const cleared = (p) => Boolean(p && ['own', 'licensed'].includes(p.rights) && ['none', 'tom', 'others_ok', undefined].includes(p.people) && p.ships !== false);

export const srcKind = (k) => (k === 'web' ? 'web' : k === 'photo' ? 'photo' : 'local');

/**
 * Citations of one render: ref(ids) numbers sources by first use; html(ids) is ONE button per group ("3, 4", "2–4, 8")
 * that jumps to the first in "Quellen" (named "Quellen 2 bis 4, 8"). Unknown ids are dropped.
 */
export function createCites(getSource, i18n) {
  const order = [];
  const nums = new Map();
  const ref = (ids) => {
    const list = [];
    for (const id of Array.isArray(ids) ? ids : ids ? [ids] : []) {
      const s = getSource(id);
      if (!s) continue;
      if (!nums.has(id)) { order.push(id); nums.set(id, order.length); }
      if (!list.includes(nums.get(id))) list.push(nums.get(id));
    }
    return list;
  };
  const html = (ids) => {
    const list = ref(ids).sort((a, b) => a - b);
    if (!list.length) return '';
    const runs = [];
    for (const n of list) {
      const r = runs[runs.length - 1];
      if (r && n === r[1] + 1) r[1] = n; else runs.push([n, n]);
    }
    const to = `<span aria-hidden="true">–</span><span class="rs-sr"> ${esc(i18n.t('d.cite.to'))} </span>`;
    const parts = [];
    for (const [a, b] of runs) {
      if (b - a >= 2) parts.push(`${a}${to}${b}`);
      else for (let n = a; n <= b; n += 1) parts.push(String(n));
    }
    const one = list.length === 1;
    const s = one ? getSource(order[list[0] - 1]) : null;
    const lead = `<span class="rs-sr">${esc(i18n.t(one ? 'd.cite.one' : 'd.cite.many'))} </span>`;
    const label = s && i18n.L(s.label) ? `<span class="rs-sr">: ${esc(i18n.L(s.label))}</span>` : '';
    return `<span class="rs-cite"><button type="button" class="rs-cite__n" data-cite="${list[0]}" data-cites="${list.join(' ')}">${lead}${parts.join(', ')}${label}</button></span>`;
  };
  return { ref, html, has: (ids) => ref(ids).length > 0, list: () => order.slice(), n: (id) => nums.get(id) || 0 };
}

/** My own row in result, winner and podium lists (rendered as "Ich" / "Me", never with the racing name). */
const SELF = new RegExp(['bon', 'ten', 'ack', 'el'].join(''), 'i');
export function isMe(p) {
  if (!p) return false;
  if (p.me === true || p.self === true || p.isMe === true) return true;
  return SELF.test(String(p.name || ''));
}
