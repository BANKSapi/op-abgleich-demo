import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InvoiceMatchResult, MatchCandidate } from './banksapi';
import { withStatus, type Invoice } from './domain';
import { pairKey, planReconciliation, toExtractedInvoice, type TransactionWithBookings } from './matching';

function invoice(id: number, amountCents: number, paidCents = 0): Invoice {
  return withStatus(
    {
      id,
      number: `RE-2026-${String(id).padStart(4, '0')}`,
      customer_id: 1,
      customer_name: 'Café Lindenblüte',
      customer_number: 'K-10002',
      issue_date: '2026-10-01',
      due_date: '2026-10-15',
      amount_cents: amountCents,
      paid_cents: paidCents,
      description: '',
    },
    '2026-10-10',
  );
}

function tx(id: string, amountCents: number, bookedCents = 0): TransactionWithBookings {
  return {
    access_id: 'acc',
    product_id: 'DE89370400440532013000',
    id,
    booked_on: '2026-10-12',
    amount_cents: amountCents,
    booked_cents: bookedCents,
    counterparty_name: 'Café Lindenblüte',
    counterparty_iban: 'DE12500105170648489890',
    purpose: 'RE-2026-0001',
  };
}

function candidate(id: string, overrides: Partial<MatchCandidate> = {}, amountMatch = 'exact'): MatchCandidate {
  return {
    confidence: 1,
    delta: 0,
    matchType: 'exact',
    notes: [],
    signals: { amountMatch: amountMatch as MatchCandidate['signals']['amountMatch'] },
    transaction: { id, productId: 'DE89370400440532013000' },
    ...overrides,
  };
}

const plan = (invoices: Invoice[], results: InvoiceMatchResult[], transactions: TransactionWithBookings[], rejected = new Set<string>()) =>
  planReconciliation({ invoices, results, transactions, rejected, autoBookConfidence: 0.95 });

test('Rechnung wird mit offenem Betrag und Kunden-IBAN an AI/Connect übergeben', () => {
  const extracted = toExtractedInvoice(invoice(1, 476_000, 200_000), { customer_number: 'K-10003', iban: 'DE89370400440532013000' }, 'Muster Design GmbH');
  assert.equal(extracted.amountDueForPayment, 2760);
  assert.equal(extracted.invoiceTotalAmountWithVat, 4760);
  assert.equal(extracted.debitedAccountIdentifier, 'DE89370400440532013000');
  assert.equal(extracted.buyerIdentifier, 'K-10003');
  assert.equal(extracted.sellerName, 'Muster Design GmbH');

  const withoutIban = toExtractedInvoice(invoice(1, 100), { customer_number: 'K-10007', iban: null }, 'X');
  assert.ok(!('debitedAccountIdentifier' in withoutIban));
});

test('Eindeutiger Treffer wird automatisch gebucht', () => {
  const result = plan([invoice(1, 11_900)], [{ status: 'matched', matches: [candidate('t1')] }], [tx('t1', 11_900)]);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].amount_cents, 11_900);
  assert.equal(result.suggestions.length, 0);
});

test('Unsichere oder unvollständige Treffer werden nur vorgeschlagen', () => {
  const cases: [string, InvoiceMatchResult, TransactionWithBookings][] = [
    ['nur Betrag', { status: 'matched', matches: [candidate('t1', { matchType: 'amount_only', confidence: 0.75 })] }, tx('t1', 11_900)],
    ['geringe Konfidenz', { status: 'matched', matches: [candidate('t1', { confidence: 0.9 })] }, tx('t1', 11_900)],
    ['wahrscheinlich', { status: 'likely_matched', matches: [candidate('t1')] }, tx('t1', 11_900)],
    ['Skonto', { status: 'matched', matches: [candidate('t1', { matchType: 'skonto', delta: -238 }, 'skonto')] }, tx('t1', 11_662)],
    ['Gebühr', { status: 'matched', matches: [candidate('t1', { matchType: 'exact', delta: -5 }, 'close')] }, tx('t1', 11_895)],
    ['Sammelüberweisung', { status: 'possible_batch', matches: [candidate('t1', { matchType: 'possible_batch' }, 'over')] }, tx('t1', 30_000)],
  ];
  for (const [label, result, transaction] of cases) {
    const p = plan([invoice(1, 11_900)], [result], [transaction]);
    assert.equal(p.bookings.length, 0, label);
    assert.equal(p.suggestions.length, 1, label);
    assert.equal(p.suggestions[0].amount_cents, Math.min(11_900, transaction.amount_cents), label);
  }
});

test('Teilweise verbuchter Zahlungseingang wird nicht automatisch erneut gebucht', () => {
  const p = plan([invoice(1, 11_900)], [{ status: 'matched', matches: [candidate('t1')] }], [tx('t1', 11_900, 5_000)]);
  assert.equal(p.bookings.length, 0);
  assert.equal(p.suggestions[0].amount_cents, 6_900);
});

test('Teilzahlungen: alle Raten bis zum offenen Betrag vorschlagen', () => {
  const p = plan(
    [invoice(1, 10_000)],
    [
      {
        status: 'partially_matched',
        matches: [candidate('t1', { matchType: 'partial' }, 'partial'), candidate('t2', { matchType: 'partial' }, 'partial')],
      },
    ],
    [tx('t1', 4_000), tx('t2', 8_000)],
  );
  assert.deepEqual(
    p.suggestions.map((s) => [s.transaction_id, s.amount_cents]),
    [
      ['t1', 4_000],
      ['t2', 6_000],
    ],
  );
});

test('Abgelehnte Zuordnungen und unbekannte Umsätze werden übergangen', () => {
  const rejected = new Set([pairKey(1, 'acc', 'DE89370400440532013000', 't1')]);
  const p = plan(
    [invoice(1, 11_900), invoice(2, 5_000)],
    [
      { status: 'matched', matches: [candidate('t1'), candidate('t2', { matchType: 'amount_only', confidence: 0.6 })] },
      { status: 'matched', matches: [candidate('unbekannt')] },
    ],
    [tx('t1', 11_900), tx('t2', 11_900)],
    rejected,
  );
  // Nach Ablehnung des besten Treffers wird der nächste nur vorgeschlagen, nie gebucht
  assert.equal(p.bookings.length, 0);
  assert.deepEqual(p.suggestions.map((s) => [s.invoice_id, s.transaction_id]), [[1, 't2']]);
  assert.deepEqual(p.unmatched, [2]);
});

test('Ein Zahlungseingang wird nicht doppelt automatisch gebucht', () => {
  const p = plan(
    [invoice(1, 11_900), invoice(2, 11_900)],
    [
      { status: 'matched', matches: [candidate('t1')] },
      { status: 'matched', matches: [candidate('t1')] },
    ],
    [tx('t1', 11_900)],
  );
  assert.equal(p.bookings.length, 1);
  assert.deepEqual(p.unmatched, [2]);
});

test('Nicht auswertbare Rechnungen werden gemeldet', () => {
  const p = plan([invoice(1, 100)], [{ status: 'extraction_failed', error: 'kaputt', matches: [] }], []);
  assert.deepEqual(p.failed, [{ invoice_id: 1, error: 'kaputt' }]);
});
