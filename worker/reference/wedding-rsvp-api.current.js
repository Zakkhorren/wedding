
const YES = "Да, конечно!";
const NO = "К сожалению, нет";
const MAYBE = "Отвечу чуть позже";
const LIMIT = 500;

const response = (text, status = 200) => new Response(text, {
  status,
  headers: { "Content-Type": "text/plain; charset=utf-8" }
});

async function api(env, method, payload, multipart = false) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      ...(multipart
        ? { body: payload }
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          })
    }
  );

  const data = await r.json();

  if (!r.ok || !data.ok) {
    throw new Error(`Telegram ${method}: ${r.status}`);
  }

  return data.result;
}

const send = (env, chatId, text) => api(env, "sendMessage", {
  chat_id: chatId,
  text: text.slice(0, 4000)
});

async function sendLines(env, chatId, title, lines) {
  let chunk = title;

  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3800) {
      await send(env, chatId, chunk);
      chunk = title + " (продолжение)";
    }

    chunk += "\n" + line;
  }

  await send(env, chatId, chunk);
}

async function readAll(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, attending, additional_guests, guest_count, " +
    "drinks_json, custom_drink, parking_choice, cars_requested, " +
    "parking_status, message, extra_answers_json, " +
    "created_at, updated_at " +
    "FROM rsvp_responses ORDER BY created_at ASC LIMIT ?"
  ).bind(LIMIT + 1).all();

  return results || [];
}

