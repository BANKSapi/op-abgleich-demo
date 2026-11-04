/**
 * Abgleich offener Posten mit Zahlungseingängen über AI/Connect (Invoice Matching).
 *
 * Ablauf eines Laufs:
 *  1. Gutschriften aller verbundenen Konten von BANKSapi holen und lokal speichern
 *  2. Unbezahlte Rechnungen als EN-16931-Felder an AI/Connect schicken
 *     (bereits vollständig verbuchte Umsätze werden per excludeTransactions ausgeschlossen)
 *  3. Eindeutige Treffer automatisch buchen, alles andere als Vorschlag zur Prüfung ablegen
 */
import * as banksapi from './banksapi';
import type { InvoiceMatchResult, TransactionRef } from './banksapi';
import * as bankRepo from './bank-repository';
import { bookingNote, planReconciliation, toExtractedInvoice, type StoredTransaction } from './matching';
import { today } from './domain';
import * as repo from './repository';

/** Höchstzahl Rechnungen pro Anfrage an AI/Connect */
const CHUNK_SIZE = 50;

export function sellerName(): string {
  return process.env.KONTOR_COMPANY_NAME ?? 'Muster Design GmbH';
}

export function autoBookConfidence(): number {
  const value = Number(process.env.BANKSAPI_AUTO_BOOK_CONFIDENCE ?? 0.95);
  return Number.isFinite(value) ? value : 0.95;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Gutschriften aller Konten holen und speichern. */
async function syncTransactions(accesses: banksapi.BankAccess[], from: string): Promise<void> {
  const rows: StoredTransaction[] = [];
  for (const access of accesses) {
    for (const product of access.bankprodukte ?? []) {
      if (!banksapi.relation(product, 'get_kontoumsaetze')) continue;
      for (const t of await banksapi.getTransactions(access, product, from)) {
        if (!t.id || !(t.betrag > 0)) continue;
        if (t.waehrung && t.waehrung !== 'EUR') continue;
        rows.push({
          access_id: access.id,
          product_id: product.id,
          id: t.id,
          booked_on: t.buchungsdatum.slice(0, 10),
          amount_cents: Math.round(t.betrag * 100),
          counterparty_name: t.gegenkontoInhaber ?? '',
          counterparty_iban: (t.gegenkontoIban ?? '').replace(/\s/g, ''),
          purpose: [t.verwendungszweck, t.buchungstext].filter(Boolean).join(' ').trim(),
        });
      }
    }
  }
  bankRepo.upsertTransactions(rows);
}

export interface RunResult {
  at: string;
  invoices: number;
  booked: number;
  suggested: number;
  unmatched: number;
  failed: number;
}

let running: Promise<RunResult> | undefined;

/** Führt einen Abgleich durch. Gleichzeitige Aufrufe teilen sich denselben Lauf. */
export function runReconciliation(): Promise<RunResult> {
  running ??= reconcile().finally(() => {
    running = undefined;
  });
  return running;
}

async function reconcile(): Promise<RunResult> {
  const accesses = await banksapi.getBankAccesses();
  if (accesses.length === 0) throw new banksapi.BanksapiError('Es ist noch kein Bankkonto verbunden', 409);

  const unpaid = repo.listInvoices('unbezahlt');
  const earliestIssue = unpaid.reduce((min, i) => (i.issue_date < min ? i.issue_date : min), today());
  // AI/Connect sucht ab 60 Tage vor Rechnungsdatum (Vorauszahlungen); mindestens 90 Tage für die Anzeige
  const from = [addDays(earliestIssue, -60), addDays(today(), -90)].sort()[0];
  await syncTransactions(accesses, from);

  const transactions = bankRepo.transactionsWithBookings();
  const customers = new Map(repo.listCustomers().map((c) => [c.id, c]));
  const exclude: TransactionRef[] = transactions
    .filter((t) => t.booked_cents >= t.amount_cents)
    .map((t) => ({ id: t.id, productId: t.product_id }));

  const results: InvoiceMatchResult[] = [];
  for (let i = 0; i < unpaid.length; i += CHUNK_SIZE) {
    const chunk = unpaid.slice(i, i + CHUNK_SIZE);
    results.push(
      ...(await banksapi.matchInvoices(
        chunk.map((invoice) => toExtractedInvoice(invoice, customers.get(invoice.customer_id), sellerName())),
        exclude,
      )),
    );
  }

  const plan = planReconciliation({
    invoices: unpaid,
    results,
    transactions,
    rejected: bankRepo.rejectedPairs(),
    autoBookConfidence: autoBookConfidence(),
  });

  for (const booking of plan.bookings) {
    bankRepo.addBankPayment({
      invoice_id: booking.invoice_id,
      transaction: booking.transaction,
      amount_cents: booking.amount_cents,
      method: 'bankabgleich',
      note: bookingNote(booking.transaction),
    });
  }
  bankRepo.replaceOpenSuggestions(plan.suggestions);

  const result: RunResult = {
    at: new Date().toISOString(),
    invoices: unpaid.length,
    booked: plan.bookings.length,
    suggested: plan.suggestions.length,
    unmatched: plan.unmatched.length,
    failed: plan.failed.length,
  };
  bankRepo.setSetting('reconcile.last_run', JSON.stringify(result));
  for (const f of plan.failed) console.warn(`Bankabgleich: Rechnung ${f.invoice_id} nicht auswertbar: ${f.error}`);
  return result;
}

export function lastRun(): RunResult | null {
  const value = bankRepo.getSetting('reconcile.last_run');
  return value ? (JSON.parse(value) as RunResult) : null;
}

/** Vorschlag übernehmen: Zahlung buchen, sofern Rechnung und Umsatz noch offen sind. */
export function confirmSuggestion(id: number): { ok: true } | { ok: false; error: string } {
  const suggestion = bankRepo.getSuggestion(id);
  if (!suggestion || suggestion.state !== 'offen') return { ok: false, error: 'Vorschlag nicht gefunden' };
  const invoice = repo.getInvoice(suggestion.invoice_id);
  const transaction = bankRepo.getTransaction(suggestion.access_id, suggestion.product_id, suggestion.transaction_id);
  if (!invoice || !transaction) return { ok: false, error: 'Rechnung oder Umsatz nicht mehr vorhanden' };

  const amount = Math.min(suggestion.amount_cents, invoice.open_cents, transaction.amount_cents - transaction.booked_cents);
  if (amount <= 0) {
    bankRepo.deleteSuggestion(id);
    return { ok: false, error: 'Rechnung oder Zahlungseingang ist inzwischen vollständig verbucht' };
  }
  bankRepo.addBankPayment({
    invoice_id: invoice.id,
    transaction,
    amount_cents: amount,
    method: 'bankabgleich-bestaetigt',
    note: bookingNote(transaction),
  });
  bankRepo.deleteSuggestion(id);
  return { ok: true };
}
