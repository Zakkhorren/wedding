import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

// Independent ZIP reader for tests: follow the central directory, not writer offsets.
export function readXlsxParts(input) {
  const bytes = Buffer.from(input);
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const parts = {};
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameSize)
      .toString("utf8");
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const dataStart =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.ok(method === 0 || method === 8);
    parts[name] = (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    cursor +=
      46 +
      nameSize +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return parts;
}
