import { describe, expect, it } from "vitest";

import { neutralizeCsvString, toCsv, type CsvCell } from "../../src/reporting/csv";

const s = (value: string): CsvCell => ({ kind: "string", value });
const n = (value: number): CsvCell => ({ kind: "number", value });

describe("CSV serialization (RFC 4180 + formula-injection safety)", () => {
  it("emits CRLF-separated records with a trailing CRLF and unquoted plain fields", () => {
    expect(toCsv(["a", "b"], [[s("x"), n(1)]])).toBe("a,b\r\nx,1\r\n");
  });

  it("quotes and escapes fields containing commas, quotes, or newlines", () => {
    expect(toCsv(["name"], [[s("a,b")]])).toBe('name\r\n"a,b"\r\n');
    expect(toCsv(["name"], [[s('a"b')]])).toBe('name\r\n"a""b"\r\n');
    expect(toCsv(["name"], [[s("a\nb")]])).toBe('name\r\n"a\nb"\r\n');
    expect(toCsv(["name"], [[s("a\r\nb")]])).toBe('name\r\n"a\r\nb"\r\n');
  });

  it("neutralizes string cells that begin with = + - @ (and TAB/CR) against formula injection", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(neutralizeCsvString(`${lead}cmd`)).toBe(`'${lead}cmd`);
    }
    // A formula that also needs quoting is neutralized THEN quoted.
    expect(toCsv(["c"], [[s("=1+2,3")]])).toBe('c\r\n"\'=1+2,3"\r\n');
    // Ordinary text is untouched.
    expect(neutralizeCsvString("Tee")).toBe("Tee");
  });

  it("never neutralizes numeric cells, including legitimate negatives", () => {
    // A negative quantity delta stays an exact number, not a quoted/neutralized string.
    expect(toCsv(["delta"], [[n(-2)]])).toBe("delta\r\n-2\r\n");
  });

  it("is deterministic for the same input", () => {
    const rows = [
      [s("p1"), s("Tee"), n(2)],
      [s("p2"), s("Cap"), n(5)],
    ];
    expect(toCsv(["id", "name", "qty"], rows)).toBe(toCsv(["id", "name", "qty"], rows));
  });
});
