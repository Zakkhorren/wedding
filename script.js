(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const config = window.WEDDING_CONFIG || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(config.date || '') ? new Date(`${config.date}T12:00:00`) : new Date('2027-01-23T12:00:00');
  const dateLabel = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  const dateLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(date);
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(date);
  const first = config.names?.first || 'Соня';
  const second = config.names?.second || 'Леша';
  document.title = `${first} и ${second} — приглашение на свадьбу`;
  const text = (sel, val) => { const elem = $(sel); if (elem) { elem.textContent = val; replaceHearts(elem); } };
  function makeHeart() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'heart-icon'); svg.setAttribute('viewBox', '0 0 92.66 85.85');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#wedding-heart-shape'); svg.append(use); return svg;
  }
  function replaceHearts(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (/[♡♥]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement.closest('svg,script,style,input,textarea,select,option')) continue;
      const fragment = document.createDocumentFragment();
      node.nodeValue.split(/([♡♥])/).forEach(part => fragment.append(/[♡♥]/.test(part) ? makeHeart() : document.createTextNode(part)));
      node.replaceWith(fragment);
    }
  }

  text('#hero-date-script', `${first} + ${second} · ${dateLabel}`);
  text('#date-callout', dateLong);
  text('#date-meta', `${weekday}, ${config.dateTime || '16:00'}`);
  text('#calendar-month', month);
  text('#venue-name', config.venueName || 'Место проведения');
  text('#venue-address', `${config.venueAddress || 'Адрес будет здесь'}${(config.venueAddress || '').includes('Цветочная') ? ' (демо)' : ''}`);
  text('#signature', `ваши ${first} и ${second} ♡`);
  if (config.rsvpDeadline && /^\d{4}-\d{2}-\d{2}$/.test(config.rsvpDeadline)) {
    const deadline = new Date(`${config.rsvpDeadline}T12:00:00`);
    text('#rsvp-deadline', `ответьте, пожалуйста, до ${new Intl.DateTimeFormat('ru-RU').format(deadline)}`);
  }
  const map = $('#venue-map');
  if (map) map.href = `https://yandex.ru/maps/?mode=search&text=${encodeURIComponent(config.venueAddress || 'поселок Новобутаково 44с1')}`;
  (config.schedule || []).slice(0, 4).forEach((step, i) => { if (Array.isArray(step)) { text(`#timeline-t${i + 1}`, step[0]); const v = $(`.stop-${i + 1} .timeline-text`); if (v) v.textContent = step[1]; } });

  const photos = [ ['#hero-couple-photo', config.heroImage], ['#venue-photo', config.venueImage] ];
  photos.forEach(([sel, url]) => {
    const img = $(sel);
    if (!img) return;
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.classList.remove('loaded'));
    if (url && /^(https:\/\/|\.\/|assets\/)/.test(url)) img.src = url;
  });

  const cal = $('#calendar-grid');
  if (cal) {
    ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].forEach(v => {
      const el = document.createElement('span'); el.className = 'weekday'; el.textContent = v; cal.append(el);
    });
    const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const offset = (firstOfMonth.getDay() + 6) % 7;
    for (let cell = 0; cell < 42; cell++) {
      const day = new Date(date.getFullYear(), date.getMonth(), 1 - offset + cell);
      const el = document.createElement('span');
      el.textContent = String(day.getDate());
      el.className = 'cal-day';
      if (day.getMonth() !== date.getMonth()) el.classList.add('muted');
      if (day.getDate() === date.getDate() && day.getMonth() === date.getMonth()) {
        el.classList.add('chosen'); el.setAttribute('aria-label', `${date.getDate()} ${month} — день свадьбы`);
      }
      cal.append(el);
    }
  }

  $('#save-date')?.addEventListener('click', () => {
    const pad = v => String(v).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const t = (config.dateTime || '16:00').split(':');
    const start = `${day}T${pad(t[0] || '15')}${pad(t[1] || '00')}00`;
    const end = `${day}T${pad(Number(t[0] || 15) + 5)}${pad(t[1] || '00')}00`;
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Wedding Invitation//RU','BEGIN:VEVENT',`DTSTART:${start}`,`DTEND:${end}`,`SUMMARY:Свадьба — ${first} и ${second}`,`LOCATION:${(config.venueAddress || '').replace(/[,;\\]/g, ' ')}`,'END:VEVENT','END:VCALENDAR'];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'save-the-date.ics'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motionOK = !motionPreference.matches;
  motionPreference.addEventListener('change', () => { motionOK = !motionPreference.matches; updateScroll(); });
  const track = $('.ticker-track');
  const ticker = $('.ticker');
  function layoutTicker() {
    // Each phrase and heart is a separate token: all four boundaries use one gap.
    const group = document.createElement('div'); group.className = 'ticker-group';
    track.replaceChildren(group);
    function addRepeat() {
      for (const label of ['приглашение на свадьбу', '♡']) {
        const token = document.createElement('span'); token.className = 'ticker-token';
        if (label === '♡') token.append(makeHeart()); else token.textContent = label; group.append(token);
      }
    }
    addRepeat();
    const repeatWidth = group.getBoundingClientRect().width;
    const count = Math.ceil(ticker.clientWidth / repeatWidth) + 1;
    for (let i = 1; i < count; i++) addRepeat();
    track.append(group.cloneNode(true));
    const width = group.getBoundingClientRect().width;
    const speed = window.matchMedia('(max-width: 600px)').matches ? 75 : 65;
    track.style.setProperty('--marquee-width', `${width}px`);
    track.style.setProperty('--marquee-duration', `${width / speed}s`);
  }
  layoutTicker();
  document.fonts.ready.then(layoutTicker);

  // Two identical fixed layers share trajectories; clipping follows the dark section.
  const snowLayers = ['light', 'dark'].map(theme => {
    const snow = document.createElement('div'); snow.className = `snow snow-${theme}`;
    snow.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 26; i++) {
      const flake = document.createElement('i');
      flake.style.cssText = `--left:${(i * 47.3) % 100}%;--duration:${20 + i % 15}s;--delay:-${i * 2.7}s;--drift:${(i % 7 - 3) * 13}px`;
      snow.append(flake);
    }
    document.body.prepend(snow); return snow;
  });
  if ('IntersectionObserver' in window && motionOK) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } }), { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });
    $$('.reveal').forEach(el => observer.observe(el));
  } else $$('.reveal').forEach(el => el.classList.add('is-visible'));
  function $$(selector) { return document.querySelectorAll(selector); }
  const path = $('#timeline-ink');
  const travelHeart = $('#timeline-travel-heart');
  const scrollLine = $('#reading-line-fill');
  const backToTop = $('.back-to-top');
  const timeline = $('#timeline-inner');
  const stops = [...$$('.timeline-stop')];
  const routeSvg = path.ownerSVGElement;
  const routeBackground = $('.timeline-route-bg');
  const sourceRoute = path.getAttribute('d');
  const sourceViewBox = routeSvg.viewBox.baseVal;
  const sourceWidth = sourceViewBox.width, sourceHeight = sourceViewBox.height;
  const heartShape = travelHeart.querySelector('use');
  const heartBounds = heartShape.getBBox();
  const heartCenter = { x: heartBounds.x + heartBounds.width / 2, y: heartBounds.y + heartBounds.height / 2 };
  const clamp = value => Math.max(0, Math.min(1, value));
  let pathLen = 0, stopProgress = [], ticking = false;

  function layoutRoute() {
    const rect = routeSvg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Bake the responsive scale into the path itself. Path units, dash lengths and
    // marker coordinates are now identical; no non-scaling-stroke dash conversion.
    let coordinate = 0;
    const d = sourceRoute.replace(/-?\d*\.?\d+/g, number => {
      const scale = coordinate++ % 2 ? rect.height / sourceHeight : rect.width / sourceWidth;
      return String(Number(number) * scale);
    });
    routeSvg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    routeSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    path.setAttribute('d', d); routeBackground.setAttribute('d', d);
    pathLen = path.getTotalLength();
    path.style.strokeDasharray = `${pathLen} ${pathLen}`;
    const timelineRect = timeline.getBoundingClientRect();
    stopProgress = stops.map(stop => {
      const targetY = stop.offsetTop / timelineRect.height * rect.height;
      let best = 0, distance = Infinity;
      for (let n = 0; n <= 1000; n++) {
        const delta = Math.abs(path.getPointAtLength(pathLen * n / 1000).y - targetY);
        if (delta < distance) { distance = delta; best = n / 1000; }
      }
      return best;
    });
    updateScroll();
  }

  function updateScroll() {
    ticking = false;
    const viewport = window.innerHeight;
    const max = document.documentElement.scrollHeight - viewport;
    if (scrollLine) scrollLine.style.transform = `scaleX(${max > 0 ? clamp(window.scrollY / max) : 0})`;
    backToTop?.classList.toggle('shown', window.scrollY > 800);
    const darkTop = Math.max(0, Math.min(viewport, $('#rsvp').getBoundingClientRect().top));
    snowLayers[0].style.clipPath = `inset(0 0 ${viewport - darkTop}px 0)`;
    snowLayers[1].style.clipPath = `inset(${darkTop}px 0 0 0)`;
    if (!pathLen) return;
    const rect = timeline.getBoundingClientRect();
    const progress = motionOK ? clamp((viewport * .66 - rect.top) / rect.height) : 1;
    const length = pathLen * progress;
    // All route writes happen in the same animation frame, from this exact length.
    path.style.strokeDashoffset = String(pathLen - length);
    const point = path.getPointAtLength(length);
    const matrix = routeSvg.getScreenCTM();
    // Compensate actual SVG scale so the marker is a constant 24px shape.
    const sx = Math.hypot(matrix.a, matrix.b), sy = Math.hypot(matrix.c, matrix.d);
    const size = 24 / heartBounds.width;
    travelHeart.setAttribute('transform', `translate(${point.x} ${point.y}) scale(${size / sx} ${size / sy}) translate(${-heartCenter.x} ${-heartCenter.y})`);
    stops.forEach((stop, i) => {
      const phase = motionOK ? clamp((progress - stopProgress[i] + .08) / .16) : 1;
      const eased = phase * phase * (3 - 2 * phase);
      const distance = (window.innerWidth / 2 + stop.offsetWidth) * (i % 2 ? 1 : -1);
      stop.style.transform = `translateX(${distance * (1 - eased)}px)`;
      stop.style.opacity = String(eased);
    });
  }
  function scheduleScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(updateScroll); }
  }
  window.addEventListener('scroll', scheduleScroll, { passive: true });
  window.addEventListener('resize', () => { layoutTicker(); layoutRoute(); }, { passive: true });
  new ResizeObserver(layoutRoute).observe(timeline);
  document.fonts.ready.then(layoutRoute);
  layoutRoute();

  // One typography pipeline for static and dynamic text. Attributes and form data
  // never enter it; bounded groups prevent long unbreakable chains on small screens.
  const typographyCache = new WeakMap();
  const forwardWords = new Set('в во с со к ко у о об обо на по за и а но не ни от до из без для при про под над или да ли то'.split(' '));
  function formatTypography(value) {
    const plain = value.replace(/\u00a0/g, ' ');
    const words = [...plain.matchAll(/[А-ЯЁа-яё]+(?:[-‑][А-ЯЁа-яё]+)*/g)];
    const groups = words.map((_, i) => ({ start: i, end: i }));
    const joins = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      const left = words[i], right = words[i + 1];
      const gapStart = left.index + left[0].length;
      if (!/^[ \t]+$/.test(plain.slice(gapStart, right.index))) continue;
      const a = left[0].toLocaleLowerCase('ru'), b = right[0].toLocaleLowerCase('ru');
      if (!forwardWords.has(a) && !['бы', 'же'].includes(b) && !(a === 'что' && b === 'вы')) continue;
      const first = groups[i].start, last = groups[i + 1].end;
      if (last - first + 1 > 3 || words[last].index + words[last][0].length - words[first].index > 24) continue;
      for (let n = first; n <= last; n++) groups[n] = { start: first, end: last };
      joins.add(i);
    }
    let result = plain;
    for (let i = words.length - 2; i >= 0; i--) if (joins.has(i)) {
      const start = words[i].index + words[i][0].length;
      result = result.slice(0, start) + '\u00a0' + result.slice(words[i + 1].index);
    }
    return result;
  }
  function typograph(root) {
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      if (!node.parentElement || node.parentElement.closest('script,style,svg,textarea,input,select,option,code,pre,[contenteditable]')) continue;
      const value = node.nodeValue;
      if (typographyCache.get(node) === value) continue;
      const formatted = formatTypography(value);
      if (formatted !== value) node.nodeValue = formatted;
      typographyCache.set(node, formatted);
    }
  }
  const typographyRoot = document.querySelector('main');
  const typographyOptions = { childList: true, characterData: true, subtree: true };
  const typographyObserver = new MutationObserver(records => {
    const changed = new Set();
    for (const record of records) {
      if (record.type === 'characterData') changed.add(record.target);
      else for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) changed.add(node);
    }
    typographyObserver.disconnect();
    for (const node of changed) if (typographyRoot.contains(node)) typograph(node);
    typographyObserver.observe(typographyRoot, typographyOptions);
  });
  typograph(typographyRoot);
  typographyObserver.observe(typographyRoot, typographyOptions);

  const form = $('#rsvp-form');
  const attendingGroup = $('#attending-fields');
  const endpoint = String(config.rsvpEndpoint || '').trim();
  const isDemo = !/^https:\/\//.test(endpoint);
  const modeNote = $('#mode-note');
  if (isDemo) modeNote.textContent = 'Демо-режим: ответы пока никуда не отправляются. Для настоящей отправки подключим Telegram или почту.';
  else modeNote.textContent = 'Ваш ответ будет передан организаторам праздника.';
  function resizeMessage() {
    const textarea = form?.elements.message;
    if (!textarea) return;
    textarea.style.height = '0px';
    const style = getComputedStyle(textarea);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    textarea.style.height = `${Math.max(48, textarea.scrollHeight + borders)}px`;
  }
  form?.elements.message.addEventListener('input', resizeMessage);
  window.addEventListener('resize', resizeMessage, { passive: true });
  document.fonts.ready.then(resizeMessage);
  resizeMessage();
  function syncParking() {
    const attendingYes = form.querySelector('input[name="attending"]:checked')?.value === 'Да, конечно!';
    const parkingFields = $('#parking-fields');
    parkingFields.hidden = !attendingYes;
    parkingFields.querySelectorAll('[name="parking"]').forEach(input => {
      input.disabled = !attendingYes;
      if (!attendingYes) input.checked = false;
    });
    const needsSpace = attendingYes && form.querySelector('[name="parking"]:checked')?.value === 'yes';
    $('#parking-count').hidden = !needsSpace;
    form.elements.carCount.disabled = !needsSpace;
    if (!needsSpace) form.elements.carCount.value = '1';
  }
  syncParking();
  form?.addEventListener('change', () => {
    const attending = form.querySelector('input[name="attending"]:checked')?.value || '';
    attendingGroup.classList.toggle('inactive', attending && attending !== 'Да, конечно!');
    attendingGroup.querySelectorAll('input, textarea').forEach(el => { el.disabled = !!attending && attending !== 'Да, конечно!'; });
    syncParking();
    $('#form-error').hidden = true;
  });
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const error = $('#form-error'); error.hidden = true;
    const f = new FormData(form);
    const name = (f.get('name') || '').toString().trim();
    const attending = (f.get('attending') || '').toString();
    if (!name || !attending || !f.get('consent')) {
      error.textContent = 'Пожалуйста, укажите имя, выберите вариант ответа и подтвердите согласие.'; error.hidden = false;
      const firstInvalid = !name ? form.elements.name : !attending ? form.querySelector('input[name="attending"]') : form.elements.consent;
      firstInvalid?.focus(); return;
    }
    if ((f.get('website') || '').toString().trim()) { error.textContent = 'Не удалось отправить ответ.'; error.hidden = false; return; }
    const attendingYes = attending === 'Да, конечно!';
    const parking = attendingYes ? (f.get('parking') || '').toString() : '';
    const carCount = parking === 'yes' ? Number(f.get('carCount')) : null;
    if (parking === 'yes' && (!Number.isSafeInteger(carCount) || carCount < 1)) {
      error.textContent = 'Пожалуйста, укажите количество машин — целое число от 1.';
      error.hidden = false; form.elements.carCount.focus(); return;
    }
    const answer = {
      name, attending,
      parking: parking || null,
      carCount,
      additionalGuests: attendingYes ? (f.get('additionalGuests') || '').toString().trim() : '',
      drinks: attendingYes ? f.getAll('drinks').map(String) : [],
      otherDrink: attendingYes ? (f.get('otherDrink') || '').toString().trim() : '',
      message: (f.get('message') || '').toString().trim(),
      createdAt: new Date().toISOString(),
      consent: true
    };
    const button = $('#rsvp-submit');
    if (isDemo) {
      form.hidden = true; $('#rsvp-success').hidden = false;
      text('#success-message', 'Анкета заполнена правильно, но это демо: данные не сохранены и не отправлены. После подключения получателя они смогут приходить в Telegram или на почту.');
      $('#rsvp-success').scrollIntoView({ behavior: motionOK ? 'smooth' : 'auto', block: 'center' });
      return;
    }
    button.disabled = true; button.textContent = 'отправляем...';
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      form.hidden = true; $('#rsvp-success').hidden = false;
      text('#success-message', 'Ваш ответ доставлен организаторам. Спасибо! ♡');
      $('#rsvp-success').scrollIntoView({ behavior: motionOK ? 'smooth' : 'auto', block: 'center' });
    } catch {
      error.textContent = 'Не удалось отправить анкету. Пожалуйста, попробуйте позже или напишите организаторам напрямую.';
      error.hidden = false;
    } finally { button.disabled = false; button.textContent = 'отправить ответ '; button.append(makeHeart()); }
  });
  $('#edit-answer')?.addEventListener('click', () => {
    $('#rsvp-success').hidden = true; form.hidden = false;
    resizeMessage();
    form.scrollIntoView({ behavior: motionOK ? 'smooth' : 'auto', block: 'start' });
  });
})();
