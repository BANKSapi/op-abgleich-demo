/** Abgleich offener Posten mit den Zahlungseingängen auf dem Bankkonto (BANKSapi AI/Connect). */
import { banksapi, BanksapiError, type BankAccess, type BankTransaction } from './banksapi';
import { banksapiConfig } from './config';
import { addDays, bookingDate, isSafeToAutoBook, paymentNote, toCents, toExtractedInvoice, topMatch } from './matching';
import * as repo from './repository';

export interface ReconcileResult {
  /** Automatisch verbuchte Zahlungen */
  booked: number;
  /** Vorschläge, die auf Bestätigung warten */
  suggested: number;
  /** Offene Rechnungen ohne passenden Umsatz */
  unmatched: number;
  /** Bankzugänge, für die eine neue Zustimmung (SCA) nötig ist, bevor frische Umsätze abrufbar sind */
  needs_sca: string[];
  checked_invoices: number;
}

export function requireBanksapi() {
  const client = banksapi();
  if (!client) throw new BanksapiError('BANKSapi ist nicht konfiguriert (BANKSAPI_TENANT und BANKSAPI_BASIC_AUTH in .env setzen).', 503);
  return client;
}

const hasUsableData = (a: BankAccess) => (a.bankprodukte?.length ?? 0) > 0;

export async function reconcile(options: { refresh?: boolean; customerIp?: string } = {}): Promise<ReconcileResult> {
  const client = requireBanksapi();
  const config = banksapiConfig()!;
  const result: ReconcileResult = { booked: 0, suggested: 0, unmatched: 0, needs_sca: [], checked_invoices: 0 };

  let accesses = (await client.listAccesses()).filter(hasUsableData);
  if (accesses.length === 0) throw new BanksapiError('Es ist noch kein Bankkonto verbunden.', 409);

  if (options.refresh) {
    for (const access of accesses) {
      if (!(await client.refreshAccess(access.id, options.customerIp))) result.needs_sca.push(access.id);
    }
    accesses = (await client.listAccesses()).filter(hasUsableData);
  }

  // Erst nach dem Abruf neu laden: Rechnungen/Zahlungen können sich inzwischen geändert haben.
  const invoices = repo.listInvoices('unbezahlt');
  result.checked_invoices = invoices.length;
  repo.clearOpenSuggestions();
  if (invoices.length === 0) return result;

  const ibans = repo.listCustomerIbans();
  const matches = await client.matchInvoices({
    invoices: invoices.map((i) => toExtractedInvoice(i, ibans.get(i.customer_id) ?? null, config.companyName)),
    invoiceDirection: 'receivable', // eigene Rechnungen → nur Zahlungseingänge kommen in Frage
    excludeTransactions: repo.bookedBankTransactions(),
    searchWindowDays: 120,
  });
  if (matches.length !== invoices.length) {
    throw new BanksapiError('AI/Connect hat eine unerwartete Anzahl an Ergebnissen geliefert.', 502);
  }

  // Die Treffer verweisen nur auf (Konto, Umsatz-ID). Betrag und Datum holen wir aus den Umsätzen selbst.
  const productToAccess = new Map<string, string>();
  for (const access of accesses) for (const p of access.bankprodukte ?? []) productToAccess.set(p.id, access.id);
  const neededProducts = new Set<string>();
  for (const r of matches) {
    const tx = topMatch(r)?.transaction;
    if (tx?.productId) neededProducts.add(tx.productId);
  }
  const from = addDays(invoices.reduce((min, i) => (i.issue_date < min ? i.issue_date : min), invoices[0].issue_date), -61);
  const txById = new Map<string, BankTransaction>();
  for (const productId of neededProducts) {
    const accessId = productToAccess.get(productId);
    if (!accessId) continue;
    for (const tx of await client.transactions(accessId, productId, from)) {
      if (tx.id) txById.set(`${productId}|${tx.id}`, tx);
    }
  }

  const bookedNow = new Set<string>();
  for (let n = 0; n < invoices.length; n++) {
    const invoice = invoices[n];
    const match = topMatch(matches[n]);
    const productId = match?.transaction.productId;
    const tx = match && productId ? txById.get(`${productId}|${match.transaction.id}`) : undefined;
    // Ohne auffindbaren Umsatz, bei Abgängen, bereits verbuchten oder abgelehnten Paaren: keine Zuordnung
    if (!match || !productId || !tx || tx.betrag <= 0) {
      result.unmatched++;
      continue;
    }
    const key = `${productId}|${match.transaction.id}`;
    if (bookedNow.has(key) || repo.isBankTransactionBooked(productId, match.transaction.id) || repo.isRejected(invoice.id, productId, match.transaction.id)) {
      continue;
    }
    const amountCents = toCents(tx.betrag);

    if (config.autoBook && isSafeToAutoBook(matches[n], match, invoice, amountCents)) {
      repo.bookBankPayment(invoice.id, {
        booked_on: bookingDate(tx.buchungsdatum),
        amount_cents: amountCents,
        note: paymentNote(tx, match),
        product_id: productId,
        transaction_id: match.transaction.id,
      });
      bookedNow.add(key);
      result.booked++;
    } else {
      repo.saveSuggestion({
        invoice_id: invoice.id,
        product_id: productId,
        transaction_id: match.transaction.id,
        match_status: matches[n].status,
        match_type: match.matchType,
        confidence: match.confidence,
        notes: (match.notes ?? []).join('; '),
        booked_on: bookingDate(tx.buchungsdatum),
        amount_cents: amountCents,
        counterparty: tx.gegenkontoInhaber ?? '',
        purpose: (tx.verwendungszweck ?? '').replace(/\s+/g, ' ').trim(),
      });
      result.suggested++;
    }
  }
  return result;
}

/** Vorschlag bestätigen: verbucht höchstens den offenen Rechnungsbetrag. */
export function confirmSuggestion(id: number) {
  const s = repo.getSuggestion(id);
  if (!s || s.state !== 'vorgeschlagen') throw new BanksapiError('Vorschlag nicht gefunden', 404);
  if (repo.isBankTransactionBooked(s.product_id, s.transaction_id)) {
    repo.deleteSuggestion(id);
    throw new BanksapiError('Dieser Bankumsatz ist bereits verbucht.', 409);
  }
  if (s.open_cents <= 0) {
    throw new BanksapiError('Die Rechnung ist bereits vollständig bezahlt.', 409);
  }
  const amount = Math.min(s.amount_cents, s.open_cents);
  const surplus = s.amount_cents - amount;
  const note =
    `Bankumsatz von ${s.counterparty || 'unbekannt'}: ${s.purpose.slice(0, 140)} (Zuordnung ${s.match_type}, ${Math.round(s.confidence * 100)} %, bestätigt)` +
    (surplus > 0 ? ` – Überzahlung von ${(surplus / 100).toFixed(2).replace('.', ',')} € nicht verbucht` : '');
  return repo.bookBankPayment(s.invoice_id, {
    booked_on: s.booked_on,
    amount_cents: amount,
    note,
    product_id: s.product_id,
    transaction_id: s.transaction_id,
  });
}
