import { describe, expect, it } from 'vitest';
import { csvRow, csvSafeText } from '../../../apps/server/src/exports/csv.js';

describe('CSV export encoder', () => {
  it('uses RFC4180 quoting and makes formula-like spreadsheet cells literal', () => {
    expect(csvRow(['plain', 'a,b', 'say "hi"', 'one\ntwo'])).toBe('plain,"a,b","say ""hi""","one\ntwo"\r\n');
    expect(csvSafeText('=1+1')).toBe("'=1+1");
    expect(csvSafeText('\t +1')).toBe("'\t +1");
    expect(csvSafeText('\u202e-1')).toBe("'\u202e-1");
  });

  it('does not permit NUL to hide a spreadsheet formula and preserves Unicode text', () => {
    expect(csvSafeText('\u0000@cmd')).toBe("'\ufffd@cmd");
    expect(csvRow(['臺灣', '王小明'])).toBe('臺灣,王小明\r\n');
  });

  it('recognizes the full Unicode control/default-ignorable prefix set', () => {
    // DEL, C1, Arabic letter mark, soft hyphen, BOM, and zero-width controls
    // have all been accepted as invisible formula prefixes by spreadsheet apps.
    for (const prefix of ['\u007f', '\u009f', '\u061c', '\u00ad', '\ufeff', '\u200b', '\u200c', '\u200d', '\u2060']) {
      expect(csvSafeText(`${prefix}=SUM(A1:A2)`)).toBe(`'${prefix}=SUM(A1:A2)`);
    }
    expect(csvSafeText('\u200b\ttext')).toBe("'\u200b\ttext");
    expect(csvSafeText('\u061c\r\ntext')).toBe("'\u061c\r\ntext");
    expect(csvSafeText('\u00a0 +1')).toBe("'\u00a0 +1");
    expect(csvSafeText('\u200bvisible')).toBe('\u200bvisible');
  });
});
