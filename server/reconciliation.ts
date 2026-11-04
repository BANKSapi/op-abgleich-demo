import { db } from './db';
import { banksApi, BankingError, type BanksApi, type MatchResult, type MatchCandidate } from './banksapi';
import { getInvoice, listCustomers, listInvoices } from './repository';
import { isIsoDate } from './domain';

export interface BankTransaction {
  id: number;
  tenant: string;
  access_id: string;
  product_id: string;
  transaction_id: string;
  booked_on: string;
  amount_cents: number;
  currency: string;
  counterparty: string;
  purpose: string;
}

function transactionFor(tenant: string, candidate: MatchCandidate): BankTransaction | undefined {
  const rows = db.prepare('SELECT * FROM bank_transactions WHERE tenant = ? AND product_id = ? AND transaction_id = ?')
    .all(tenant, candidate.transaction.productId, candidate.transaction.id) as unknown as BankTransaction[];
  // AI/Connect referenziert nur Produkt + Umsatz. Bei mehreren Zugängen ist das ggf. mehrdeutig.
  return rows.length === 1 ? rows[0] : undefined;
}

function allocated(id: number) {
  return Boolean(db.prepare('SELECT 1 FROM bank_allocations WHERE transaction_id = ?').get(id));
}

export function exclusionRefs(tenant: string) {
  return db.prepare(`SELECT DISTINCT t.product_id AS productId, t.transaction_id AS id
    FROM bank_allocations a JOIN bank_transactions t ON t.id = a.transaction_id WHERE t.tenant = ?`)
    .all(tenant) as unknown as { productId: string; id: string }[];
}

export function invoicePayload() {
  const customers = new Map(listCustomers().map(c => [c.id, c]));
  return listInvoices('unbezahlt').map(invoice => ({
    invoice,
    payload: {
      invoiceNumber: invoice.number,
      invoiceIssueDate: invoice.issue_date,
      paymentDueDate: invoice.due_date,
      invoiceCurrencyCode: 'EUR',
      sellerName: process.env.COMPANY_NAME ?? 'Muster Design GmbH',
      buyerName: invoice.customer_name,
      buyerIdentifier: invoice.customer_number,
      // BT-91 bezeichnet beim Zahlungseingang das Konto des Kunden.
      debitedAccountIdentifier: customers.get(invoice.customer_id)?.iban ?? undefined,
      invoiceTotalAmountWithVat: invoice.amount_cents / 100,
      amountDueForPayment: invoice.open_cents / 100,
    },
  }));
}

function eligible(transaction: BankTransaction, openCents: number) {
  return transaction.currency === 'EUR' && Number.isSafeInteger(transaction.amount_cents)
    && transaction.amount_cents > 0 && transaction.amount_cents <= openCents
    && isIsoDate(transaction.booked_on) && !allocated(transaction.id);
}

export function canAutoBook(result: MatchResult, transaction: BankTransaction, openCents: number) {
  const top = result.matches[0];
  const second = result.matches[1];
  return result.status === 'matched' && top && top.confidence >= 0.9
    && (!second || top.confidence - second.confidence >= 0.1)
    && ['exact', 'strong', 'reference_only'].includes(top.matchType)
    && top.signals.amountMatch === 'exact'
    && (top.signals.ibanMatch === true || top.signals.referenceContainsInvoiceNumber === true)
    && transaction.amount_cents === openCents && eligible(transaction, openCents);
}

function insertPayment(invoiceId: number, transaction: BankTransaction, source: string, evidence: unknown) {
  const payment = db.prepare(`INSERT INTO payments (invoice_id, booked_on, amount_cents, method, note)
    VALUES (?, ?, ?, 'BANKSapi', ?)`).run(invoiceId, transaction.booked_on, transaction.amount_cents,
    `${source === 'automatic' ? 'Automatisch' : 'Geprüft'} mit AI/Connect zugeordnet · ${transaction.counterparty} · ${transaction.purpose}`);
  db.prepare(`INSERT INTO bank_allocations (transaction_id, invoice_id, payment_id, source, evidence) VALUES (?, ?, ?, ?, ?)`)
    .run(transaction.id, invoiceId, payment.lastInsertRowid, source, JSON.stringify(evidence));
}

