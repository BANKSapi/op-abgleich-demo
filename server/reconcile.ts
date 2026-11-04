/**
 * Entscheidungslogik für den Bankabgleich: aus den Ergebnissen von AI/Connect wird je Rechnung
 * eine automatische Buchung, ein Vorschlag zur Bestätigung oder nichts.
 *
 * Bewusst konservativ: Automatisch gebucht wird nur, wenn AI/Connect sich sicher ist UND der
 * Umsatz centgenau dem offenen Betrag entspricht. Alles andere (Teilzahlung, Skonto, Sammel-
 * überweisung, unsichere Treffer) landet als Vorschlag beim Menschen.
 */
import type { ExtractedInvoice, InvoiceMatchResult, MatchCandidate, MatchStatus, Transaction, TransactionRef } from './banksapi';
import type { Invoice } from './domain';

/** Ab dieser Konfidenz bucht der Abgleich ohne Rückfrage. */
export const AUTO_BOOK_CONFIDENCE = 0.95;
/** Liegt ein zweiter Kandidat so nah am besten, gilt der Treffer als mehrdeutig. */
const AMBIGUITY_MARGIN = 0.1;

export interface BankTransaction {
  accessId: string;
  productId: string;
  id: string;
  bookedOn: string;
  amountCents: number;
  counterparty: string;
  counterpartyIban: string;
  purpose: string;
}

export const txKey = (productId: string, transactionId: string) => `${productId}|${transactionId}`;
export const dismissalKey = (invoiceId: number, productId: string, transactionId: string) =>
  `${invoiceId}|${txKey(productId, transactionId)}`;

export function toBankTransaction(accessId: string, productId: string, tx: Transaction): BankTransaction | null {
  // Nur gebuchte Umsätze synchronisierter Zugänge haben eine id und lassen sich referenzieren
  if (!tx.id) return null;
  return {
    accessId,
    productId,
    id: tx.id,
    bookedOn: tx.buchungsdatum.slice(0, 10),
    amountCents: Math.round(tx.betrag * 100),
    counterparty: tx.gegenkontoInhaber?.trim() ?? '',
    counterpartyIban: tx.gegenkontoIban?.replace(/\s/g, '') ?? '',
    purpose: tx.verwendungszweck?.trim() ?? '',
  };
}

export function toExtractedInvoice(invoice: Invoice, sellerName: string, customerIban: string | null): ExtractedInvoice {
  return {
    invoiceNumber: invoice.number,
    invoiceIssueDate: invoice.issue_date,
    paymentDueDate: invoice.due_date,
    // BT-115: noch zu zahlender Betrag – bereits erfasste Teilzahlungen sind abgezogen
    amountDueForPayment: invoice.open_cents / 100,
    invoiceTotalAmountWithVat: invoice.amount_cents / 100,
    invoiceCurrencyCode: 'EUR',
    sellerName,
    buyerName: invoice.customer_name,
    buyerIdentifier: invoice.customer_number,
    ...(customerIban ? { debitedAccountIdentifier: customerIban } : {}),
  };
}

/**
 * Umsätze, die AI/Connect nicht mehr vorschlagen soll: vollständig zugeordnete sowie
 * zugeordnete, die außerhalb des abgerufenen Zeitraums liegen.
 */
export function excludedTransactions(
  transactions: Map<string, BankTransaction>,
  allocated: Map<string, number>,
): TransactionRef[] {
  const refs: TransactionRef[] = [];
  for (const [key, cents] of allocated) {
    const tx = transactions.get(key);
    if (!tx || cents >= tx.amountCents) {
      const [productId, id] = key.split('|');
      refs.push({ productId, id });
    }
  }
  return refs;
}

export interface Decision {
  kind: 'book' | 'propose';
  invoice: Invoice;
  tx: BankTransaction;
  amountCents: number;
  status: MatchStatus;
  candidate: MatchCandidate;
}

export interface DecisionSummary {
  decisions: Decision[];
  unmatched: number;
  warnings: string[];
}

function findTransaction(ref: TransactionRef, transactions: Map<string, BankTransaction>): BankTransaction | undefined {
  if (ref.productId) return transactions.get(txKey(ref.productId, ref.id));
  for (const tx of transactions.values()) if (tx.id === ref.id) return tx;
  return undefined;
}

function isUnambiguous(candidates: MatchCandidate[], top: MatchCandidate): boolean {
  return !candidates.some((c) => c !== top && c.confidence >= top.confidence - AMBIGUITY_MARGIN);
}

export function decide(
  invoices: Invoice[],
  results: InvoiceMatchResult[],
  transactions: Map<string, BankTransaction>,
  alreadyAllocated: Map<string, number>,
  dismissed: Set<string>,
): DecisionSummary {
  const allocated = new Map(alreadyAllocated);
  const remaining = (tx: BankTransaction) => tx.amountCents - (allocated.get(txKey(tx.productId, tx.id)) ?? 0);
  const decisions: Decision[] = [];
  const warnings: string[] = [];
  let unmatched = 0;

  invoices.forEach((invoice, index) => {
    const result = results[index];
    if (result.status === 'extraction_failed') {
      warnings.push(`${invoice.number}: ${result.error ?? 'Rechnung konnte nicht verarbeitet werden'}`);
    }

    // Kandidaten, die wir kennen, die noch Restbetrag haben und nicht abgelehnt wurden
    const candidates = (result.matches ?? []).flatMap((candidate) => {
      const tx = findTransaction(candidate.transaction, transactions);
      if (!tx || tx.amountCents <= 0) return [];
      if (dismissed.has(dismissalKey(invoice.id, tx.productId, tx.id))) return [];
      return [{ candidate, tx }];
    });
    const usable = candidates.filter(({ tx }) => remaining(tx) > 0);
    if (usable.length === 0) {
      unmatched++;
      return;
    }

    const [top] = usable;
    const topWasDismissed = (result.matches ?? [])[0] !== top.candidate;
    if (
      !topWasDismissed &&
      result.status === 'matched' &&
      top.candidate.confidence >= AUTO_BOOK_CONFIDENCE &&
      isUnambiguous(result.matches ?? [], top.candidate) &&
      remaining(top.tx) === invoice.open_cents
    ) {
      decisions.push({ kind: 'book', invoice, tx: top.tx, amountCents: invoice.open_cents, status: result.status, candidate: top.candidate });
      allocated.set(txKey(top.tx.productId, top.tx.id), (allocated.get(txKey(top.tx.productId, top.tx.id)) ?? 0) + invoice.open_cents);
      return;
    }

    // Teilzahlungen: alle gefundenen Raten vorschlagen; sonst nur den besten Kandidaten
    const proposals = result.status === 'partially_matched' ? usable : [top];
    for (const { candidate, tx } of proposals) {
      // Sammelüberweisung: nur den offenen Betrag dieser Rechnung zuordnen, Rest bleibt für andere Rechnungen
      const amountCents =
        candidate.matchType === 'possible_batch' || result.status === 'possible_batch'
          ? Math.min(remaining(tx), invoice.open_cents)
          : remaining(tx);
      decisions.push({ kind: 'propose', invoice, tx, amountCents, status: result.status, candidate });
    }
  });

  return { decisions, unmatched, warnings };
}
