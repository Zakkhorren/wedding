import test from "node:test";
import assert from "node:assert/strict";
import { exportCsv } from "../worker/rsvp-policy.mjs";
function parse(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ";" && !quoted) {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  assert.equal(quoted, false);
  return rows;
}
test("Excel CSV bytes and parsed 14 columns preserve Cyrillic, delimiters, multiline and neutralize formulas", () => {
  const message = 'Строка; "кавычки"\r\nВторая строка';
  const csv = exportCsv([
    {
      id: "id",
      revision: 3,
      createdAt: "2026",
      updatedAt: "2027",
      parkingStatus: "pending",
      editKey: "SECRET",
      answer: {
        name: '=HYPERLINK("bad")',
        attending: "Да, конечно!",
        guestCount: 4,
        additionalGuests: "Соня; Лёша",
        drinks: ["Виски", "Ром"],
        otherDrink: "+cmd",
        parking: "yes",
        carCount: 2,
        message,
      },
    },
  ]);
  assert.deepEqual([...Buffer.from(csv).subarray(0, 3)], [239, 187, 191]);
  assert.ok(csv.startsWith("\ufeffsep=;\r\n"));
  const rows = parse(csv.slice(8));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 14);
  assert.equal(rows[1].length, 14);
  assert.equal(rows[1][0], '\'=HYPERLINK("bad")');
  assert.equal(rows[1][3], "Соня; Лёша");
  assert.equal(rows[1][5], "'+cmd");
  assert.equal(rows[1][9], message);
  assert.ok(!csv.includes("SECRET"));
});
