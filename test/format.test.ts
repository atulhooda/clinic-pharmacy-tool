// Display helpers for stock and money (06a §5, §14): integer formatting only, packs beside base units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtPaise } from '../lib/money';
import { dmy, istDateTime, packs, unitWord } from '../components/stock/format';

test('fmtPaise: rupees with Indian grouping and two decimals, from integer paise only', () => {
  assert.equal(fmtPaise(4500), '₹45.00');
  assert.equal(fmtPaise(5), '₹0.05');
  assert.equal(fmtPaise(0), '₹0.00');
  assert.equal(fmtPaise(99999), '₹999.99');
  assert.equal(fmtPaise(100000), '₹1,000.00');
  assert.equal(fmtPaise(12345678), '₹1,23,456.78');
  assert.equal(fmtPaise(123456789012), '₹1,23,45,67,890.12');
  assert.equal(fmtPaise(-150), '−₹1.50');
  assert.throws(() => fmtPaise(1.5), RangeError);
  assert.throws(() => fmtPaise(2 ** 53), RangeError);
});

test('packs: base units with the largest pack that fits alongside; plurals', () => {
  const strip = [{ name: 'tablet', baseUnitsPerUnit: 1, isBase: true, active: true }, { name: 'strip', baseUnitsPerUnit: 15, isBase: false, active: true }];
  assert.equal(packs(46, 'TABLET', strip), '3 strips + 1 tablet');
  assert.equal(packs(30, 'TABLET', strip), '2 strips');
  assert.equal(packs(15, 'TABLET', strip), '1 strip');
  assert.equal(packs(7, 'TABLET', strip), '7 tablets');
  assert.equal(packs(0, 'TABLET', strip), '0 tablets');
  const boxes = [{ name: 'box', baseUnitsPerUnit: 100, isBase: false, active: true }, { name: 'old box', baseUnitsPerUnit: 200, isBase: false, active: false }];
  assert.equal(packs(250, 'PIECE', boxes), '2 boxes + 50 pieces', 'an inactive pack is not used');
  assert.equal(packs(60, 'G'), '60 g');
  assert.equal(unitWord(1, 'ML'), '1 ml');
});

test('IST display: DD-MM-YYYY HH:mm, and the day turns at 18:30 UTC', () => {
  assert.equal(istDateTime('2026-10-07T18:29:00Z'), '07-10-2026 23:59');
  assert.equal(istDateTime('2026-10-07T18:30:00Z'), '08-10-2026 00:00');
  assert.equal(dmy('2027-03-31'), '31-03-2027');
});
