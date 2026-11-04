export type InvoiceStatus = 'offen' | 'ueberfaellig' | 'teilbezahlt' | 'bezahlt';

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
}

export interface Invoice {
  id: number;
  number: string;
  customer_id: number;
  customer_name: string;
  customer_number: string;
  issue_date: string;
  due_date: string;
  amount_cents: number;
  paid_cents: number;
  open_cents: number;
  status: InvoiceStatus;
  description: string;
  payments?: Payment[];
}

export interface Summary {
  open_count: number;
  open_cents: number;
  overdue_count: number;
  overdue_cents: number;
  recent_payments: (Payment & { invoice_number: string; customer_name: string })[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Fehler ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  summary: () => request<Summary>('/api/summary'),
  customers: () => request<Customer[]>('/api/customers'),
  createCustomer: (data: { name: string; iban?: string; email?: string }) =>
    request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(data) }),
  invoices: (status?: string) => request<Invoice[]>(`/api/invoices${status ? `?status=${status}` : ''}`),
  invoice: (id: number) => request<Invoice>(`/api/invoices/${id}`),
  nextInvoiceNumber: () => request<{ number: string }>('/api/invoices/next-number'),
  createInvoice: (data: { customer_id: number; issue_date: string; due_date: string; amount: string; description: string }) =>
    request<Invoice>('/api/invoices', { method: 'POST', body: JSON.stringify(data) }),
  addPayment: (invoiceId: number, data: { booked_on: string; amount: string; note: string }) =>
    request<Payment>(`/api/invoices/${invoiceId}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  deletePayment: (invoiceId: number, paymentId: number) =>
    request<void>(`/api/invoices/${invoiceId}/payments/${paymentId}`, { method: 'DELETE' }),
};
