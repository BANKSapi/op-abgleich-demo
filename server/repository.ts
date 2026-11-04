import { db } from './db';
import { withStatus, today, type Invoice, type InvoiceRow, type InvoiceStatus } from './domain';

export interface Customer {
  id: number;
  customer_number: string;
  name: string;
  iban: string | null;
  email: string | null;
}

export interface Payment {
  id: number;
  invoice_id: number;
  booked_on: string;
  amount_cents: number;
  method: string;
  note: string;
  created_at: string;
  bank_product_id: string | null;
  bank_transaction_id: string | null;
}

export interface Suggestion {
  id: number;
  invoice_id: number;
  invoice_number: string;
  customer_name: string;
  open_cents: number;
  state: 'vorgeschlagen' | 'abgelehnt';
  match_status: string;
  match_type: string;
  confidence: number;
  notes: string;
  product_id: string;
  transaction_id: string;
  booked_on: string;
  amount_cents: number;
  counterparty: string;
  purpose: string;
}

const invoiceSelect = `
  SELECT i.id, i.number, i.customer_id, c.name AS customer_name, c.customer_number,
         i.issue_date, i.due_date, i.amount_cents, i.description,
         COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_cents
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
`;

export function listCustomers(): Customer[] {
  return db.prepare('SELECT * FROM customers ORDER BY name').all() as unknown as Customer[];
}

export function createCustomer(input: Omit<Customer, 'id' | 'customer_number'>): Customer {
  const last = db.prepare("SELECT customer_number FROM customers ORDER BY customer_number DESC LIMIT 1").get() as
    | { customer_number: string }
    | undefined;
  const next = last ? Number(last.customer_number.replace(/\D/g, '')) + 1 : 10001;
  const result = db
    .prepare('INSERT INTO customers (customer_number, name, iban, email) VALUES (?, ?, ?, ?)')
    .run(`K-${next}`, input.name, input.iban, input.email);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid) as unknown as Customer;
}

export function listInvoices(filter?: InvoiceStatus | 'unbezahlt'): Invoice[] {
  const rows = db.prepare(`${invoiceSelect} ORDER BY i.due_date, i.number`).all() as unknown as InvoiceRow[];
  const invoices = rows.map((row) => withStatus(row));
  if (!filter) return invoices;
  if (filter === 'unbezahlt') return invoices.filter((i) => i.status !== 'bezahlt');
  return invoices.filter((i) => i.status === filter);
}

export function getInvoice(id: number): (Invoice & { payments: Payment[] }) | undefined {
  const row = db.prepare(`${invoiceSelect} WHERE i.id = ?`).get(id) as unknown as InvoiceRow | undefined;
  if (!row) return undefined;
  const payments = db
    .prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY booked_on, id')
    .all(id) as unknown as Payment[];
  return { ...withStatus(row), payments };
}

export function nextInvoiceNumber(year = today().slice(0, 4)): string {
  const last = db
    .prepare('SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1')
    .get(`RE-${year}-%`) as { number: string } | undefined;
  const seq = last ? Number(last.number.split('-')[2]) + 1 : 1;
  return `RE-${year}-${String(seq).padStart(4, '0')}`;
}

