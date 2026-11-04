export type InvoiceStatus = 'offen' | 'ueberfaellig' | 'teilbezahlt' | 'bezahlt';

export interface InvoiceRow {
  id: number;
  number: string;
  customer_id: number;
  customer_name: string;
  customer_number: string;
  issue_date: string;
  due_date: string;
  amount_cents: number;
  paid_cents: number;
  description: string;
}

export interface Invoice extends InvoiceRow {
  open_cents: number;
  status: InvoiceStatus;
}

/** Heutiges Datum als ISO-String (YYYY-MM-DD), lokal. */
export function today(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function invoiceStatus(amountCents: number, paidCents: number, dueDate: string, asOf = today()): InvoiceStatus {
  if (paidCents >= amountCents) return 'bezahlt';
  if (dueDate < asOf) return 'ueberfaellig';
  if (paidCents > 0) return 'teilbezahlt';
  return 'offen';
}

export function withStatus(row: InvoiceRow, asOf = today()): Invoice {
  return {
    ...row,
    open_cents: Math.max(row.amount_cents - row.paid_cents, 0),
    status: invoiceStatus(row.amount_cents, row.paid_cents, row.due_date, asOf),
  };
}

/** "1.234,56" oder "1234.56" → Cent. Gibt null zurück, wenn der Betrag nicht lesbar ist. */
export function parseAmount(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const s = input.trim().replace(/\s|€/g, '');
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
