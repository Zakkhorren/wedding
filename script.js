(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const config = window.WEDDING_CONFIG || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(config.date || '') ? new Date(`${config.date}T12:00:00`) : new Date('2027-06-19T12:00:00');
  const dateLabel = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  const dateLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(date);
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(date);
  const first = config.names?.first || 'Лера';
  const second = config.names?.second || 'Макс';
  document.title = `${first} и ${second} — приглашение на свадьбу`;
  const text = (sel, val) => { const elem = $(sel); if (elem) elem.textContent = val; };
  text('#hero-date-script', `${first} + ${second} · ${dateLabel}`);
  text('#date-callout', dateLong);
  text('#date-meta', `${weekday}, ${config.dateTime || '15:00'}`);
  text('#calendar-month', month);
  text('#venue-name', config.venueName || 'Место проведения');
  text('#venue-address', `${config.venueAddress || 'Адрес будет здесь'}${(config.venueAddress || '').includes('Цветочная') ? ' (демо)' : ''}`);
  text('#signature', `ваши ${first} и ${second} ♡`);
  if (config.rsvpDeadline && /^\d{4}-\d{2}-\d{2}$/.test(config.rsvpDeadline)) {
    const deadline = new Date(`${config.rsvpDeadline}T12:00:00`);
    text('#rsvp-deadline', `ответьте, пожалуйста, до ${new Intl.DateTimeFormat('ru-RU').format(deadline)}`);
  }
  const map = $('#venue-map');
  if (map && /^https:\/\//.test(config.venueMapUrl || '')) map.href = config.venueMapUrl;
  (config.schedule || []).slice(0, 4).forEach((step, i) => { if (Array.isArray(step)) { text(`#timeline-t${i + 1}`, step[0]); const v = $(`.stop-${i + 1} .timeline-text`); if (v) v.textContent = step[1]; } });

  const photos = [ ['#hero-photo-one', config.heroImages?.[0]], ['#hero-photo-two', config.heroImages?.[1]], ['#venue-photo', config.venueImage] ];
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
    const t = (config.dateTime || '15:00').split(':');
    const start = `${day}T${pad(t[0] || '15')}${pad(t[1] || '00')}00`;
    const end = `${day}T${pad(Number(t[0] || 15) + 5)}${pad(t[1] || '00')}00`;
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Wedding Invitation//RU','BEGIN:VEVENT',`DTSTART:${start}`,`DTEND:${end}`,`SUMMARY:Свадьба — ${first} и ${second}`,`LOCATION:${(config.venueAddress || '').replace(/[,;\\]/g, ' ')}`,'END:VEVENT','END:VCALENDAR'];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'save-the-date.ics'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('IntersectionObserver' in window && motionOK) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } }), { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });
    $$('.reveal').forEach(el => observer.observe(el));
  } else $$('.reveal').forEach(el => el.classList.add('is-visible'));
  function $$(selector) { return document.querySelectorAll(selector); }
  const path = $('#timeline-ink');
  const travelHeart = $('#timeline-travel-heart');
  const scrollLine = $('#reading-line-fill');
  const backToTop = $('.back-to-top');
  let pathLen = 0;
  if (path) { pathLen = path.getTotalLength(); path.style.strokeDasharray = String(pathLen); path.style.strokeDashoffset = String(pathLen); }
  let ticking = false;
  const updateScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? window.scrollY / max : 0;
    if (scrollLine) scrollLine.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
    backToTop?.classList.toggle('shown', window.scrollY > 800);
    if (path && pathLen) {
      const rect = $('#timeline-inner').getBoundingClientRect();
      const raw = (window.innerHeight * 0.66 - rect.top) / (rect.height + window.innerHeight * 0.25);
      const value = Math.max(0, Math.min(1, raw));
      path.style.strokeDashoffset = String(pathLen * (1 - value));
      if (travelHeart) {
        const p = path.getPointAtLength(pathLen * value);
        travelHeart.style.left = `${p.x}px`;
        travelHeart.style.top = `${p.y}px`;
        travelHeart.style.opacity = value > 0.02 ? '1' : '0';
      }
    }
    ticking = false;
  };
  window.addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(updateScroll); ticking = true; } }, { passive: true });
  window.addEventListener('resize', updateScroll, { passive: true });
  updateScroll();
  $('#envelope')?.addEventListener('click', e => {
    const button = e.currentTarget;
    const open = button.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });

  const form = $('#rsvp-form');
  const attendingGroup = $('#attending-fields');
  const endpoint = String(config.rsvpEndpoint || '').trim();
  const isDemo = !/^https:\/\//.test(endpoint);
  const modeNote = $('#mode-note');
  if (isDemo) modeNote.textContent = 'Демо-режим: ответы пока никуда не отправляются. Для настоящей отправки подключим Telegram или почту.';
  else modeNote.textContent = 'Ваш ответ будет передан организаторам праздника.';
  form?.addEventListener('change', () => {
    const attending = form.querySelector('input[name="attending"]:checked')?.value || '';
    attendingGroup.classList.toggle('inactive', attending && attending !== 'Да, конечно!');
    attendingGroup.querySelectorAll('input, textarea').forEach(el => { el.disabled = !!attending && attending !== 'Да, конечно!'; });
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
    const answer = {
      name, attending,
      additionalGuests: attendingYes ? (f.get('additionalGuests') || '').toString().trim() : '',
      drinks: attendingYes ? f.getAll('drinks').map(String) : [],
      food: attendingYes ? (f.get('food') || '').toString().trim() : '',
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
    } finally { button.disabled = false; button.innerHTML = 'отправить ответ <span aria-hidden="true">♡</span>'; }
  });
  $('#edit-answer')?.addEventListener('click', () => {
    $('#rsvp-success').hidden = true; form.hidden = false;
    form.scrollIntoView({ behavior: motionOK ? 'smooth' : 'auto', block: 'start' });
  });
})();
