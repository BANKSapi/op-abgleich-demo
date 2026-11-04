/** Reine Logik für den Bankabgleich (ohne Datenbank- oder Netzwerkzugriff). */
import type { Invoice } from './domain';
import type { ExtractedInvoice, InvoiceMatchResult, MatchCandidate } from './banksapi';

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const euros = (cents: number) => Math.round(cents) / 100;
export const toCents = (amount: number) => Math.round(amount * 100);

/**
 * Rechnung → AI/Connect-Eingabe (EN-16931-Felder). Verglichen wird der noch offene Betrag,
 * damit Teilzahlungen die Zuordnung der Restzahlung nicht verhindern.
 */
export function toExtractedInvoice(
  invoice: Invoice,
  customerIban: string | null,
  sellerName: string,
): ExtractedInvoice {
  return {
    invoiceNumber: invoice.number,
    invoiceIssueDate: invoice.issue_date,
    invoiceCurrencyCode: 'EUR',
    sellerName,
    buyerName: invoice.customer_name,
    buyerIdentifier: invoice.customer_number,
    // Nur mit der Kunden-IBAN (BT-91) kann bei Forderungen ein IBAN-Treffer entstehen.
    ...(customerIban ? { debitedAccountIdentifier: customerIban } : {}),
    amountDueForPayment: euros(invoice.open_cents),
    invoiceTotalAmountWithVat: euros(invoice.amount_cents),
    paymentDueDate: invoice.due_date,
  };
}

/** Bestes Ergebnis je Rechnung, sofern es überhaupt einen Kandidaten gibt. */
export function topMatch(result: InvoiceMatchResult | undefined): MatchCandidate | null {
  if (!result || result.status === 'unmatched' || result.status === 'extraction_failed') return null;
  return result.matches?.[0] ?? null;
}

/**
 * Nur völlig eindeutige Treffer werden ohne Rückfrage verbucht: IBAN, Betrag auf den Cent
 * und Rechnungsnummer stimmen überein (matchType "exact") und es gibt keine Abweichung.
 * Alles andere (Teilzahlung, Skonto, Sammelüberweisung, nur Betrag/Referenz …) braucht eine Bestätigung.
 */
export function isSafeToAutoBook(result: InvoiceMatchResult, match: MatchCandidate, invoice: Invoice, txCents: number): boolean {
  return (
    result.status === 'matched' &&
    match.matchType === 'exact' &&
    match.confidence >= 0.95 &&
    toCents(match.delta) === 0 &&
    txCents > 0 &&
    txCents === invoice.open_cents
  );
}

/** "2026-03-02 00:00:00" → "2026-03-02" */
export function bookingDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Notiz an der Zahlung: woher sie stammt und wie sicher die Zuordnung war. */
export function paymentNote(tx: { gegenkontoInhaber?: string; verwendungszweck?: string }, match: MatchCandidate): string {
  const purpose = (tx.verwendungszweck ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const who = tx.gegenkontoInhaber?.trim() || 'unbekannt';
  return `Bankumsatz von ${who}: ${purpose} (Zuordnung ${match.matchType}, ${Math.round(match.confidence * 100)} %)`;
}
