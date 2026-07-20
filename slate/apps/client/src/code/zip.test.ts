import { describe, it, expect } from 'vitest';
import { buildZip, crc32 } from './zip';

const enc = new TextEncoder();

describe('zip', () => {
  it('crc32 matches the standard test vector', () => {
    // The canonical CRC-32 check value: crc32("123456789") = 0xCBF43926.
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  it('produces a structurally valid archive', () => {
    const a = enc.encode('hello\n');
    const b = enc.encode('const x = 1;\n');
    const zip = buildZip(
      [
        { name: 'readme.txt', data: a },
        { name: 'src/main.js', data: b },
      ],
      new Date(2026, 6, 19, 12, 0, 0),
    );
    const view = new DataView(zip.buffer);

    // Local header signatures at the expected offsets.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const entry1Len = 30 + 'readme.txt'.length + a.length;
    expect(view.getUint32(entry1Len, true)).toBe(0x04034b50);

    // EOCD at the tail: entry count + central directory offset are coherent.
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2); // total entries
    const centralOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    const centralSize = view.getUint32(eocd + 12, true);
    expect(centralOffset + centralSize + 22).toBe(zip.length);

    // Stored data is byte-for-byte present after each header+name.
    const data1 = zip.slice(30 + 'readme.txt'.length, 30 + 'readme.txt'.length + a.length);
    expect([...data1]).toEqual([...a]);

    // CRC recorded in the first local header matches the content.
    expect(view.getUint32(14, true)).toBe(crc32(a));
  });
});
