import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceStatus, parseAmount, isIsoDate } from './domain';

test('Status einer Rechnung', () => {
  assert.equal(invoiceStatus(10_000, 0, '2026-12-01', '2026-11-01'), 'offen');
  assert.equal(invoiceStatus(10_000, 4_000, '2026-12-01', '2026-11-01'), 'teilbezahlt');
  assert.equal(invoiceStatus(10_000, 4_000, '2026-10-01', '2026-11-01'), 'ueberfaellig');
  assert.equal(invoiceStatus(10_000, 10_000, '2026-10-01', '2026-11-01'), 'bezahlt');
  assert.equal(invoiceStatus(10_000, 12_000, '2026-12-01', '2026-11-01'), 'bezahlt');
});

test('Beträge einlesen', () => {
  assert.equal(parseAmount('1.234,56'), 123_456);
  assert.equal(parseAmount('1234.56'), 123_456);
  assert.equal(parseAmount('99 €'), 9_900);
  assert.equal(parseAmount(12.3), 1_230);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('-5'), null);
});

test('Datumsformat', () => {
  assert.ok(isIsoDate('2026-11-04'));
  assert.ok(!isIsoDate('04.11.2026'));
  assert.ok(!isIsoDate(20261104));
});
