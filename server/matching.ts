/**
 * Entscheidungsregeln für den Bankabgleich – reine Funktionen ohne Datenbank- oder Netzwerkzugriff.
 */
import type { ExtractedInvoice, InvoiceMatchResult, MatchCandidate, MatchType, TransactionRef } from './banksapi';
import type { Invoice } from './domain';

export interface StoredTransaction {
  access_id: string;
  product_id: string;
  id: string;
  booked_on: string;
  amount_cents: number;
  counterparty_name: string;
  counterparty_iban: string;
  purpose: string;
}

export interface TransactionWithBookings extends StoredTransaction {
  /** Bereits auf Rechnungen gebuchter Anteil dieses Zahlungseingangs */
  booked_cents: number;
}

export function pairKey(invoiceId: number, accessId: string, productId: string, transactionId: string): string {
  return `${invoiceId}|${accessId}|${productId}|${transactionId}`;
}

/** Treffertypen, bei denen AI/Connect Bankverbindung und/oder Rechnungsnummer bestätigt hat. */
const AUTO_BOOK_TYPES: MatchType[] = ['exact', 'strong', 'reference_only'];

export function toExtractedInvoice(
  invoice: Invoice,
  customer: { customer_number: string; iban: string | null } | undefined,
  seller: string,
): ExtractedInvoice {
  return {
    invoiceNumber: invoice.number,
    invoiceIssueDate: invoice.issue_date,
    paymentDueDate: invoice.due_date,
    invoiceCurrencyCode: 'EUR',
    sellerName: seller,
    buyerName: invoice.customer_name,
    buyerIdentifier: customer?.customer_number ?? invoice.customer_number,
    // Nur so kann AI/Connect bei Ausgangsrechnungen die IBAN des Zahlers vergleichen
    ...(customer?.iban && { debitedAccountIdentifier: customer.iban }),
    // Bei Teilzahlungen nur den noch offenen Betrag abgleichen (BT-115)
    amountDueForPayment: invoice.open_cents / 100,
    invoiceTotalAmountWithVat: invoice.amount_cents / 100,
  };
}

export interface PlannedBooking {
  invoice_id: number;
  transaction: StoredTransaction;
  amount_cents: number;
  candidate: MatchCandidate;
}

export interface PlannedSuggestion {
  invoice_id: number;
  access_id: string;
  product_id: string;
  transaction_id: string;
  amount_cents: number;
  result_status: string;
  match_type: string;
  confidence: number;
  notes: string[];
}

export interface Plan {
  bookings: PlannedBooking[];
  suggestions: PlannedSuggestion[];
  unmatched: number[];
  failed: { invoice_id: number; error: string }[];
}

/**
 * Entscheidet anhand der AI/Connect-Ergebnisse, was gebucht und was vorgeschlagen wird.
 * Reine Funktion ohne Datenbankzugriff.
 */
export function planReconciliation(input: {
  invoices: Invoice[];
  results: InvoiceMatchResult[];
  transactions: TransactionWithBookings[];
  rejected: Set<string>;
  autoBookConfidence: number;
}): Plan {
  const plan: Plan = { bookings: [], suggestions: [], unmatched: [], failed: [] };

  // Restbetrag je Zahlungseingang, der noch auf Rechnungen verteilt werden kann
  const remaining = new Map<StoredTransaction, number>();
  const byProductAndId = new Map<string, TransactionWithBookings>();
  const byId = new Map<string, TransactionWithBookings[]>();
  for (const t of input.transactions) {
    remaining.set(t, t.amount_cents - t.booked_cents);
    byProductAndId.set(`${t.product_id}|${t.id}`, t);
    byId.set(t.id, [...(byId.get(t.id) ?? []), t]);
  }
  const lookup = (ref: TransactionRef) => {
    if (ref.productId) return byProductAndId.get(`${ref.productId}|${ref.id}`);
    const sameId = byId.get(ref.id);
    return sameId?.length === 1 ? sameId[0] : undefined;
  };

  input.invoices.forEach((invoice, index) => {
    const result = input.results[index];
    if (!result || result.status === 'extraction_failed') {
      plan.failed.push({ invoice_id: invoice.id, error: result?.error ?? 'Kein Ergebnis' });
      return;
    }

    const usable = (result.matches ?? [])
      .map((candidate) => ({ candidate, transaction: lookup(candidate.transaction) }))
      .filter(
        (c): c is { candidate: MatchCandidate; transaction: TransactionWithBookings } =>
          c.transaction !== undefined &&
          (remaining.get(c.transaction) ?? 0) > 0 &&
          !input.rejected.has(
            pairKey(invoice.id, c.transaction.access_id, c.transaction.product_id, c.transaction.id),
          ),
      );

    if (usable.length === 0) {
      plan.unmatched.push(invoice.id);
      return;
    }

    const top = usable[0];
    const topRemaining = remaining.get(top.transaction)!;
    const isAutoBook =
      result.status === 'matched' &&
      top.candidate === result.matches![0] &&
      AUTO_BOOK_TYPES.includes(top.candidate.matchType) &&
      top.candidate.signals.amountMatch === 'exact' &&
      top.candidate.confidence >= input.autoBookConfidence &&
      top.transaction.amount_cents === invoice.open_cents &&
      topRemaining >= invoice.open_cents;

    if (isAutoBook) {
      plan.bookings.push({
        invoice_id: invoice.id,
        transaction: top.transaction,
        amount_cents: invoice.open_cents,
        candidate: top.candidate,
      });
      remaining.set(top.transaction, topRemaining - invoice.open_cents);
      return;
    }

    // Teilzahlungen: alle gefundenen Raten vorschlagen, sonst nur den besten Kandidaten
    const proposals = result.status === 'partially_matched' ? usable : [top];
    let openLeft = invoice.open_cents;
    for (const { candidate, transaction } of proposals) {
      const amount = Math.min(openLeft, remaining.get(transaction)!);
      if (amount <= 0) break;
      plan.suggestions.push({
        invoice_id: invoice.id,
        access_id: transaction.access_id,
        product_id: transaction.product_id,
        transaction_id: transaction.id,
        amount_cents: amount,
        result_status: result.status,
        match_type: candidate.matchType,
        confidence: candidate.confidence,
        notes: candidate.notes ?? [],
      });
      openLeft -= amount;
    }
  });

  return plan;
}

export function bookingNote(transaction: StoredTransaction): string {
  const text = [transaction.counterparty_name, transaction.purpose].filter(Boolean).join(' · ');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