export function bookCandidate(tenant: string, invoiceId: number, transactionId: number) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const saved = db.prepare('SELECT result FROM reconciliation_results WHERE tenant = ? AND invoice_id = ?').get(tenant, invoiceId) as { result: string } | undefined;
    const result: MatchResult | undefined = saved && JSON.parse(saved.result);
    const candidate = result?.matches.find(c => transactionFor(tenant, c)?.id === transactionId);
    const transaction = candidate && transactionFor(tenant, candidate);
    const invoice = getInvoice(invoiceId);
    if (!invoice || !candidate || !transaction || !eligible(transaction, invoice.open_cents)) {
      throw new BankingError('Zuordnung nicht mehr möglich: Rechnung oder Bankumsatz hat sich geändert, ist bereits zugeordnet oder der Betrag übersteigt den offenen Posten.', 409);
    }
    insertPayment(invoiceId, transaction, 'manual', candidate);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function ignoreTransaction(tenant: string, transactionId: number) {
  const transaction = db.prepare('SELECT id FROM bank_transactions WHERE id = ? AND tenant = ?').get(transactionId, tenant);
  if (!transaction || allocated(transactionId)) throw new BankingError('Bankumsatz nicht verfügbar oder bereits zugeordnet.', 409);
  db.prepare(`INSERT INTO bank_allocations (transaction_id, source, evidence) VALUES (?, 'ignored', '{}')`).run(transactionId);
}

function validResults(value: unknown, count: number): value is MatchResult[] {
  const statuses = ['matched', 'likely_matched', 'partially_matched', 'overpaid', 'possible_batch', 'unmatched', 'extraction_failed'];
  return Array.isArray(value) && value.length === count && value.every(result => result && statuses.includes(result.status)
    && Array.isArray(result.matches) && result.matches.every((candidate: MatchCandidate) => candidate
      && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1
      && typeof candidate.matchType === 'string' && Number.isFinite(candidate.delta)
      && candidate.signals && typeof candidate.signals === 'object'
      && candidate.transaction && typeof candidate.transaction.id === 'string'
      && typeof candidate.transaction.productId === 'string'));
}

