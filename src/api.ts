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

export interface BankAccess {
  id: string;
  status: string;
  updated_at: string | null;
  needs_consent: boolean;
  messages: string[];
  products: { id: string; name: string; iban: string | null; bank: string | null; owner: string | null; balance: number | null }[];
}

export interface BankRun {
  finished_at: string;
  invoices: number;
  transactions: number;
  booked: number;
  proposed: number;
  unmatched: number;
}

export interface BankStatus {
  configured: boolean;
  accesses: BankAccess[];
  last_run: BankRun | null;
}

export interface ReconcileResult {
  invoices: number;
  transactions: number;
  booked: { invoice_id: number; invoice_number: string; customer_name: string; booked_on: string; amount_cents: number; counterparty: string }[];
  proposed: number;
  unmatched: number;
  warnings: string[];
}

export interface BankProposal {
  id: number;
  invoice_id: number;
  invoice_number: string;
  customer_name: string;
  invoice_open_cents: number;
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

/** Entweder sofort erledigt oder der Nutzer muss den Vorgang in REG/Protect abschließen. */
export type BankAction = { done: true } | { done: false; session_link: string };

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

  bankStatus: () => request<BankStatus>('/api/bank/status'),
  bankConnect: () => request<{ session_link: string }>('/api/bank/connect', { method: 'POST' }),
  bankRefresh: (accessId: string) => request<BankAction>(`/api/bank/accesses/${accessId}/refresh`, { method: 'POST' }),
  bankConsent: (accessId: string) => request<BankAction>(`/api/bank/accesses/${accessId}/consent`, { method: 'POST' }),
  bankDisconnect: (accessId: string) => request<void>(`/api/bank/accesses/${accessId}`, { method: 'DELETE' }),
  bankReconcile: () => request<ReconcileResult>('/api/bank/reconcile', { method: 'POST' }),
  bankProposals: () => request<BankProposal[]>('/api/bank/proposals'),
  acceptProposal: (id: number) => request<void>(`/api/bank/proposals/${id}/accept`, { method: 'POST' }),
  dismissProposal: (id: number) => request<void>(`/api/bank/proposals/${id}/dismiss`, { method: 'POST' }),
};
