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

export interface BankProduct {
  id: string;
  iban: string;
  name: string;
  bank: string;
  balance: number | null;
}

export interface BankAccess {
  id: string;
  status: string | null;
  updated_at: string | null;
  needs_sca: boolean;
  messages: string[];
  products: BankProduct[];
}

export interface Suggestion {
  id: number;
  invoice_id: number;
  invoice_number: string;
  customer_name: string;
  open_cents: number;
  match_status: string;
  match_type: string;
  confidence: number;
  notes: string;
  booked_on: string;
  amount_cents: number;
  counterparty: string;
  purpose: string;
}

export interface BankStatus {
  configured: boolean;
  accesses: BankAccess[];
  suggestions: Suggestion[];
}

export interface ReconcileResult {
  booked: number;
  suggested: number;
  unmatched: number;
  needs_sca: string[];
  checked_invoices: number;
}

export interface RegprotectSession {
  session_link: string;
  reentry_url: string;
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
  bankStatus: () => request<BankStatus>('/api/bank/status'),
  bankConnect: () => request<RegprotectSession>('/api/bank/connect', { method: 'POST' }),
  bankRenew: (accessId: string) => request<RegprotectSession>(`/api/bank/accesses/${accessId}/renew`, { method: 'POST' }),
  bankReconcile: (refresh: boolean) =>
    request<ReconcileResult>('/api/bank/reconcile', { method: 'POST', body: JSON.stringify({ refresh }) }),
  confirmSuggestion: (id: number) => request<Payment>(`/api/bank/suggestions/${id}/confirm`, { method: 'POST' }),
  rejectSuggestion: (id: number) => request<void>(`/api/bank/suggestions/${id}/reject`, { method: 'POST' }),
  deletePayment: (invoiceId: number, paymentId: number) =>
    request<void>(`/api/invoices/${invoiceId}/payments/${paymentId}`, { method: 'DELETE' }),
};