function parseDrinks(value) {
  try {
    const data = JSON.parse(value || "[]");
    return Array.isArray(data)
      ? data.filter(x => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function stats(rows) {
  const yes = rows.filter(r => r.attending === YES);
  const no = rows.filter(r => r.attending === NO).length;
  const maybe = rows.filter(r => r.attending === MAYBE).length;

  const knownCount = yes.filter(
    r => Number.isInteger(r.guest_count) && r.guest_count >= 1
  );

  const people = yes.length === knownCount.length
    ? String(knownCount.reduce((sum, r) => sum + r.guest_count, 0))
    : "пока нельзя точно посчитать (нет обязательного количества гостей)";

  return (
    "📊 Статистика\n\n" +
    `✅ Подтвердили: ${yes.length} анкет\n` +
    `❌ Не придут: ${no}\n` +
    `⏳ Думают: ${maybe}\n` +
    `👥 Подтверждено людей: ${people}\n\n` +
    `Всего анкет: ${rows.length}`
  );
}

function drinks(rows) {
  const counts = new Map();
  const other = new Map();

  for (const r of rows.filter(r => r.attending === YES)) {
    for (const d of new Set(parseDrinks(r.drinks_json))) {
      counts.set(d, (counts.get(d) || 0) + 1);
    }

    const own = String(r.custom_drink || "").trim();

    if (own) {
      other.set(own, (other.get(own) || 0) + 1);
    }
  }

  const entries = [...counts].sort((a, b) => b[1] - a[1]);

  if (!entries.length && !other.size) {
    return "🥂 Предпочтений по напиткам пока нет.";
  }

  const standard = entries
    .map(([name, count]) => `${name}: ${count}`)
    .join("\n");

  const custom = [...other]
    .map(([name, count]) => `${name}: ${count}`)
    .join("\n");

  return (
    "🥂 Напитки (среди подтвердивших)\n\n" +
    (standard || "Стандартные варианты не выбраны.") +
    (custom ? `\n\nСвои варианты:\n${custom}` : "") +
    "\n\nОдин гость мог выбрать несколько напитков."
  );
}

function parking(rows) {
  const requests = rows.filter(
    r => r.attending === YES && r.parking_choice === "yes"
  );

  const uncertain = rows.filter(
    r => r.attending === YES && r.parking_choice === "unknown"
  ).length;

  const requested = requests.reduce(
    (s, r) => s + Math.max(0, Number(r.cars_requested) || 0),
    0
  );

  const approved = requests
    .filter(r => r.parking_status === "approved")
    .reduce(
      (s, r) => s + Math.max(0, Number(r.cars_requested) || 0),
      0
    );

  const pending = requests.filter(
    r => !["approved", "rejected"].includes(r.parking_status)
  );

  const listing = requests.map(r => {
    const label = r.parking_status === "approved"
      ? "✅ подтверждено"
      : r.parking_status === "rejected"
        ? "❌ отказ"
        : "⏳ ожидает решения";

    return `• ${r.name} — ${r.cars_requested || "?"} авто (${label})`;
  });

  return {
    intro:
      "🚗 Парковка (всего 8 мест)\n\n" +
      `Запрошено: ${requested} авто\n` +
      `Подтверждено: ${approved}/8\n` +
      `Заявок на решение: ${pending.length}\n` +
      `Пока не знают: ${uncertain}\n\n` +
      "Подтверждение мест через бота пока не настроено.",
    listing
  };
}

function csvCell(value) {
  let v = String(value ?? "").replace(/\r\n?/g, "\n");

  // Не даём Excel воспринимать текст гостя как формулу.
  if (/^\s*[=+@-]/.test(v)) {
    v = "'" + v;
  }

  return '"' + v.replace(/"/g, '""') + '"';
}

async function sendExport(env, chatId, rows) {
  const columns = [
    ["id", "ID"],
    ["name", "Имя"],
    ["attending", "Присутствие"],
    ["additional_guests", "Дополнительные гости"],
    ["guest_count", "Всего гостей"],
    ["drinks_json", "Напитки JSON"],
    ["custom_drink", "Свой напиток"],
    ["parking_choice", "Парковка"],
    ["cars_requested", "Машин"],
    ["parking_status", "Статус парковки"],
    ["message", "Сообщение"],
    ["extra_answers_json", "Дополнительные ответы JSON"],
    ["created_at", "Создано"],
    ["updated_at", "Обновлено"]
  ];

  const csv = "\uFEFF" + [
    columns.map(([, title]) => csvCell(title)).join(","),
    ...rows.map(r =>
      columns.map(([key]) => csvCell(r[key])).join(",")
    )
  ].join("\r\n");

  const form = new FormData();

  form.append("chat_id", String(chatId));
  form.append(
    "document",
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    "wedding-rsvp.csv"
  );
  form.append(
    "caption",
    `Анкеты гостей: ${rows.length} записей. Файл только для организаторов.`
  );

  await api(env, "sendDocument", form, true);
}

async function telegramWebhook(request, env) {
  if (
    !env.WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token")
      !== env.WEBHOOK_SECRET
  ) {
    return response("Forbidden", 403);
  }

  const update = await request.json().catch(() => null);
  const msg = update?.message;

  if (
    !msg ||
    msg.chat?.type !== "private" ||
    !msg.from?.id
  ) {
    return response("OK");
  }

  const chatId = msg.chat.id;

  const allowed = String(env.ADMIN_IDS || "")
    .split(/[\s,;]+/)
    .filter(Boolean);

  if (!allowed.includes(String(msg.from.id))) {
    await send(env, chatId, "⛔ Доступ только для организаторов.");
    return response("OK");
  }

  const command = String(msg.text || "")
    .trim()
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();

  try {
    if (command === "/start" || command === "/help") {
      await send(
        env,
        chatId,
        "💌 Свадьба Сони и Леши — админка\n\n" +
        "/stats — сводка по анкетам\n" +
        "/guests — список гостей\n" +
        "/drinks — предпочтения по напиткам\n" +
        "/parking — заявки на парковку\n" +
        "/export — таблица CSV\n\n" +
        "Сайт пока в демо-режиме; реальные анкеты не поступают."
      );
    }

    else if (
      ["/stats", "/guests", "/drinks", "/parking", "/export"]
        .includes(command)
    ) {
      if (!env.DB) {
        throw new Error("D1 binding DB missing");
      }

      const all = await readAll(env);
      const tooMany = all.length > LIMIT;
      const rows = all.slice(0, LIMIT);

      if (command === "/stats") {
        await send(
          env,
          chatId,
          stats(rows) +
          (tooMany ? "\n⚠️ Показаны первые 500 записей." : "")
        );
      }

      if (command === "/drinks") {
        await send(
          env,
          chatId,
          drinks(rows) +
          (tooMany ? "\n⚠️ Показаны первые 500 записей." : "")
        );
      }

      if (command === "/guests") {
        if (!rows.length) {
          await send(env, chatId, "👥 Пока нет анкет.");
        } else {
          await sendLines(
            env,
            chatId,
            "👥 Анкеты гостей",
            rows.map((r, i) =>
              `${i + 1}. ${r.name} — ${r.attending}` +
              (r.additional_guests
                ? ` (с кем: ${r.additional_guests})`
                : "")
            )
          );
        }
      }

      if (command === "/parking") {
        const data = parking(rows);

        await send(env, chatId, data.intro);

        if (data.listing.length) {
          await sendLines(
            env,
            chatId,
            "🚗 Заявки:",
            data.listing
          );
        }
      }

      if (command === "/export") {
        if (tooMany) {
          await send(
            env,
            chatId,
            "⚠️ В базе больше 500 анкет. " +
            "Выгрузка ограничена первыми 500."
          );
        }

        await sendExport(env, chatId, rows);
      }
    }

    else if (command.startsWith("/")) {
      await send(
        env,
        chatId,
        "Неизвестная команда. Список команд: /help"
      );
    }

    return response("OK");

  } catch (error) {
    console.error(
      "Admin bot error:",
      error?.message || "unknown"
    );

    return response("Temporary error", 503);
  }
}


async function handleRsvp(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || "");
  const origin = request.headers.get("Origin") || "";

  const cors = {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };

  const json = (body, status = 200) => new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );

  if (!allowed || origin !== allowed) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!env.DB || !env.TURNSTILE_SECRET || !env.BOT_TOKEN) {
    return json({ error: "Not configured" }, 503);
  }

  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    return json({ error: "Expected JSON" }, 415);
  }

  const raw = await request.text();

  if (new TextEncoder().encode(raw).length > 12000) {
    return json({ error: "Too large" }, 413);
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return json({ error: "Invalid form" }, 400);
  }

  const s = (v, limit = 1000) =>
    typeof v === "string" ? v.trim().slice(0, limit) : "";

  const name = s(data.name, 120);
  const attending = s(data.attending, 80);

  const allowedAttendance = [
    "Да, конечно!",
    "К сожалению, нет",
    "Отвечу чуть позже"
  ];

  if (
    !name ||
    !allowedAttendance.includes(attending) ||
    data.consent !== true
  ) {
    return json({ error: "Invalid form" }, 400);
  }

  const yes = attending === "Да, конечно!";
  const allDrinks = Array.isArray(data.drinks) ? data.drinks : [];

  if (
    allDrinks.length > 15 ||
    allDrinks.some(x => typeof x !== "string" || x.length > 80)
  ) {
    return json({ error: "Invalid drinks" }, 400);
  }

  const drinks = yes
    ? [...new Set(allDrinks.map(x => x.trim()).filter(Boolean))]
    : [];

  const parking = yes ? s(data.parking, 15) : "";

  if (!["", "yes", "no", "unknown"].includes(parking)) {
    return json({ error: "Invalid parking" }, 400);
  }

  const cars = parking === "yes" ? Number(data.carCount) : 0;

  if (
    parking === "yes" &&
    (!Number.isInteger(cars) || cars < 1 || cars > 20)
  ) {
    return json({ error: "Invalid car count" }, 400);
  }

  const count = yes ? Number(data.guestCount) : 0;

  const guestCount =
    yes && Number.isInteger(count) && count >= 1 && count <= 50
      ? count
      : null;

  const token = s(data.turnstileToken, 2049);

  if (!token || token.length > 2048) {
    return json({ error: "Verify the form" }, 400);
  }

  let verified;

  try {
    const check = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET,
          response: token,
          remoteip: request.headers.get("CF-Connecting-IP") || undefined
        })
      }
    );

    if (!check.ok) {
      return json({ error: "Verification unavailable" }, 503);
    }

    verified = await check.json();
  } catch {
    return json({ error: "Verification unavailable" }, 503);
  }

  if (
    verified.success !== true ||
    verified.hostname !== new URL(allowed).hostname
  ) {
    return json({
      error: "Verification failed. Please try again."
    }, 400);
  }

  const inputId = s(data.submissionId, 70);

  const id =
    /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(inputId)
      ? inputId
      : crypto.randomUUID();

  const additionalGuests = yes ? s(data.additionalGuests, 250) : "";
  const ownDrink = yes ? s(data.otherDrink, 250) : "";
  const message = s(data.message, 2000);

  const parkingStatus =
    parking === "yes" ? "pending" : "not_requested";

  const extras =
    data.extraAnswers &&
    typeof data.extraAnswers === "object" &&
    !Array.isArray(data.extraAnswers)
      ? JSON.stringify(data.extraAnswers)
      : "{}";

  if (extras.length > 2000) {
    return json({ error: "Too many extra answers" }, 400);
  }

  let saved;

  try {
    saved = await env.DB.prepare(
      "INSERT INTO rsvp_responses " +
      "(id,name,attending,additional_guests,guest_count,drinks_json," +
      "custom_drink,parking_choice,cars_requested,parking_status," +
      "message,extra_answers_json) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO NOTHING"
    ).bind(
      id,
      name,
      attending,
      additionalGuests,
      guestCount,
      JSON.stringify(drinks),
      ownDrink,
      parking,
      cars,
      parkingStatus,
      message,
      extras
    ).run();
  } catch (err) {
    console.error(
      "RSVP database insert failed",
      err?.message || "unknown"
    );
    return json({ error: "Could not save the response" }, 503);
  }

  if ((saved.meta?.changes ?? 1) > 0) {
    const notice = [
      "💌 Новая анкета",
      `Имя: ${name}`,
      `Присутствие: ${attending}`,
      yes && additionalGuests
        ? `Доп. гости: ${additionalGuests}`
        : "",
      guestCount ? `Всего человек: ${guestCount}` : "",
      drinks.length ? `Напитки: ${drinks.join(", ")}` : "",
      ownDrink ? `Свой напиток: ${ownDrink}` : "",
      parking
        ? `Парковка: ${parking}${parking === "yes" ? ` (${cars} машин)` : ""}`
        : "",
      message ? `Сообщение: ${message}` : ""
    ].filter(Boolean).join("\n").slice(0, 3800);

    const ids = [...new Set(
      String(env.ADMIN_IDS || "")
        .split(/[\s,;]+/)
        .filter(x => /^\d{4,16}$/.test(x))
    )];

    for (const chatId of ids) {
      try {
        await send(env, chatId, notice);
      } catch (err) {
        console.error(
          "Admin notification failed",
          err?.message || "unknown"
        );
      }
    }
  }

  return json({ ok: true });
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/rsvp") {
      return handleRsvp(request, env);
    }

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return response(
        "Wedding RSVP admin bot is running. " +
        "RSVP form is not connected yet."
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/telegram"
    ) {
      return telegramWebhook(request, env);
    }

    return response("Not found", 404);
  }
};
