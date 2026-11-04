import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InvoiceMatchResult, MatchCandidate } from './banksapi';
import { withStatus, type Invoice } from './domain';
import { decide, dismissalKey, excludedTransactions, toBankTransaction, toExtractedInvoice, txKey, type BankTransaction } from './reconcile';

const IBAN = 'DE89370400440532013000';

function invoice(id: number, amountCents: number, paidCents = 0): Invoice {
  return withStatus(
    {
      id,
      number: `RE-2026-${String(id).padStart(4, '0')}`,
      customer_id: 1,
      customer_name: 'Weber Elektrotechnik KG',
      customer_number: 'K-10004',
      issue_date: '2026-10-01',
      due_date: '2026-10-15',
      amount_cents: amountCents,
      paid_cents: paidCents,
      description: '',
    },
    '2026-11-04',
  );
}

function tx(id: string, amountCents: number): BankTransaction {
  return { accessId: 'a1', productId: IBAN, id, bookedOn: '2026-10-10', amountCents, counterparty: 'Weber', counterpartyIban: '', purpose: '' };
}

function candidate(id: string, confidence: number, matchType = 'exact', delta = 0): MatchCandidate {
  return { confidence, delta, matchType, notes: [], transaction: { id, productId: IBAN } };
}

const txs = (...list: BankTransaction[]) => new Map(list.map((t) => [txKey(t.productId, t.id), t]));

test('sicherer, centgenauer Treffer wird automatisch gebucht', () => {
  const result: InvoiceMatchResult = { status: 'matched', matches: [candidate('t1', 1)] };
  const { decisions, unmatched } = decide([invoice(1, 154_700)], [result], txs(tx('t1', 154_700)), new Map(), new Set());
  assert.equal(unmatched, 0);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'book');
  assert.equal(decisions[0].amountCents, 154_700);
});

test('Teilzahlung bereits erfasst: Abgleich gegen den offenen Restbetrag', () => {
  const inv = invoice(1, 476_000, 200_000);
  assert.equal(toExtractedInvoice(inv, 'Muster Design GmbH', null).amountDueForPayment, 2_760);
  const result: InvoiceMatchResult = { status: 'matched', matches: [candidate('t1', 1)] };
  const { decisions } = decide([inv], [result], txs(tx('t1', 276_000)), new Map(), new Set());
  assert.equal(decisions[0].kind, 'book');
  assert.equal(decisions[0].amountCents, 276_000);
});

test('unsichere Treffer, Skonto und Mehrdeutigkeit werden nur vorgeschlagen', () => {
  const cases: [InvoiceMatchResult, BankTransaction][] = [
    [{ status: 'likely_matched', matches: [candidate('t1', 0.75, 'amount_only')] }, tx('t1', 100_000)],
    [{ status: 'matched', matches: [candidate('t1', 0.9)] }, tx('t1', 100_000)],
    [{ status: 'matched', matches: [candidate('t1', 1, 'skonto', -20)] }, tx('t1', 98_000)],
    [{ status: 'matched', matches: [candidate('t1', 1), candidate('t2', 0.95)] }, tx('t1', 100_000)],
  ];
  for (const [result, t] of cases) {
    const { decisions } = decide([invoice(1, 100_000)], [result], txs(t, tx('t2', 100_000)), new Map(), new Set());
    assert.equal(decisions.length, 1, result.status);
    assert.equal(decisions[0].kind, 'propose', `${result.status} ${result.matches?.[0].matchType}`);
    assert.equal(decisions[0].amountCents, t.amountCents);
  }
});

test('Sammelüberweisung: nur der offene Betrag der Rechnung wird vorgeschlagen', () => {
  const result: InvoiceMatchResult = { status: 'possible_batch', matches: [candidate('t1', 0.8, 'possible_batch', 450)] };
  const { decisions } = decide([invoice(1, 30_000)], [result], txs(tx('t1', 75_000)), new Map(), new Set());
  assert.equal(decisions[0].kind, 'propose');
  assert.equal(decisions[0].amountCents, 30_000);
});

test('Teilzahlungen: alle gefundenen Raten werden vorgeschlagen', () => {
  const result: InvoiceMatchResult = {
    status: 'partially_matched',
    matches: [candidate('t1', 0.55, 'partial', -1000), candidate('t2', 0.5, 'partial', -1000)],
  };
  const { decisions } = decide([invoice(1, 150_000)], [result], txs(tx('t1', 50_000), tx('t2', 50_000)), new Map(), new Set());
  assert.deepEqual(decisions.map((d) => [d.kind, d.tx.id, d.amountCents]), [
    ['propose', 't1', 50_000],
    ['propose', 't2', 50_000],
  ]);
});

test('abgelehnte Zuordnung wird nie automatisch gebucht', () => {
  const result: InvoiceMatchResult = { status: 'matched', matches: [candidate('t1', 1), candidate('t2', 0.6)] };
  const dismissed = new Set([dismissalKey(1, IBAN, 't1')]);
  const { decisions } = decide([invoice(1, 100_000)], [result], txs(tx('t1', 100_000), tx('t2', 100_000)), new Map(), dismissed);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'propose');
  assert.equal(decisions[0].tx.id, 't2');
});

test('ein Umsatz wird nicht doppelt gebucht', () => {
  const results: InvoiceMatchResult[] = [
    { status: 'matched', matches: [candidate('t1', 1)] },
    { status: 'matched', matches: [candidate('t1', 1)] },
  ];
  const { decisions, unmatched } = decide([invoice(1, 10_000), invoice(2, 10_000)], results, txs(tx('t1', 10_000)), new Map(), new Set());
  assert.equal(decisions.filter((d) => d.kind === 'book').length, 1);
  assert.equal(unmatched, 1);
});

test('unbekannte oder bereits verbrauchte Umsätze zählen als nicht zugeordnet', () => {
  const result: InvoiceMatchResult = { status: 'matched', matches: [candidate('t1', 1)] };
  const allocated = new Map([[txKey(IBAN, 't1'), 10_000]]);
  assert.equal(decide([invoice(1, 10_000)], [result], txs(tx('t1', 10_000)), allocated, new Set()).unmatched, 1);
  assert.equal(decide([invoice(1, 10_000)], [result], txs(), new Map(), new Set()).unmatched, 1);
});

test('vollständig zugeordnete Umsätze werden von AI/Connect ausgeschlossen', () => {
  const allocated = new Map([
    [txKey(IBAN, 'voll'), 10_000],
    [txKey(IBAN, 'teil'), 5_000],
    [txKey(IBAN, 'alt'), 1_000],
  ]);
  const refs = excludedTransactions(txs(tx('voll', 10_000), tx('teil', 10_000)), allocated);
  assert.deepEqual(refs.map((r) => r.id).sort(), ['alt', 'voll']);
});

test('Kontoumsatz von BANKSapi übernehmen', () => {
  const t = toBankTransaction('a1', IBAN, {
    id: 'x',
    betrag: 1547.0,
    buchungsdatum: '2026-10-10 00:00:00',
    gegenkontoInhaber: ' Weber Elektrotechnik KG ',
    verwendungszweck: 'RE-2026-0104',
  });
  assert.equal(t?.amountCents, 154_700);
  assert.equal(t?.bookedOn, '2026-10-10');
  assert.equal(t?.counterparty, 'Weber Elektrotechnik KG');
  assert.equal(toBankTransaction('a1', IBAN, { betrag: 1, buchungsdatum: '2026-10-10 00:00:00' }), null);
});
