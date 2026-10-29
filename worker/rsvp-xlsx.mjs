// Small, self-contained SpreadsheetML writer for Workers (no Node APIs/dependencies).
// Text is always inlineStr, never a formula, hyperlink or external relationship.
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const xlsxColumns = [
  ["name", "Компания / представитель", 30],
  ["attending", "Присутствие", 24],
  ["guestCount", "Количество гостей", 20, "number"],
  ["additionalGuests", "Имена остальных", 36],
  ["drinks", "Напитки", 36],
  ["otherDrink", "Другой напиток", 28],
  ["parking", "Парковка", 20],
  ["carCount", "Машин запрошено", 20, "number"],
  ["parkingStatus", "Статус парковки", 24],
  ["message", "Комментарий", 55],
  ["createdAt", "Дата ответа (МСК)", 23, "date"],
  ["updatedAt", "Дата изменения (МСК)", 23, "date"],
  ["id", "ID анкеты", 38],
  ["revision", "Версия", 12, "number"],
];

function xlsxText(value) {
  // Preserve literal OOXML escape sequences. Strip only invalid XML 1.0 controls.
  return String(value ?? "")
    .replace(/_x[0-9a-f]{4}_/gi, (s) => "_x005F_" + s.slice(1))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#13;");
}

function xlsxDate(value) {
  if (typeof value !== "string") return null;
  // D1 CURRENT_TIMESTAMP is UTC without a suffix; ISO timestamps retain their zone.
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(iso)
  )
    return null;
  const serial = (Date.parse(iso) + 3 * 3600000) / 86400000 + 25569;
  return Number.isFinite(serial) && serial >= 61 && serial < 2958466
    ? serial
    : null;
}

const xlsxCrcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});

function xlsxZip(files) {
  // ZIP "store" method: universally supported, bounded work, no compression runtime.
  const encoder = new TextEncoder(),
    local = [],
    central = [];
  let offset = 0;
  for (const [path, xml] of Object.entries(files)) {
    const name = encoder.encode(path),
      data = encoder.encode(xml);
    let crc = 0xffffffff;
    for (const byte of data)
      crc = (crc >>> 8) ^ xlsxCrcTable[(crc ^ byte) & 255];
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint16(12, 0x21, true); // ZIP date: 1980-01-01, deterministic.
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    const directory = new Uint8Array(46 + name.length),
      d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true);
    d.setUint16(14, 0x21, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, data.length, true);
    d.setUint32(24, data.length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    directory.set(name, 46);
    local.push(header, data);
    central.push(directory);
    offset += header.length + data.length;
  }
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0);
  if (offset + centralSize > 0xffffffff) throw new Error("XLSX_TOO_LARGE");
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const bytes of [...local, ...central, end]) {
    result.set(bytes, position);
    position += bytes.length;
  }
  return result;
}

export function exportXlsx(records) {
  if (records.length > 1048575) throw new Error("XLSX_TOO_MANY_ROWS");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const textCell = (ref, value, style = 0) =>
    '<c r="' +
    ref +
    '" s="' +
    style +
    '" t="inlineStr"><is><t xml:space="preserve">' +
    xlsxText(value) +
    "</t></is></c>";
  const parking = { yes: "Нужна", no: "Не нужна", unknown: "Пока не знаю" };
  const statuses = {
    approved: "Подтверждено",
    pending: "Ожидает решения",
    rejected: "Отклонено",
    not_requested: "Не запрашивалась",
  };
  const rows = [
    '<row r="1" ht="32" customHeight="1">' +
      xlsxColumns
        .map(([, label], i) =>
          textCell(String.fromCharCode(65 + i) + "1", label, 1),
        )
        .join("") +
      "</row>",
  ];
  records.forEach((record, index) => {
    const row = index + 2;
    const cells = xlsxColumns
      .map(([key, , , type], column) => {
        const ref = String.fromCharCode(65 + column) + row;
        // Explicit allowlist: never spread an answer/DB object into the workbook.
        let value = ["id", "createdAt", "updatedAt", "revision"].includes(key)
          ? record[key]
          : record.answer[key];
        if (key === "parking") value = parking[value] ?? value;
        if (key === "parkingStatus")
          value = statuses[record.parkingStatus] ?? record.parkingStatus;
        if (Array.isArray(value)) value = value.join(", ");
        const numeric =
          type === "date"
            ? xlsxDate(value)
            : type === "number" &&
                typeof value === "number" &&
                Number.isFinite(value)
              ? value
              : null;
        if (numeric !== null)
          return (
            '<c r="' +
            ref +
            '" s="' +
            (type === "date" ? 2 : 0) +
            '" t="n"><v>' +
            numeric +
            "</v></c>"
          );
        return textCell(ref, value);
      })
      .join("");
    rows.push('<row r="' + row + '">' + cells + "</row>");
  });
  const range = "A1:N" + (records.length + 1);
  return xlsxZip({
    "[Content_Types].xml":
      xml +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels":
      xml +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' +
      rel +
      '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      xml +
      '<workbook xmlns="' +
      ns +
      '" xmlns:r="' +
      rel +
      '"><workbookPr date1904="0"/><bookViews><workbookView/></bookViews><sheets><sheet name="Анкеты" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      xml +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' +
      rel +
      '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' +
      rel +
      '/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml":
      xml +
      '<styleSheet xmlns="' +
      ns +
      '"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF335C73"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    "xl/worksheets/sheet1.xml":
      xml +
      '<worksheet xmlns="' +
      ns +
      '"><dimension ref="' +
      range +
      '"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>' +
      xlsxColumns
        .map(
          ([, , width], i) =>
            '<col min="' +
            (i + 1) +
            '" max="' +
            (i + 1) +
            '" width="' +
            width +
            '" customWidth="1"/>',
        )
        .join("") +
      "</cols><sheetData>" +
      rows.join("") +
      '</sheetData><autoFilter ref="' +
      range +
      '"/></worksheet>',
  });
}
