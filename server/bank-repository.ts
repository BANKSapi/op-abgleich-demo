import { db } from './db';
import { pairKey, type StoredTransaction, type TransactionWithBookings } from './matching';

export type { StoredTransaction, TransactionWithBookings };

export interface Suggestion {
  id: number;
  invoice_id: number;
  access_id: string;
  product_id: string;
  transaction_id: string;
  amount_cents: number;
  result_status: string;
  match_type: string;
  confidence: number;
  notes: string[];
  state: 'offen' | 'abgelehnt';
}

// ---------------------------------------------------------------------------
// Einstellungen

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

// ---------------------------------------------------------------------------
// Zahlungseingänge

const bookedCentsSql = `
  COALESCE((SELECT SUM(p.amount_cents) FROM payments p
            WHERE p.bank_access_id = t.access_id AND p.bank_product_id = t.product_id AND p.bank_transaction_id = t.id), 0)`;

export function upsertTransactions(rows: StoredTransaction[]): void {
  const stmt = db.prepare(`
    INSERT INTO bank_transactions (access_id, product_id, id, booked_on, amount_cents, counterparty_name, counterparty_iban, purpose)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (access_id, product_id, id) DO UPDATE SET
      booked_on = excluded.booked_on, amount_cents = excluded.amount_cents,
      counterparty_name = excluded.counterparty_name, counterparty_iban = excluded.counterparty_iban,
      purpose = excluded.purpose`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(r.access_id, r.product_id, r.id, r.booked_on, r.amount_cents, r.counterparty_name, r.counterparty_iban, r.purpose);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function transactionsWithBookings(): TransactionWithBookings[] {
  return db
    .prepare(`SELECT t.*, ${bookedCentsSql} AS booked_cents FROM bank_transactions t ORDER BY t.booked_on DESC, t.id`)
    .all() as unknown as TransactionWithBookings[];
}

/** Zahlungseingänge mit den Rechnungen, auf die sie gebucht wurden (für die Übersicht). */
export function listTransactions(limit = 100) {
  const transactions = db
    .prepare(`SELECT t.*, ${bookedCentsSql} AS booked_cents FROM bank_transactions t ORDER BY t.booked_on DESC, t.id LIMIT ?`)
    .all(limit) as unknown as TransactionWithBookings[];
  const allocations = db
    .prepare(
      `SELECT p.bank_access_id, p.bank_product_id, p.bank_transaction_id, p.invoice_id, i.number AS invoice_number, p.amount_cents
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE p.bank_transaction_id IS NOT NULL`,
    )
    .all() as {
    bank_access_id: string;
    bank_product_id: string;
    bank_transaction_id: string;
    invoice_id: number;
    invoice_number: string;
    amount_cents: number;
  }[];
  return transactions.map((t) => ({
    ...t,
    allocations: allocations
      .filter((a) => a.bank_access_id === t.access_id && a.bank_product_id === t.product_id && a.bank_transaction_id === t.id)
      .map(({ invoice_id, invoice_number, amount_cents }) => ({ invoice_id, invoice_number, amount_cents })),
  }));
}

export function deleteTransactionsOfAccess(accessId: string): void {
  db.prepare('DELETE FROM match_suggestions WHERE access_id = ?').run(accessId);
  db.prepare('DELETE FROM bank_transactions WHERE access_id = ?').run(accessId);
}

/** Zahlung aus einem Bankumsatz buchen. */
export function addBankPayment(input: {
  invoice_id: number;
  transaction: StoredTransaction;
  amount_cents: number;
  method: 'bankabgleich' | 'bankabgleich-bestaetigt';
  note: string;
}): void {
  db.prepare(
    `INSERT INTO payments (invoice_id, booked_on, amount_cents, method, note, bank_access_id, bank_product_id, bank_transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.invoice_id,
    input.transaction.booked_on,
    input.amount_cents,
    input.method,
    input.note,
    input.transaction.access_id,
    input.transaction.product_id,
    input.transaction.id,
  );
}

// ---------------------------------------------------------------------------
// Vorschläge

export function rejectedPairs(): Set<string> {
  const rows = db
    .prepare("SELECT invoice_id, access_id, product_id, transaction_id FROM match_suggestions WHERE state = 'abgelehnt'")
    .all() as { invoice_id: number; access_id: string; product_id: string; transaction_id: string }[];
  return new Set(rows.map((r) => pairKey(r.invoice_id, r.access_id, r.product_id, r.transaction_id)));
}

/** Offene Vorschläge durch die Ergebnisse des aktuellen Laufs ersetzen (abgelehnte bleiben erhalten). */
export function replaceOpenSuggestions(
  rows: Omit<Suggestion, 'id' | 'state'>[],
): void {
  const insert = db.prepare(`
    INSERT INTO match_suggestions (invoice_id, access_id, product_id, transaction_id, amount_cents, result_status, match_type, confidence, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`);
  db.exec('BEGIN');
  try {
    db.exec("DELETE FROM match_suggestions WHERE state = 'offen'");
    for (const r of rows) {
      insert.run(
        r.invoice_id,
        r.access_id,
        r.product_id,
        r.transaction_id,
        r.amount_cents,
        r.result_status,
        r.match_type,
        r.confidence,
        JSON.stringify(r.notes),
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listOpenSuggestions() {
  const rows = db
    .prepare(
      `SELECT s.*, i.number AS invoice_number, c.name AS customer_name, i.amount_cents AS invoice_amount_cents,
              i.due_date AS invoice_due_date,
              t.booked_on, t.amount_cents AS transaction_amount_cents, t.counterparty_name, t.counterparty_iban, t.purpose
       FROM match_suggestions s
       JOIN invoices i ON i.id = s.invoice_id
       JOIN customers c ON c.id = i.customer_id
       JOIN bank_transactions t ON t.access_id = s.access_id AND t.product_id = s.product_id AND t.id = s.transaction_id
       WHERE s.state = 'offen'
       ORDER BY s.confidence DESC, t.booked_on DESC`,
    )
    .all() as unknown as (Omit<Suggestion, 'notes'> & { notes: string })[];
  return rows.map((r) => ({ ...r, notes: JSON.parse(r.notes) as string[] }));
}

export function getSuggestion(id: number): Suggestion | undefined {
  const row = db.prepare('SELECT * FROM match_suggestions WHERE id = ?').get(id) as
    | (Omit<Suggestion, 'notes'> & { notes: string })
    | undefined;
  return row && { ...row, notes: JSON.parse(row.notes) };
}

export function getTransaction(accessId: string, productId: string, id: string): TransactionWithBookings | undefined {
  return db
    .prepare(
      `SELECT t.*, ${bookedCentsSql} AS booked_cents FROM bank_transactions t WHERE t.access_id = ? AND t.product_id = ? AND t.id = ?`,
    )
    .get(accessId, productId, id) as unknown as TransactionWithBookings | undefined;
}

export function deleteSuggestion(id: number): void {
  db.prepare('DELETE FROM match_suggestions WHERE id = ?').run(id);
}

export function rejectSuggestion(id: number): boolean {
  return db.prepare("UPDATE match_suggestions SET state = 'abgelehnt' WHERE id = ? AND state = 'offen'").run(id).changes > 0;
}
