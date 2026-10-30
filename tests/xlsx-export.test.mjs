import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exportXlsx, XLSX_MIME } from "../worker/rsvp-xlsx.mjs";
import { readXlsxParts } from "./xlsx-reader.mjs";

const sample = (fields = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  revision: 4,
  createdAt: "2026-10-29 21:15:00",
  updatedAt: "2026-10-30T00:15:00+03:00",
  parkingStatus: "pending",
  editKey: "MUST_NOT_EXPORT_KEY",
  edit_token_hash: "MUST_NOT_EXPORT_HASH",
  extraAnswers: { secret: "MUST_NOT_EXPORT_EXTRA" },
  answer: {
    name: "Соня и Лёша",
    attending: "Да, конечно!",
    guestCount: 3,
    additionalGuests: "Оля; Петя",
    drinks: ["Виски", "Ром"],
    otherDrink: "Сидр",
    parking: "yes",
    carCount: 2,
    message: 'Привет <&> "всем"\nДо встречи!',
    ...fields,
  },
});

test("XLSX is a real OOXML ZIP: Russian headers, numeric counts/dates, widths, no secrets", () => {
  const bytes = exportXlsx([sample()]);
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString("hex"), "504b0304");
  assert.equal(
    XLSX_MIME,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const parts = readXlsxParts(bytes),
    sheet = parts["xl/worksheets/sheet1.xml"];
  assert.equal(Object.keys(parts).length, 6);
  assert.ok(
    parts["[Content_Types].xml"].includes("spreadsheetml.sheet.main+xml"),
  );
  assert.ok(
    sheet.includes("Компания / представитель") &&
      sheet.includes("Дата ответа (МСК)"),
  );
  assert.ok(sheet.includes("Соня и Лёша") && sheet.includes("Виски, Ром"));
  assert.match(sheet, /<c r="C2" s="0" t="n"><v>3<\/v><\/c>/);
  assert.match(sheet, /<c r="H2" s="0" t="n"><v>2<\/v><\/c>/);
  const created = Number(sheet.match(/<c r="K2" s="2" t="n"><v>([^<]+)/)[1]);
  const updated = Number(sheet.match(/<c r="L2" s="2" t="n"><v>([^<]+)/)[1]);
  assert.ok(
    Math.abs(created - (Date.UTC(2026, 9, 30, 0, 15) / 86400000 + 25569)) <
      1e-8,
  );
  assert.equal(created, updated);
  assert.ok(parts["xl/styles.xml"].includes('formatCode="dd.mm.yyyy hh:mm"'));
  assert.equal((sheet.match(/<col /g) || []).length, 14);
  assert.equal((sheet.match(/<row /g) || []).length, 2);
  assert.ok(!Object.values(parts).join("").includes("MUST_NOT_EXPORT"));
});

test("User strings stay literal text: formulas, DDE, links, XML and OOXML escapes", () => {
  const values = [
    '=HYPERLINK("https://evil.test","x")',
    "+SUM(1,1)",
    "-1+2",
    "@SUM(A1)",
    "\t=CMD()",
    "\r=1+1",
    "'text",
    '"><f>1+1</f>',
    "_x0041_",
    "Кириллица 😀\u0001",
  ];
  for (const value of values) {
    const parts = readXlsxParts(
      exportXlsx([sample({ name: value, otherDrink: value, message: value })]),
    );
    const sheet = parts["xl/worksheets/sheet1.xml"];
    assert.match(sheet, /<c r="A2" s="0" t="inlineStr">/);
    assert.match(sheet, /<c r="F2" s="0" t="inlineStr">/);
    assert.match(sheet, /<c r="J2" s="0" t="inlineStr">/);
    assert.ok(!sheet.includes("<f>") && !sheet.includes("<hyperlink"));
    assert.ok(
      !Object.keys(parts).some((name) =>
        /external|vba|connections/i.test(name),
      ),
    );
    assert.ok(!Object.values(parts).join("").includes('TargetMode="External"'));
    assert.ok(!sheet.includes("\u0001"));
  }
});

test("Empty export is readable; all 1600 records exported; missing/invalid dates remain safe text", () => {
  const empty = readXlsxParts(exportXlsx([]))["xl/worksheets/sheet1.xml"];
  assert.ok(empty.includes('dimension ref="A1:N1"'));
  const records = Array.from({ length: 1600 }, (_, i) => ({
    ...sample(),
    id: String(i),
  }));
  const sheet = readXlsxParts(exportXlsx(records))["xl/worksheets/sheet1.xml"];
  assert.equal((sheet.match(/<row /g) || []).length, 1601);
  const invalid = sample();
  invalid.createdAt = null;
  invalid.updatedAt = "=1+1";
  const xml = readXlsxParts(exportXlsx([invalid]))["xl/worksheets/sheet1.xml"];
  assert.match(xml, /<c r="L2" s="0" t="inlineStr">/);
  assert.ok(!xml.includes("NaN") && !xml.includes("<f>"));
});

test("Python standard ZIP/XML parsers validate CRCs and every package part independently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-xlsx-"));
  try {
    const file = path.join(directory, "sample.xlsx");
    fs.writeFileSync(file, exportXlsx([sample()]));
    const result = spawnSync("python", ["tests/verify-xlsx.py", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
