/**
 * Bankabgleich: Kontoumsätze (BANKS/Connect) gegen offene Posten abgleichen (AI/Connect).
 */
import { db, transaction } from './db';
import * as banksapi from './banksapi';
import { BanksApiError } from './banksapi';
import { today } from './domain';
import { getInvoice, listCustomers, listInvoices } from './repository';
import {
  decide,
  dismissalKey,
  excludedTransactions,
  toBankTransaction,
  toExtractedInvoice,
  txKey,
  type BankTransaction,
  type Decision,
} from './reconcile';

const sellerName = () => process.env.COMPANY_NAME ?? 'Muster Design GmbH';

// ---------------------------------------------------------------------------
// Status der Bankverbindung

export interface BankAccessView {
  id: string;
  status: string;
  updated_at: string | null;
  needs_consent: boolean;
  messages: string[];
  products: { id: string; name: string; iban: string | null; bank: string | null; owner: string | null; balance: number | null }[];
}

export async function status() {
  if (!banksapi.isConfigured()) return { configured: false, accesses: [], last_run: lastRun() };
  // Ohne angelegten BANKSapi-Benutzer gibt es noch keine Bankzugänge – kein unnötiger API-Aufruf
  const accesses = banksapi.hasUser() ? await banksapi.listBankAccesses() : [];
  return {
    configured: true,
    accesses: accesses.map(
      (a): BankAccessView => ({
        id: a.id,
        status: a.status ?? 'UNBEKANNT',
        updated_at: a.aktualisierungszeitpunkt ?? null,
        needs_consent: Boolean(a.relations?.some((r) => r.rel === 'start_sca')),
        messages: (a.messages ?? []).map((m) => m.message ?? m.code ?? '').filter(Boolean),
        products: (a.bankprodukte ?? []).map((p) => ({
          id: p.id,
          name: p.bezeichnung ?? p.kategorie ?? 'Konto',
          iban: p.iban ?? null,
          bank: p.kreditinstitut ?? null,
          owner: p.inhaber ?? null,
          balance: p.saldo ?? null,
        })),
      }),
    ),
    last_run: lastRun(),
  };
}

function lastRun() {
  return db.prepare('SELECT * FROM bank_runs ORDER BY id DESC LIMIT 1').get() ?? null;
}

// ---------------------------------------------------------------------------
// Abgleich

let running = false;

function daysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Bereits über den Bankabgleich zugeordnete Beträge je Umsatz. */
function allocatedByTransaction(): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT bank_product_id AS product_id, bank_transaction_id AS transaction_id, SUM(amount_cents) AS cents
       FROM payments WHERE bank_transaction_id IS NOT NULL GROUP BY bank_product_id, bank_transaction_id`,
    )
    .all() as { product_id: string; transaction_id: string; cents: number }[];
  return new Map(rows.map((r) => [txKey(r.product_id, r.transaction_id), r.cents]));
}

function dismissals(): Set<string> {
  const rows = db.prepare('SELECT invoice_id, product_id, transaction_id FROM bank_dismissals').all() as {
    invoice_id: number;
    product_id: string;
    transaction_id: string;
  }[];
  return new Set(rows.map((r) => dismissalKey(r.invoice_id, r.product_id, r.transaction_id)));
}

async function fetchTransactions(from: string): Promise<Map<string, BankTransaction>> {
  const accesses = await banksapi.listBankAccesses();
  if (accesses.length === 0) throw new BanksApiError('Es ist noch kein Bankkonto verbunden');
  const transactions = new Map<string, BankTransaction>();
  for (const access of accesses) {
    for (const product of access.bankprodukte ?? []) {
      for (const raw of await banksapi.getTransactions(product, from)) {
        const tx = toBankTransaction(access.id, product.id, raw);
        // Nur Zahlungseingänge sind für Ausgangsrechnungen relevant
        if (tx && tx.amountCents > 0) transactions.set(txKey(tx.productId, tx.id), tx);
      }
    }
  }
  return transactions;
}

const insertBankPayment = () =>
  db.prepare(
    `INSERT INTO payments (invoice_id, booked_on, amount_cents, method, note, bank_access_id, bank_product_id, bank_transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

function paymentNote(tx: { counterparty: string; purpose: string }): string {
  return [tx.counterparty, tx.purpose].filter(Boolean).join(' · ').slice(0, 300);
}

export interface ReconcileResult {
  invoices: number;
  transactions: number;
  booked: { invoice_id: number; invoice_number: string; customer_name: string; booked_on: string; amount_cents: number; counterparty: string }[];
  proposed: number;
  unmatched: number;
  warnings: string[];
}

export async function reconcile(): Promise<ReconcileResult> {
  if (running) throw new BanksApiError('Ein Abgleich läuft bereits', 409);
  running = true;
  try {
    const invoices = listInvoices('unbezahlt').filter((i) => i.open_cents > 0);
    const ibans = new Map(listCustomers().map((c) => [c.id, c.iban]));
    let transactions = new Map<string, BankTransaction>();
    let decisions: Decision[] = [];
    let unmatched = 0;
    let warnings: string[] = [];

    if (invoices.length > 0) {
      // AI/Connect sucht ab 60 Tage vor Rechnungsdatum (Vorkasse) – denselben Zeitraum laden wir für die Anzeige
      const from = daysBefore(invoices.reduce((min, i) => (i.issue_date < min ? i.issue_date : min), today()), 60);
      transactions = await fetchTransactions(from);
      const allocated = allocatedByTransaction();

      const results = await banksapi.matchInvoices({
        invoices: invoices.map((i) => toExtractedInvoice(i, sellerName(), ibans.get(i.customer_id) ?? null)),
        invoiceDirection: 'receivable',
        excludeTransactions: excludedTransactions(transactions, allocated),
        assignUnique: true,
      });
      if (results.length !== invoices.length) {
        throw new BanksApiError(`AI/Connect lieferte ${results.length} statt ${invoices.length} Ergebnisse`);
      }
      ({ decisions, unmatched, warnings } = decide(invoices, results, transactions, allocated, dismissals()));
    }

    const booked = decisions.filter((d) => d.kind === 'book');
    const proposals = decisions.filter((d) => d.kind === 'propose');

    transaction(() => {
      // Vorschläge werden bei jedem Lauf neu berechnet
      db.exec('DELETE FROM bank_proposals');
      const payment = insertBankPayment();
      for (const d of booked) {
        payment.run(d.invoice.id, d.tx.bookedOn, d.amountCents, 'Bankabgleich (automatisch)', paymentNote(d.tx), d.tx.accessId, d.tx.productId, d.tx.id);
      }
      const proposal = db.prepare(
        `INSERT OR IGNORE INTO bank_proposals
           (invoice_id, access_id, product_id, transaction_id, booked_on, tx_cents, book_cents, counterparty, purpose,
            match_status, match_type, confidence, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const d of proposals) {
        proposal.run(
          d.invoice.id, d.tx.accessId, d.tx.productId, d.tx.id, d.tx.bookedOn, d.tx.amountCents, d.amountCents,
          d.tx.counterparty, d.tx.purpose, d.status, d.candidate.matchType, d.candidate.confidence, JSON.stringify(d.candidate.notes ?? []),
        );
      }
      db.prepare('INSERT INTO bank_runs (invoices, transactions, booked, proposed, unmatched) VALUES (?, ?, ?, ?, ?)').run(
        invoices.length, transactions.size, booked.length, proposals.length, unmatched,
      );
    });

    return {
      invoices: invoices.length,
      transactions: transactions.size,
      booked: booked.map((d) => ({
        invoice_id: d.invoice.id,
        invoice_number: d.invoice.number,
        customer_name: d.invoice.customer_name,
        booked_on: d.tx.bookedOn,
        amount_cents: d.amountCents,
        counterparty: d.tx.counterparty,
      })),
      proposed: proposals.length,
      unmatched,
      warnings,
    };
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Vorschläge

export interface ProposalRow {
  id: number;
  invoice_id: number;
  invoice_number: string;
  customer_name: string;
  invoice_open_cents: number;
  product_id: string;
  booked_on: string;
  tx_cents: number;
  book_cents: number;
  counterparty: string;
  purpose: string;
  match_status: string;
  match_type: string;
  confidence: number;
  notes: string[];
}

export function listProposals(): ProposalRow[] {
  const open = new Map(listInvoices().map((i) => [i.id, i]));
  const rows = db.prepare('SELECT * FROM bank_proposals ORDER BY booked_on DESC, id').all() as unknown as (Omit<
    ProposalRow,
    'notes' | 'invoice_number' | 'customer_name' | 'invoice_open_cents'
  > & { notes: string })[];
  return rows.flatMap((row) => {
    const invoice = open.get(row.invoice_id);
    if (!invoice || invoice.open_cents <= 0) return [];
    return [
      {
        ...row,
        invoice_number: invoice.number,
        customer_name: invoice.customer_name,
        invoice_open_cents: invoice.open_cents,
        notes: JSON.parse(row.notes) as string[],
      },
    ];
  });
}

interface StoredProposal {
  id: number;
  invoice_id: number;
  access_id: string;
  product_id: string;
  transaction_id: string;
  booked_on: string;
  tx_cents: number;
  book_cents: number;
  counterparty: string;
  purpose: string;
}

function getProposal(id: number): StoredProposal | undefined {
  return db.prepare('SELECT * FROM bank_proposals WHERE id = ?').get(id) as unknown as StoredProposal | undefined;
}

export class ProposalError extends Error {}

/** Vorschlag übernehmen: Zahlung buchen. Betrag höchstens so hoch wie der noch nicht zugeordnete Umsatz. */
export function acceptProposal(id: number): void {
  transaction(() => {
    const p = getProposal(id);
    if (!p) throw new ProposalError('Vorschlag nicht gefunden – ggf. wurde inzwischen ein neuer Abgleich gestartet');
    if ((getInvoice(p.invoice_id)?.open_cents ?? 0) <= 0) throw new ProposalError('Die Rechnung ist bereits vollständig bezahlt');
    const already = allocatedByTransaction().get(txKey(p.product_id, p.transaction_id)) ?? 0;
    const amount = Math.min(p.book_cents, p.tx_cents - already);
    if (amount <= 0) throw new ProposalError('Dieser Umsatz ist bereits vollständig anderen Rechnungen zugeordnet');
    const exists = db
      .prepare('SELECT 1 FROM payments WHERE invoice_id = ? AND bank_product_id = ? AND bank_transaction_id = ?')
      .get(p.invoice_id, p.product_id, p.transaction_id);
    if (exists) throw new ProposalError('Dieser Umsatz ist der Rechnung bereits zugeordnet');

    insertBankPayment().run(p.invoice_id, p.booked_on, amount, 'Bankabgleich (bestätigt)', paymentNote(p), p.access_id, p.product_id, p.transaction_id);
    db.prepare('DELETE FROM bank_proposals WHERE id = ?').run(id);
    // Andere Vorschläge für denselben Umsatz entfallen, sobald er vollständig verbraucht ist
    if (already + amount >= p.tx_cents) {
      db.prepare('DELETE FROM bank_proposals WHERE product_id = ? AND transaction_id = ?').run(p.product_id, p.transaction_id);
    }
  });
}

export function dismissProposal(id: number): void {
  transaction(() => {
    const p = getProposal(id);
    if (!p) throw new ProposalError('Vorschlag nicht gefunden');
    db.prepare('INSERT OR IGNORE INTO bank_dismissals (invoice_id, product_id, transaction_id) VALUES (?, ?, ?)').run(
      p.invoice_id, p.product_id, p.transaction_id,
    );
    db.prepare('DELETE FROM bank_proposals WHERE id = ?').run(id);
  });
}

/**
 * Wird eine Zahlung aus dem Bankabgleich entfernt, war die Zuordnung falsch.
 * Wir merken uns das, damit der nächste Abgleich sie nicht erneut bucht.
 */
export function rememberRemovedBankPayment(invoiceId: number, paymentId: number): void {
  const row = db
    .prepare('SELECT bank_product_id, bank_transaction_id FROM payments WHERE id = ? AND invoice_id = ? AND bank_transaction_id IS NOT NULL')
    .get(paymentId, invoiceId) as { bank_product_id: string; bank_transaction_id: string } | undefined;
  if (!row) return;
  db.prepare('INSERT OR IGNORE INTO bank_dismissals (invoice_id, product_id, transaction_id) VALUES (?, ?, ?)').run(
    invoiceId, row.bank_product_id, row.bank_transaction_id,
  );
}
