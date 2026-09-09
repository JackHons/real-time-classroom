/** RFC 4180 output plus a spreadsheet-formula safety boundary. */
export function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

function csvField(value: string): string {
  const sanitized = csvSafeText(value);
  return /[",\r\n]/.test(sanitized) ? `"${sanitized.replaceAll('"', '""')}"` : sanitized;
}

export function csvSafeText(value: string): string {
  // Importers may discard Unicode controls, format characters, or whitespace
  // before deciding whether a cell is a formula. Check the original input so
  // replacing NUL cannot turn a dangerous prefix into an injection bypass.
  const dangerous = hasFormulaPrefix(value);
  const withoutNul = value.replaceAll('\u0000', '\ufffd');
  return dangerous ? `'${withoutNul}` : withoutNul;
}

function hasFormulaPrefix(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) return false;
    // Tabs and line breaks are formula-leading characters in spreadsheet
    // importers, rather than harmless whitespace. They must be handled before
    // the broader Cc/White_Space prefix check below.
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
    const character = String.fromCodePoint(codePoint);
    if (character === '=' || character === '+' || character === '-' || character === '@') return true;
    if (!isSpreadsheetIgnorablePrefix(character)) return false;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return false;
}

function isSpreadsheetIgnorablePrefix(character: string): boolean {
  // Cc includes DEL/C1 controls; Cf covers U+061C, soft hyphen, BOM and the
  // zero-width/bidi controls. Default_Ignorable_Code_Point catches the less
  // obvious Unicode variants which are not all Cf. Keep the original visible
  // text in the CSV; the leading apostrophe is the spreadsheet safety boundary.
  return /^(?:\p{White_Space}|\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point})$/u.test(character);
}
