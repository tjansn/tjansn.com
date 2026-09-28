/**
 * fallback-sheet.js (WP3): the minimal dossier sheet. main.js imports it only when dossier/dossier.js (WP6) is
 * missing or its createDossier() fails, so every race and number still opens: title, date, result, team, sources,
 * prev/next and close, keyboard arrows, Esc. Until round 2 it sat inside main.js and was fetched on every visit
 * (3.3 KB gzip of the JS at interactive, spec 8.1) although a working page never shows it.
 *
 *   createFallbackDossier(dialog, { data, i18n, bus })
 *     -> { open(tgt), close(reason), switch(dir), isOpen(), current(), fallback: true }
 *   Emits dossier:opened, dossier:switch and dossier:closed like the real dossier (spec 3.8).
 */
const doc = document;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FALLBACK_CSS = ".rs-dossier[data-rs-fallback]{width:min(46rem,calc(100vw - 2rem));max-height:calc(100svh - var(--rs-header-h) - 2rem);margin:calc(var(--rs-header-h) + 1rem) auto auto;padding:0;border:1px solid var(--rs-rule);border-radius:var(--gl-radius-md);background:var(--rs-sheet);color:var(--rs-ink);overflow:auto}.rs-dossier[data-rs-fallback]::backdrop{background:rgba(5,6,7,0.55)}.rs-fb{display:grid;gap:var(--gl-space-4);padding:clamp(1.25rem,3vw,2rem)}.rs-fb__top{display:flex;align-items:center;justify-content:space-between;gap:var(--gl-space-3)}.rs-fb__k{font:500 0.72rem/1.3 var(--gl-font-mono);letter-spacing:0.06em;text-transform:uppercase;color:var(--rs-muted)}.rs-fb h2{color:var(--rs-ink);font-size:clamp(1.6rem,3vw,2.2rem);letter-spacing:-0.025em;line-height:1.08}.rs-fb h2:focus{outline:none}.rs-fb p,.rs-fb li{color:var(--rs-muted);line-height:1.55;font-feature-settings:var(--rs-prose-features)}.rs-fb__res{font-weight:800;font-size:clamp(2.4rem,5vw,3.4rem);line-height:1;letter-spacing:-0.04em;color:var(--rs-ink);font-feature-settings:\"tnum\"}.rs-fb__status{display:inline-flex;align-items:center;gap:0.45rem;font:500 0.75rem/1.3 var(--gl-font-mono);color:var(--rs-ink)}.rs-fb__status i{width:0.55rem;height:0.55rem;border-radius:50%;border:1.5px solid currentColor}.rs-fb__status[data-status=\"confirmed\"] i{background:var(--rs-ok);border-color:var(--rs-ok)}.rs-fb__status[data-status=\"likely\"] i{background:var(--rs-maybe);border-color:var(--rs-maybe)}.rs-fb__status[data-status=\"printed\"] i{background:var(--rs-ink)}.rs-fb h3{font:500 0.72rem/1.3 var(--gl-font-mono);letter-spacing:0.06em;text-transform:uppercase;color:var(--rs-muted)}.rs-fb ul{margin:0;padding-left:1.1rem;display:grid;gap:0.3rem}.rs-fb a{color:var(--rs-ink)}.rs-fb__nav{display:flex;justify-content:space-between;gap:var(--gl-space-3);border-top:1px solid var(--rs-rule);padding-top:var(--gl-space-3)}.rs-fb button{min-height:2.75rem;padding:0 var(--gl-space-3);border:1px solid var(--rs-rule);border-radius:var(--gl-radius-sm);background:transparent;color:var(--rs-ink);font:500 0.8rem/1 var(--gl-font-sans);cursor:pointer}.rs-fb button:hover{border-color:var(--rs-ink)}.rs-fb button:focus-visible{outline:2px solid var(--rs-accent);outline-offset:2px}.rs-fb button[disabled]{opacity:0.4;cursor:default}";

