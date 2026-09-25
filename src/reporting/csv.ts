/**
 * Deterministic, RFC 4180-compatible CSV serialization for the bounded Phase 2Q-C exports.
 *
 * Rules (documented in docs/reporting/reporting-core.md):
 *  - UTF-8, records separated by CRLF, with a trailing CRLF after the final record.
 *  - A field is quoted (double quotes, internal quotes doubled) exactly when it contains a comma, a double
 *    quote, CR, or LF. Numeric cells are emitted verbatim and are never quoted or neutralized.
 *  - Spreadsheet formula-injection defense: any STRING cell whose first character is one of = + - @, TAB,
 *    or CR is prefixed with a single quote (') so a spreadsheet treats it as text, never a formula. This
 *    applies to string columns only — genuine numeric columns (which may legitimately start with '-') keep
 *    their exact value.
 */

/** Characters that begin a spreadsheet formula (or a lead-in that some spreadsheets coerce into one). */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Neutralizes a string cell against spreadsheet formula injection by prefixing a literal single quote. */
export function neutralizeCsvString(value: string): string {
  if (value.length > 0 && FORMULA_LEAD.has(value[0]!)) {
    return `'${value}`;
  }
  return value;
}

/** Quotes a already-neutralized field per RFC 4180 only when it contains a delimiter/quote/newline. */
function quoteField(value: string): string {
  if (/[",\r\n]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** A CSV cell: either a raw number (emitted verbatim) or a string (neutralized, then quoted as needed). */
export type CsvCell = { kind: "number"; value: number } | { kind: "string"; value: string };

/** Renders one cell. Numbers pass through untouched; strings are neutralized and then RFC 4180 quoted. */
function renderCell(cell: CsvCell): string {
  if (cell.kind === "number") {
    return String(cell.value);
  }
  return quoteField(neutralizeCsvString(cell.value));
}

/**
 * Serializes a header row plus body rows to a deterministic CSV document. Headers are treated as plain
 * text (quoted only if they contain delimiters); body cells carry their own string/number kind so numeric
 * columns are never neutralized.
 */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  const lines: string[] = [headers.map((header) => quoteField(header)).join(",")];
  for (const row of rows) {
    lines.push(row.map(renderCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
