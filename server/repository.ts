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
  input: { booked_on: string; amount_cents: number; method?: string; note?: string },
): Payment {
  const result = db
    .prepare('INSERT INTO payments (invoice_id, booked_on, amount_cents, method, note) VALUES (?, ?, ?, ?, ?)')
    .run(invoiceId, input.booked_on, input.amount_cents, input.method ?? 'manuell', input.note ?? '');
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
