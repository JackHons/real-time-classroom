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
});
