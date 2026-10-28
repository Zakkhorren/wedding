/**
 * Пример Cloudflare Worker — Telegram relay для RSVP.
 * Настройте в Cloudflare Worker Secrets: BOT_TOKEN, CHAT_ID.
 * Обычная переменная: ALLOWED_ORIGIN=https://YOUR-USERNAME.github.io
 * Не публикуйте реальные значения секретов в GitHub.
 * Для продакшена желательно дополнительно включить Turnstile/антиспам, rate limiting.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: origin === allowed ? 204 : 403, headers: cors });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!origin || origin !== allowed) return new Response('Forbidden', { status: 403, headers: cors });
    if (!env.BOT_TOKEN || !env.CHAT_ID) return new Response('Not configured', { status: 503, headers: cors });
    if (Number(request.headers.get('Content-Length') || 0) > 12000) return new Response('Too large', { status: 413, headers: cors });
    let payload;
    try { payload = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
    const s = (v, max=1000) => String(v ?? '').trim().slice(0,max);
    const name = s(payload.name,120);
    const attending = s(payload.attending,80);
    const allowedAttendance = ['Да, конечно!', 'К сожалению, нет', 'Отвечу чуть позже'];
    if (!name || !allowedAttendance.includes(attending) || payload.consent !== true) return new Response('Invalid RSVP', { status: 400, headers: cors });
    const drinks = Array.isArray(payload.drinks) ? payload.drinks.slice(0,10).map(v=>s(v,60)).join(', ') : '';
    const message = [
      '💌 Новый ответ RSVP',
      `Имя: ${name}`,
      `Присутствие: ${attending}`,
      `Доп. гости: ${s(payload.additionalGuests,250)||'—'}`,
      `Напитки: ${drinks||'—'}`,
      `Свой напиток: ${s(payload.otherDrink,250)||'—'}`,
      `Сообщение: ${s(payload.message,2000)||'—'}`
    ].join('\n').slice(0,3900);
    try {
      const telegram = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.CHAT_ID, text: message })
      });
      if (!telegram.ok) return new Response('Delivery failed', { status: 502, headers: cors });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: {...cors,'Content-Type':'application/json; charset=utf-8'} });
    } catch {
      return new Response('Delivery failed', { status: 502, headers: cors });
    }
  }
};
