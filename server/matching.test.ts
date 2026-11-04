import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Invoice } from './domain';
import type { InvoiceMatchResult, MatchCandidate } from './banksapi';
import { addDays, bookingDate, isSafeToAutoBook, paymentNote, toExtractedInvoice, topMatch } from './matching';

const invoice: Invoice = {
  id: 1,
  number: 'RE-2026-0101',
  customer_id: 3,
  customer_name: 'Kanzlei Berger & Partner',
  customer_number: 'K-10003',
  issue_date: '2026-09-01',
  due_date: '2026-09-15',
  amount_cents: 476_000,
  paid_cents: 200_000,
  open_cents: 276_000,
  status: 'teilbezahlt',
  description: 'Relaunch Website',
};

const exact: MatchCandidate = {
  confidence: 1,
  delta: 0,
  matchType: 'exact',
  transaction: { id: 'tx-1', productId: 'DE89370400440532013000' },
};
const matched: InvoiceMatchResult = { status: 'matched', matches: [exact] };

test('toExtractedInvoice vergleicht den offenen Betrag und übergibt die Kunden-IBAN als BT-91', () => {
  const x = toExtractedInvoice(invoice, 'DE89370400440532013000', 'Muster Design GmbH');
  assert.equal(x.amountDueForPayment, 2760);
  assert.equal(x.invoiceTotalAmountWithVat, 4760);
  assert.equal(x.debitedAccountIdentifier, 'DE89370400440532013000');
  assert.equal(x.sellerName, 'Muster Design GmbH');
  assert.equal(x.buyerName, 'Kanzlei Berger & Partner');
  assert.equal(x.invoiceCurrencyCode, 'EUR');
});

test('toExtractedInvoice lässt die IBAN weg, wenn der Kunde keine hat', () => {
  assert.ok(!('debitedAccountIdentifier' in toExtractedInvoice(invoice, null, 'X')));
});

test('topMatch ignoriert unmatched und extraction_failed', () => {
  assert.equal(topMatch({ status: 'unmatched', matches: [exact] }), null);
  assert.equal(topMatch({ status: 'extraction_failed' }), null);
  assert.equal(topMatch(undefined), null);
  assert.equal(topMatch(matched), exact);
});

test('automatisch verbucht wird nur ein exakter Treffer über den vollen offenen Betrag', () => {
  assert.equal(isSafeToAutoBook(matched, exact, invoice, 276_000), true);
});

test('keine automatische Buchung bei Teilzahlung, Überzahlung, Skonto, Sammelüberweisung oder schwachem Treffer', () => {
  assert.equal(isSafeToAutoBook(matched, exact, invoice, 100_000), false, 'Betrag weicht ab');
  assert.equal(isSafeToAutoBook(matched, exact, invoice, 300_000), false, 'Betrag höher');
  assert.equal(isSafeToAutoBook({ status: 'likely_matched', matches: [exact] }, exact, invoice, 276_000), false);
  assert.equal(isSafeToAutoBook({ status: 'partially_matched', matches: [exact] }, exact, invoice, 276_000), false);
  for (const matchType of ['strong', 'reference_only', 'amount_only', 'skonto', 'partial', 'fuzzy', 'possible_batch'] as const) {
    assert.equal(isSafeToAutoBook(matched, { ...exact, matchType }, invoice, 276_000), false, matchType);
  }
  assert.equal(isSafeToAutoBook(matched, { ...exact, confidence: 0.8 }, invoice, 276_000), false);
  assert.equal(isSafeToAutoBook(matched, { ...exact, delta: 0.01 }, invoice, 276_000), false);
  assert.equal(isSafeToAutoBook(matched, exact, invoice, -276_000), false, 'Abgang');
});

test('Datums- und Notizhelfer', () => {
  assert.equal(bookingDate('2026-03-02 00:00:00'), '2026-03-02');
  assert.equal(addDays('2026-03-01', -61), '2025-12-30');
  const note = paymentNote({ gegenkontoInhaber: 'Berger', verwendungszweck: 'RE-2026-0101   Abschlag\n2' }, exact);
  assert.equal(note, 'Bankumsatz von Berger: RE-2026-0101 Abschlag 2 (Zuordnung exact, 100 %)');
});