// Zusätzliche DB-Sperre schützt auch mehrere Prozesse. Nach einem Absturz darf ein Lauf nach 15 Minuten erneut starten.
export async function reconcile(client: BanksApi = banksApi) {
  if (!client.configured || !client.initialized) throw new BankingError('Bitte zuerst eine Bankverbindung einrichten.', 409);
  let runId: number;
  db.exec('BEGIN IMMEDIATE');
  try {
    const running = db.prepare(`SELECT id FROM reconciliation_runs WHERE tenant = ? AND status = 'running'
      AND started_at > datetime('now', '-15 minutes')`).get(client.tenant);
    if (running) throw new BankingError('Ein Bankabgleich läuft bereits.', 409);
    db.prepare(`UPDATE reconciliation_runs SET status = 'failed', finished_at = datetime('now'), error = 'Vorheriger Lauf wurde unterbrochen.'
      WHERE tenant = ? AND status = 'running'`).run(client.tenant);
    runId = Number(db.prepare('INSERT INTO reconciliation_runs (tenant) VALUES (?)').run(client.tenant).lastInsertRowid);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  try {
    const accesses = await client.accesses();
    if (!accesses || typeof accesses !== 'object' || Array.isArray(accesses)) throw new BankingError('BANKSapi hat ungültige Bankzugangsdaten geliefert.');
    const upsert = db.prepare(`INSERT INTO bank_transactions
      (tenant, access_id, product_id, transaction_id, booked_on, amount_cents, currency, counterparty, purpose)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, access_id, product_id, transaction_id) DO UPDATE SET
        booked_on = excluded.booked_on, amount_cents = excluded.amount_cents, currency = excluded.currency,
        counterparty = excluded.counterparty, purpose = excluded.purpose
      WHERE NOT EXISTS (SELECT 1 FROM bank_allocations a WHERE a.transaction_id = bank_transactions.id)`);
    for (const [accessId, access] of Object.entries(accesses)) {
      for (const product of access.bankprodukte ?? []) {
        if (!product.id) continue;
        const transactions = await client.transactions(accessId, product.id);
        if (!Array.isArray(transactions)) throw new BankingError('BANKSapi hat ungültige Umsatzdaten geliefert.');
        for (const transaction of transactions) {
          const date = typeof transaction.buchungsdatum === 'string' ? transaction.buchungsdatum.slice(0, 10) : '';
          const cents = Math.round(transaction.betrag * 100);
          if (!transaction.id || typeof transaction.betrag !== 'number' || !Number.isSafeInteger(cents) || !isIsoDate(date)) continue;
          upsert.run(client.tenant, accessId, product.id, transaction.id, date, cents,
            transaction.waehrung ?? product.waehrung ?? '', transaction.gegenkontoInhaber ?? '', transaction.verwendungszweck ?? '');
        }
      }
    }
    const inputs = invoicePayload();
    const results = inputs.length ? await client.match(inputs.map(i => i.payload), exclusionRefs(client.tenant)) : [];
    if (!validResults(results, inputs.length)) throw new BankingError('AI/Connect hat ein unerwartetes Antwortformat geliefert. Es wurden keine Zahlungen gebucht.');
    let booked = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Ein Umsatz darf auch bei fehlerhaften/mehrdeutigen Provider-Vorschlägen nicht automatisch mehrfach verwendet werden.
      const topCounts = new Map<number, number>();
      for (const result of results) {
        const transaction = result.matches[0] && transactionFor(client.tenant, result.matches[0]);
        if (transaction) topCounts.set(transaction.id, (topCounts.get(transaction.id) ?? 0) + 1);
      }
      for (const [index, result] of results.entries()) {
        const original = inputs[index].invoice;
        const current = getInvoice(original.id);
        db.prepare(`INSERT INTO reconciliation_results (tenant, invoice_id, run_id, result) VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant, invoice_id) DO UPDATE SET run_id = excluded.run_id, result = excluded.result`)
          .run(client.tenant, original.id, runId, JSON.stringify(result));
        const transaction = result.matches[0] && transactionFor(client.tenant, result.matches[0]);
        if (current && current.open_cents === original.open_cents && transaction && topCounts.get(transaction.id) === 1
          && canAutoBook(result, transaction, current.open_cents)) {
          insertPayment(current.id, transaction, 'automatic', result);
          booked++;
        }
      }
      db.prepare(`UPDATE reconciliation_runs SET status = 'completed', finished_at = datetime('now'), booked_count = ? WHERE id = ?`).run(booked, runId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { booked_count: booked, checked_count: inputs.length };
  } catch (error) {
    const message = error instanceof BankingError ? error.message : 'Bankabgleich fehlgeschlagen. Es wurden keine weiteren Zahlungen gebucht.';
    db.prepare(`UPDATE reconciliation_runs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?`).run(message, runId);
    if (error instanceof BankingError) throw error;
    throw new BankingError(message);
  }
}

export function bankingState(client: BanksApi = banksApi) {
  const openInvoices = listInvoices('unbezahlt');
  const rows = db.prepare('SELECT invoice_id, result FROM reconciliation_results WHERE tenant = ?').all(client.tenant) as unknown as { invoice_id: number; result: string }[];
  const saved = new Map(rows.map(row => [row.invoice_id, JSON.parse(row.result) as MatchResult]));
  const results = openInvoices.map(invoice => {
    const result = saved.get(invoice.id);
    return { invoice, status: result?.status ?? 'not_checked', candidates: (result?.matches ?? []).map(candidate => {
      const transaction = transactionFor(client.tenant, candidate);
      return { ...candidate, bank_transaction: transaction ?? null, available: Boolean(transaction && eligible(transaction, invoice.open_cents)) };
    }) };
  });
  const history = db.prepare(`SELECT t.*, a.source, a.payment_id, a.created_at, i.number AS invoice_number, a.invoice_id
    FROM bank_allocations a JOIN bank_transactions t ON t.id = a.transaction_id LEFT JOIN invoices i ON i.id = a.invoice_id
    WHERE t.tenant = ? ORDER BY a.created_at DESC, t.id DESC LIMIT 50`).all(client.tenant);
  const lastRun = db.prepare('SELECT * FROM reconciliation_runs WHERE tenant = ? ORDER BY id DESC LIMIT 1').get(client.tenant) ?? null;
  return { configured: client.configured, initialized: client.initialized, last_run: lastRun, results, history };
}

export function startReconciliationSchedule() {
  const minutes = Number(process.env.BANKSAPI_SYNC_INTERVAL_MINUTES ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const tick = () => {
    if (banksApi.configured && banksApi.initialized) {
      void reconcile().catch(error => {
        if (error instanceof BankingError && error.status !== 409) console.warn(`Bankabgleich: ${error.message}`);
      });
    }
  };
  tick();
  setInterval(tick, Math.max(minutes, 1) * 60_000).unref();
}