export function createInvoice(input: {
  customer_id: number;
  issue_date: string;
  due_date: string;
  amount_cents: number;
  description: string;
}): Invoice {
  const number = nextInvoiceNumber(input.issue_date.slice(0, 4));
  const result = db
    .prepare(
      'INSERT INTO invoices (number, customer_id, issue_date, due_date, amount_cents, description) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(number, input.customer_id, input.issue_date, input.due_date, input.amount_cents, input.description);
  return getInvoice(Number(result.lastInsertRowid))!;
}

export function addPayment(
  invoiceId: number,
  input: {
    booked_on: string;
    amount_cents: number;
    method?: string;
    note?: string;
    bank_product_id?: string;
    bank_transaction_id?: string;
  },
): Payment {
  const result = db
    .prepare(
      'INSERT INTO payments (invoice_id, booked_on, amount_cents, method, note, bank_product_id, bank_transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      invoiceId,
      input.booked_on,
      input.amount_cents,
      input.method ?? 'manuell',
      input.note ?? '',
      input.bank_product_id ?? null,
      input.bank_transaction_id ?? null,
    );
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(result.lastInsertRowid) as unknown as Payment;
}

export function deletePayment(invoiceId: number, paymentId: number): boolean {
  return db.prepare('DELETE FROM payments WHERE id = ? AND invoice_id = ?').run(paymentId, invoiceId).changes > 0;
}

export function summary() {
  const invoices = listInvoices();
  const unpaid = invoices.filter((i) => i.status !== 'bezahlt');
  const overdue = invoices.filter((i) => i.status === 'ueberfaellig');
  const recentPayments = db
    .prepare(
      `SELECT p.*, i.number AS invoice_number, c.name AS customer_name
       FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id
       ORDER BY p.booked_on DESC, p.id DESC LIMIT 5`,
    )
    .all();
  return {
    open_count: unpaid.length,
    open_cents: unpaid.reduce((sum, i) => sum + i.open_cents, 0),
    overdue_count: overdue.length,
    overdue_cents: overdue.reduce((sum, i) => sum + i.open_cents, 0),
    recent_payments: recentPayments,
  };
}

// ---------- Bankabgleich ----------

/** Bereits verbuchte Bankumsätze; AI/Connect soll sie nicht erneut zuordnen. */
export function bookedBankTransactions(): { id: string; productId: string }[] {
  return db
    .prepare('SELECT bank_transaction_id AS id, bank_product_id AS productId FROM payments WHERE bank_transaction_id IS NOT NULL')
    .all() as unknown as { id: string; productId: string }[];
}

export function isBankTransactionBooked(productId: string, transactionId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM payments WHERE bank_product_id = ? AND bank_transaction_id = ?')
    .get(productId, transactionId);
}

export function listCustomerIbans(): Map<number, string | null> {
  const rows = db.prepare('SELECT id, iban FROM customers').all() as unknown as { id: number; iban: string | null }[];
  return new Map(rows.map((r) => [r.id, r.iban]));
}

const suggestionSelect = `
  SELECT s.*, i.number AS invoice_number, c.name AS customer_name,
         MAX(i.amount_cents - COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0), 0) AS open_cents
  FROM bank_suggestions s
  JOIN invoices i ON i.id = s.invoice_id
  JOIN customers c ON c.id = i.customer_id
`;

export function listSuggestions(): Suggestion[] {
  return db
    .prepare(`${suggestionSelect} WHERE s.state = 'vorgeschlagen' ORDER BY s.confidence DESC, s.booked_on DESC`)
    .all() as unknown as Suggestion[];
}

export function getSuggestion(id: number): Suggestion | undefined {
  return db.prepare(`${suggestionSelect} WHERE s.id = ?`).get(id) as unknown as Suggestion | undefined;
}

export function isRejected(invoiceId: number, productId: string, transactionId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM bank_suggestions WHERE invoice_id = ? AND product_id = ? AND transaction_id = ? AND state = 'abgelehnt'")
    .get(invoiceId, productId, transactionId);
}

/** Offene Vorschläge werden bei jedem Abgleich neu berechnet; abgelehnte bleiben erhalten. */
export function clearOpenSuggestions(): void {
  db.prepare("DELETE FROM bank_suggestions WHERE state = 'vorgeschlagen'").run();
}

export function saveSuggestion(s: Omit<Suggestion, 'id' | 'invoice_number' | 'customer_name' | 'open_cents' | 'state'>): void {
  db.prepare(
    `INSERT OR IGNORE INTO bank_suggestions
       (invoice_id, product_id, transaction_id, match_status, match_type, confidence, notes, booked_on, amount_cents, counterparty, purpose)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.invoice_id, s.product_id, s.transaction_id, s.match_status, s.match_type, s.confidence,
    s.notes, s.booked_on, s.amount_cents, s.counterparty, s.purpose,
  );
}

export function rejectSuggestion(id: number): boolean {
  return db.prepare("UPDATE bank_suggestions SET state = 'abgelehnt' WHERE id = ? AND state = 'vorgeschlagen'").run(id).changes > 0;
}

export function deleteSuggestion(id: number): void {
  db.prepare('DELETE FROM bank_suggestions WHERE id = ?').run(id);
}

/** Verbucht einen Bankumsatz atomar und räumt Vorschläge zum selben Umsatz auf. */
export function bookBankPayment(
  invoiceId: number,
  input: { booked_on: string; amount_cents: number; note: string; product_id: string; transaction_id: string },
): Payment {
  db.exec('BEGIN');
  try {
    const payment = addPayment(invoiceId, {
      booked_on: input.booked_on,
      amount_cents: input.amount_cents,
      method: 'bank',
      note: input.note,
      bank_product_id: input.product_id,
      bank_transaction_id: input.transaction_id,
    });
    db.prepare("DELETE FROM bank_suggestions WHERE product_id = ? AND transaction_id = ? AND state = 'vorgeschlagen'").run(
      input.product_id,
      input.transaction_id,
    );
    db.exec('COMMIT');
    return payment;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
