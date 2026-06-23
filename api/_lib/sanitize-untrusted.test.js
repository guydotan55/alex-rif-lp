import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUntrusted } from './sanitize-untrusted.js';

test('strips HTML comments', () => {
  assert.equal(sanitizeUntrusted('before<!-- evil -->after'), 'beforeafter');
  assert.equal(sanitizeUntrusted('a<!--\nmulti\nline\n-->b'), 'ab');
});

test('strips bidi embedding/override controls (U+202A–U+202E)', () => {
  assert.equal(sanitizeUntrusted('a‮evil‬b'), 'aevilb'); // RLO + PDF
  assert.equal(sanitizeUntrusted('‪‫‭ x'), ' x');   // LRE RLE LRO
});

test('strips bidi isolates (U+2066–U+2069)', () => {
  assert.equal(sanitizeUntrusted('x⁦y⁩z'), 'xyz'); // LRI ... PDI
});

test('strips zero-width chars and BOM', () => {
  assert.equal(sanitizeUntrusted('a​b‌‍c﻿d'), 'abcd');
});

test('keeps Hebrew text and legitimate RLM/LRM marks', () => {
  assert.equal(sanitizeUntrusted('שלום עולם'), 'שלום עולם');
  // RLM (U+200F) and LRM (U+200E) are legitimate in RTL text — must survive.
  assert.equal(sanitizeUntrusted('‏שלום‎'), '‏שלום‎');
});

test('null/undefined/empty → empty string', () => {
  assert.equal(sanitizeUntrusted(null), '');
  assert.equal(sanitizeUntrusted(undefined), '');
  assert.equal(sanitizeUntrusted(''), '');
});

test('clean string is unchanged', () => {
  assert.equal(sanitizeUntrusted('Just normal text 123.'), 'Just normal text 123.');
});
