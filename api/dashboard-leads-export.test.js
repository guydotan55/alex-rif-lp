// Tests the CSV export helpers that live inline in dashboard.html.
// It extracts the ACTUAL csvCell + leadsToCsv source from the file (no duplication)
// and exercises the parts that are easy to get wrong: UTF-8 BOM, RFC-4180 escaping,
// the metadata-key union, array flattening, and CRLF line endings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');

// Pull the two adjacent helper functions out of the inline <script>.
const start = html.indexOf('function csvCell(v) {');
const end = html.indexOf('function downloadCsv(');
assert.ok(start !== -1 && end !== -1 && end > start, 'found csvCell..leadsToCsv block in dashboard.html');
const src = html.slice(start, end);
// eslint-disable-next-line no-new-func
const { csvCell, leadsToCsv } = new Function(src + '\nreturn { csvCell, leadsToCsv };')();

test('output starts with a UTF-8 BOM (Hebrew opens correctly in Excel)', () => {
  const csv = leadsToCsv([{ first_name: 'דנה', email: 'a@b.com', metadata: {} }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'first char is U+FEFF');
});

test('header row is the fixed Hebrew columns, then sorted metadata keys', () => {
  const csv = leadsToCsv([
    { email: 'a@b.com', metadata: { utm_source: 'fb' } },
    { email: 'c@d.com', metadata: { newsletter: true } },
  ]);
  const header = csv.slice(1).split('\r\n')[0]; // drop BOM
  assert.equal(header, 'שם פרטי,שם משפחה,טלפון,מייל,דף נחיתה,תאריך,newsletter,utm_source');
});

test('fixed columns map to the right fields, missing values are blank', () => {
  const csv = leadsToCsv([{ first_name: 'דנה', last_name: 'כהן', phone: '050-1', email: 'a@b.com', landing_page: 'LP', date: '2026-06-24', metadata: {} }]);
  const row = csv.split('\r\n')[1];
  assert.equal(row, 'דנה,כהן,050-1,a@b.com,LP,2026-06-24');
});

test('RFC-4180: commas, quotes, and newlines are quoted/escaped', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('formula-injection: cells starting with = + - @ (or tab/CR) are neutralized with a leading quote', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"', 'neutralized AND quoted (has commas/quotes)');
  // benign values untouched, including phone numbers and plain text
  assert.equal(csvCell('050-1234567'), '050-1234567');
  assert.equal(csvCell('דנה'), 'דנה');
});

test('formula-injection: a malicious metadata KEY (header cell) is also neutralized', () => {
  const csv = leadsToCsv([{ email: 'a@b.com', metadata: { '=cmd': 'x' } }]);
  const header = csv.slice(1).split('\r\n')[0];
  assert.ok(header.includes("'=cmd"), 'header key beginning with = is prefixed');
  assert.ok(!/(^|,)=cmd(,|$)/.test(header), 'no raw =cmd header cell');
});

test('metadata: missing key → empty cell; array → joined with "; "', () => {
  const csv = leadsToCsv([
    { email: 'a@b.com', metadata: { interests: ['music', 'art'] } },
    { email: 'c@d.com', metadata: { note: 'hi' } },
  ]);
  const lines = csv.split('\r\n');
  // header order: fixed cols..., then sorted metadata keys interests, note
  assert.match(lines[0], /,interests,note$/);
  // row 1: only email + interests (joined, no comma so unquoted); note blank → trailing comma
  assert.equal(lines[1], ',,,a@b.com,,,music; art,');
  // row 2: only email + note; interests blank
  assert.equal(lines[2], ',,,c@d.com,,,,hi');
});

test('metadata object value is JSON-stringified', () => {
  const csv = leadsToCsv([{ email: 'a@b.com', metadata: { prefs: { a: 1 } } }]);
  // {"a":1} contains a quote → whole cell quoted with doubled quotes
  assert.ok(csv.split('\r\n')[1].endsWith('"{""a"":1}"'), 'object → quoted JSON');
});

test('rows are CRLF-separated', () => {
  const csv = leadsToCsv([{ email: 'a@b.com', metadata: {} }, { email: 'c@d.com', metadata: {} }]);
  assert.equal(csv.slice(1).split('\r\n').length, 3, 'header + 2 rows');
});

test('a comma in a metadata value does not break column alignment', () => {
  const csv = leadsToCsv([{ email: 'a@b.com', metadata: { city: 'Tel Aviv, IL' } }]);
  const row = csv.split('\r\n')[1];
  assert.ok(row.includes('"Tel Aviv, IL"'), 'value with comma is quoted');
});
