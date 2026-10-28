/** Shared RSVP policy used by the prepared API v2 and its client adapter. */
export const CAPACITY = 8;
export const YES = "Да, конечно!";
export const NO = "К сожалению, нет";
export const LATER = "Отвечу чуть позже";
export const DRINKS = Object.freeze([
  "Игристое",
  "Вино белое",
  "Вино красное",
  "Виски",
  "Коньяк",
  "Водка",
  "Ром",
  "Безалкогольное",
]);
export class ValidationError extends Error {}
const text = (value, limit) => {
  if (value != null && typeof value !== "string")
    throw new ValidationError("Invalid text");
  const result = (value || "").trim();
  if (result.length > limit) throw new ValidationError("Text too long");
  return result;
};
const count = (value) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ValidationError("Expected positive integer");
  return value;
};
export function normalizeAnswer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ValidationError("Invalid answer");
  const name = text(raw.name, 120);
  if (
    !name ||
    ![YES, NO, LATER].includes(raw.attending) ||
    raw.consent !== true
  )
    throw new ValidationError("Invalid required fields");
  const yes = raw.attending === YES;
  const guestCount = yes ? count(raw.guestCount) : 0;
  const parking = yes ? raw.parking || null : null;
  if (![null, "yes", "no", "unknown"].includes(parking))
    throw new ValidationError("Invalid parking choice");
  const carCount = parking === "yes" ? count(raw.carCount) : null;
  let drinks = [];
  if (yes) {
    if (
      !Array.isArray(raw.drinks) ||
      raw.drinks.length > 20 ||
      raw.drinks.some((v) => !DRINKS.includes(v))
    )
      throw new ValidationError("Invalid drinks");
    drinks = [...new Set(raw.drinks)].sort(
      (a, b) => DRINKS.indexOf(a) - DRINKS.indexOf(b),
    );
  }
  return {
    name,
    attending: raw.attending,
    guestCount,
    additionalGuests: guestCount > 1 ? text(raw.additionalGuests, 250) : "",
    drinks,
    otherDrink: yes ? text(raw.otherDrink, 250) : "",
    parking,
    carCount,
    message: text(raw.message, 2000),
    consent: true,
  };
}
export function nextParkingStatus(previous, next) {
  if (next.attending !== YES || next.parking !== "yes") return "not_requested";
  if (
    !previous ||
    previous.answer.attending !== YES ||
    previous.answer.parking !== "yes" ||
    previous.answer.carCount !== next.carCount
  )
    return "pending";
  return ["pending", "approved", "rejected"].includes(previous.parkingStatus)
    ? previous.parkingStatus
    : "pending";
}
export function summarize(records) {
  const result = {
    forms: records.length,
    companies: records.length,
    attendingCompanies: 0,
    confirmedGuests: 0,
    pendingCompanies: 0,
    declinedCompanies: 0,
    requestedCars: 0,
    approvedCars: 0,
    freeCars: CAPACITY,
    drinks: Object.fromEntries(DRINKS.map((v) => [v, 0])),
  };
  for (const { answer, parkingStatus } of records) {
    if (answer.attending === LATER) result.pendingCompanies++;
    else if (answer.attending === NO) result.declinedCompanies++;
    else if (answer.attending === YES) {
      result.attendingCompanies++;
      result.confirmedGuests += answer.guestCount;
      for (const drink of new Set(answer.drinks))
        if (DRINKS.includes(drink)) result.drinks[drink]++;
      if (answer.parking === "yes") {
        result.requestedCars += answer.carCount;
        if (parkingStatus === "approved")
          result.approvedCars += answer.carCount;
      }
    }
  }
  result.freeCars = Math.max(0, CAPACITY - result.approvedCars);
  return result;
}
const labels = {
  name: "Имя",
  attending: "Присутствие",
  guestCount: "Количество гостей",
  additionalGuests: "Остальные гости",
  drinks: "Напитки компании",
  otherDrink: "Свой напиток",
  parking: "Заявка на парковку",
  carCount: "Количество машин",
  message: "Сообщение",
};
export function describeChanges(before, after) {
  const display = (value) => {
    const rendered = String(
      Array.isArray(value) ? value.join(", ") : (value ?? "—"),
    );
    return rendered.length > 160 ? rendered.slice(0, 160) + "…" : rendered;
  };
  return Object.entries(labels)
    .filter(
      ([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map(
      ([key, label]) =>
        `${label}: было ${display(before[key])} → стало ${display(after[key])}`,
    );
}
const csvCell = (value) => {
  let cell = String(value ?? "");
  if (/^[\s]*[=+@-]/u.test(cell) || /^[\t\r\n]/u.test(cell)) cell = "'" + cell;
  return '"' + cell.replaceAll('"', '""') + '"';
};
export function exportCsv(records) {
  // Excel on Windows with Russian locale commonly expects semicolon-delimited CSV.
  // The sep= directive is recognized by Excel; BOM preserves UTF-8 Cyrillic.
  const columns = [
    ["name", "Компания / представитель"],
    ["attending", "Присутствие"],
    ["guestCount", "Количество гостей"],
    ["additionalGuests", "Имена остальных"],
    ["drinks", "Напитки"],
    ["otherDrink", "Другой напиток"],
    ["parking", "Парковка"],
    ["carCount", "Машин запрошено"],
    ["parkingStatus", "Статус парковки"],
    ["message", "Комментарий"],
    ["createdAt", "Дата ответа"],
    ["updatedAt", "Дата изменения"],
    ["id", "ID анкеты"],
    ["revision", "Версия"],
  ];
  const parkingLabels = { yes: "Нужна", no: "Не нужна", unknown: "Пока не знаю" };
  const statusLabels = {
    approved: "Подтверждено",
    pending: "Ожидает решения",
    rejected: "Отклонено",
    not_requested: "Не запрашивалась",
  };
  const fromRow = (row, key) => {
    if (key === "parkingStatus") return statusLabels[row.parkingStatus] ?? row.parkingStatus;
    if (key === "parking") return parkingLabels[row.answer.parking] ?? row.answer.parking ?? "";
    const value = ["id", "createdAt", "updatedAt", "revision"].includes(key)
      ? row[key] : row.answer[key];
    return Array.isArray(value) ? value.join(", ") : value;
  };
  const lines = [
    "sep=;",
    columns.map(([, label]) => csvCell(label)).join(";"),
    ...records.map((row) => columns.map(([key]) => csvCell(fromRow(row, key))).join(";")),
  ];
  return "\ufeff" + lines.join("\r\n");
}
export async function editKeyHash(id, key) {
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id) || !/^[a-zA-Z0-9_-]{43}$/.test(key))
    throw new ValidationError("Invalid credentials");
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${id}:${key}`),
  );
  return [...new Uint8Array(bytes)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifyEditKey(id, key, storedHash) {
  if (!/^[a-f0-9]{64}$/.test(storedHash || "")) return false;
  let actual;
  try {
    actual = await editKeyHash(id, key);
  } catch {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < 64; i++)
    diff |= actual.charCodeAt(i) ^ storedHash.charCodeAt(i);
  return diff === 0;
}