export function createFallbackDossier(dialog, { data, i18n, bus }) {
  const { t, L } = i18n;
  let cur = null;
  let reason = 'button';
  if (!doc.getElementById('rs-fb-css')) {
    const st = doc.createElement('style');
    st.id = 'rs-fb-css';
    st.textContent = FALLBACK_CSS;
    doc.head.appendChild(st);
  }
  dialog.setAttribute('data-rs-fallback', '');
  dialog.setAttribute('aria-labelledby', 'rs-d-title');

  function titleOf(tgt) {
    const race = tgt && tgt.raceId ? data.getRace(tgt.raceId) : null;
    if (race) return L(race.name);
    const bib = tgt && tgt.bibId ? data.getBib(tgt.bibId) : null;
    return bib ? `${i18n.numberShort(bib)}, ${t('label.unassigned')}` : '';
  }

  function sourcesHTML(ids) {
    const seen = new Set();
    const items = [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const s = data.getSource(id);
      if (!s) continue;
      const kind = t(`d.src.${s.kind === 'web' ? 'web' : s.kind === 'photo' ? 'photo' : 'local'}`);
      const text = `${esc(L(s.label))} <span>(${esc(kind)})</span>`;
      items.push(`<li>${s.public && s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${text}</a>` : text}</li>`);
    }
    return items.length ? `<h3>${esc(t('d.sources'))}</h3><ul>${items.join('')}</ul>` : '';
  }

  function render(tgt) {
    const race = tgt.raceId ? data.getRace(tgt.raceId) : null;
    const bib = tgt.bibId ? data.getBib(tgt.bibId) : race && race.primaryBib ? data.getBib(race.primaryBib) : null;
    cur = { raceId: race ? race.id : null, bibId: bib ? bib.id : null, stage: tgt.stage ?? null };
    const nb = data.neighbours(race ? race.id : bib && bib.id);
    const kicker = [bib ? i18n.numberShort(bib) : null, race && race.country, nb.index >= 0 ? t('d.position', { i: nb.index + 1, n: nb.total }) : null].filter(Boolean).join(' · ');
    const src = [];
    let body = '';
    if (race) {
      const line = [i18n.raceDate(race, 'long'), L(race.place), race.country ? i18n.fmt.country(race.country) : ''].filter(Boolean).join(' · ');
      body += `<p>${esc(line)}</p>`;
      const res = race.result;
      if (res && res.src && res.src.length) {
        src.push(...res.src);
        const big = i18n.resultShort(res);
        body += `<h3>${esc(t('d.result'))}</h3>${big ? `<p class="rs-fb__res">${esc(big)}</p>` : ''}<p>${esc(res.text ? L(res.text) : i18n.resultPhrase(res))}</p>`;
      }
      const stageRow = tgt.stage != null ? race.stages.find((s) => Number(s.n) === Number(tgt.stage)) : null;
      if (stageRow && stageRow.result && stageRow.result.src) {
        src.push(...stageRow.result.src);
        body += `<p>${esc(L(stageRow.name))}: ${esc(i18n.resultPhrase(stageRow.result))}</p>`;
      }
      if (race.team && race.team.src) { src.push(...race.team.src); body += `<p>${esc(t('d.meta.team'))}: ${esc(race.team.name)}</p>`; }
    }
    // round 3: no match status or reason (D23) and no description of the printed number (D24)
    if (!race && bib) {
      const num = bib.number ? String(bib.number).replace(/\?+$/, '') : '';
      body += `<p><a class="plausible-event-name=E-Mail+Kontakt" href="mailto:tom@jansn.de?subject=${encodeURIComponent(`Startnummer ${num}`.trim())}">${esc(t('d.ask'))}</a></p>`;
    }
    dialog.innerHTML = `<div class="rs-fb">`
      + `<div class="rs-fb__top"><span class="rs-fb__k">${esc(kicker)}</span><button type="button" data-fb="close">${esc(t('d.close'))}</button></div>`
      + `<h2 id="rs-d-title" tabindex="-1">${esc(race ? L(race.name) : t('label.unassigned'))}</h2>`
      + body + sourcesHTML(src)
      + `<div class="rs-fb__nav"><button type="button" data-fb="prev"${nb.prev ? '' : ' disabled'}>${esc(nb.prev ? t('d.prevTo', { name: titleOf(nb.prev) }) : t('d.prev'))}</button>`
      + `<button type="button" data-fb="next"${nb.next ? '' : ' disabled'}>${esc(nb.next ? t('d.nextTo', { name: titleOf(nb.next) }) : t('d.next'))}</button></div>`
      + `</div>`;
    const h = dialog.querySelector('#rs-d-title');
    if (h) h.focus({ preventScroll: true });
  }

  function go(dir) {
    if (!cur) return Promise.resolve();
    const nb = data.neighbours(cur.raceId || cur.bibId);
    const tgt = dir === 'prev' || dir < 0 ? nb.prev : nb.next;
    if (!tgt) return Promise.resolve();
    render(tgt);
    bus.emit('dossier:switch', { dir: dir === 'prev' || dir < 0 ? 'prev' : 'next', ...cur });
    return Promise.resolve();
  }

  dialog.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fb]');
    if (b) { const a = b.getAttribute('data-fb'); if (a === 'close') api.close('button'); else go(a); return; }
    if (e.target === dialog) api.close('backdrop');
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); api.close('esc'); });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target.closest && e.target.closest('input, select, textarea, [role="slider"]')) return;
      e.preventDefault();
      go(e.key === 'ArrowLeft' ? 'prev' : 'next');
    }
  });
  dialog.addEventListener('close', () => {
    if (!cur) return;
    const done = cur;
    cur = null;
    dialog.innerHTML = '<h2 class="rs-sr" id="rs-d-title"></h2>';
    bus.emit('dossier:closed', { bibId: done.bibId, raceId: done.raceId, reason });
  });

  const api = {
    open(tgt) {
      render(tgt);
      if (!dialog.open) { try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); } }
      const h = dialog.querySelector('#rs-d-title');
      if (h) h.focus({ preventScroll: true });
      bus.emit('dossier:opened', { ...cur });
      return Promise.resolve();
    },
    close(r = 'button') {
      reason = r;
      if (dialog.open) dialog.close();
      return Promise.resolve();
    },
    switch: go,
    isOpen: () => Boolean(dialog.open && cur),
    current: () => (cur ? { ...cur } : null),
    fallback: true,
  };
  return api;
}

export default { createFallbackDossier };
