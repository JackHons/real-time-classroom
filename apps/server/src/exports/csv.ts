/** RFC 4180 output plus a spreadsheet-formula safety boundary. */
export function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

function csvField(value: string): string {
  const sanitized = csvSafeText(value);
  return /[",\r\n]/.test(sanitized) ? `"${sanitized.replaceAll('"', '""')}"` : sanitized;
}

export function csvSafeText(value: string): string {
  // Importers accept formulas after whitespace, controls, or bidi marks.
  // Check before replacing NUL so NUL cannot become an injection bypass.
  const dangerous = hasFormulaPrefix(value);
  const withoutNul = value.replaceAll('\u0000', '\ufffd');
  return dangerous ? `'${withoutNul}` : withoutNul;
}

function hasFormulaPrefix(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined || !isSpreadsheetIgnorablePrefix(codePoint)) break;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  const first = value[offset];
  return first === '=' || first === '+' || first === '-' || first === '@';
}

function isSpreadsheetIgnorablePrefix(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 0x20) || codePoint === 0x00a0 || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200f) || (codePoint >= 0x2028 && codePoint <= 0x202e)
    || codePoint === 0x205f || codePoint === 0x2060 || (codePoint >= 0x2066 && codePoint <= 0x2069) || codePoint === 0x3000;
}
