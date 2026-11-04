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
  name: string;
  bank: string | null;
  iban: string | null;
  owner: string | null;
  balance: number | null;
  currency: string;
  status: string | null;
}

export interface BankAccess {
  id: string;
  status: string | null;
  updated_at: string | null;
  needs_sca: boolean;
  products: BankProduct[];
}

export interface ReconcileRun {
  at: string;
  invoices: number;
  booked: number;
  suggested: number;
  unmatched: number;
  failed: number;
}

export interface BankStatus {
  accesses: BankAccess[];
  last_run: ReconcileRun | null;
  auto_book_confidence: number;
}

export interface RegProtectSession {
  sessionLink: string;
  accessId: string;
}

export interface MatchSuggestion {
  id: number;
  invoice_id: number;
  invoice_number: string;
  invoice_amount_cents: number;
  invoice_due_date: string;
  customer_name: string;
  amount_cents: number;
  result_status: string;
  match_type: string;
  confidence: number;
  notes: string[];
  booked_on: string;
  transaction_amount_cents: number;
  counterparty_name: string;
  counterparty_iban: string;
  purpose: string;
}

export interface BankTransaction {
  access_id: string;
  product_id: string;
  id: string;
  booked_on: string;
  amount_cents: number;
  booked_cents: number;
  counterparty_name: string;
  counterparty_iban: string;
  purpose: string;
  allocations: { invoice_id: number; invoice_number: string; amount_cents: number }[];
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

  bank: {
    status: () => request<BankStatus>('/api/bank/status'),
    connect: () => request<RegProtectSession>('/api/bank/connect', { method: 'POST' }),
    refresh: (accessId: string) =>
      request<{ session?: RegProtectSession; run?: ReconcileRun }>(`/api/bank/accesses/${accessId}/refresh`, {
        method: 'POST',
      }),
    renewConsent: (accessId: string) =>
      request<RegProtectSession>(`/api/bank/accesses/${accessId}/sca`, { method: 'POST' }),
    disconnect: (accessId: string) => request<void>(`/api/bank/accesses/${accessId}`, { method: 'DELETE' }),
    reconcile: () => request<ReconcileRun>('/api/bank/reconcile', { method: 'POST' }),
    suggestions: () => request<MatchSuggestion[]>('/api/bank/suggestions'),
    confirm: (id: number) => request<void>(`/api/bank/suggestions/${id}/confirm`, { method: 'POST' }),
    reject: (id: number) => request<void>(`/api/bank/suggestions/${id}/reject`, { method: 'POST' }),
    transactions: () => request<BankTransaction[]>('/api/bank/transactions'),
  },
};
