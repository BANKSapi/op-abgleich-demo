/**
 * Schlanker Client für BANKSapi (BANKS/Connect + AI/Connect).
 *
 * - Zugangsdaten des Mandanten kommen aus der Umgebung (BANKSAPI_TENANT, BANKSAPI_BASIC_AUTH)
 *   und verlassen nie den Server. Das Frontend bekommt nur REG/Protect-Session-Links.
 * - Kontor legt genau einen technischen BANKSapi-Nutzer für das eigene Unternehmen an;
 *   dessen Zugangsdaten liegen in der lokalen Datenbank (Tabelle `settings`).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { getSetting, setSetting } from './bank-repository';

const BASE_URL = process.env.BANKSAPI_BASE_URL ?? 'https://banksapi.io';
const TIMEOUT_MS = 60_000;

export class BanksapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'BanksapiError';
  }
}

export interface Relation {
  rel: string;
  href: string;
}

export interface BankProduct {
  id: string;
  status?: string;
  bezeichnung?: string;
  kategorie?: string;
  saldo?: number;
  saldoDatum?: string;
  aktualisierungszeitpunkt?: string;
  waehrung?: string;
  iban?: string;
  kreditinstitut?: string;
  inhaber?: string;
  relations?: Relation[];
}

export interface BankAccess {
  id: string;
  providerId?: string;
  status?: string;
  aktualisierungszeitpunkt?: string;
  relations?: Relation[];
  bankprodukte?: BankProduct[];
}

export interface Transaction {
  id?: string;
  betrag: number;
  waehrung?: string;
  verwendungszweck: string;
  buchungstext?: string;
  buchungsdatum: string;
  gegenkontoInhaber?: string;
  gegenkontoIban?: string;
}

/** EN-16931-Felder einer Rechnung, wie sie AI/Connect erwartet (Auszug). */
export interface ExtractedInvoice {
  invoiceNumber: string;
  invoiceIssueDate: string;
  invoiceCurrencyCode: string;
  sellerName: string;
  amountDueForPayment: number;
  invoiceTotalAmountWithVat?: number;
  paymentDueDate?: string;
  buyerName?: string;
  buyerIdentifier?: string;
  debitedAccountIdentifier?: string;
  paymentAccountIdentifier?: string;
  remittanceInformation?: string;
}

export interface TransactionRef {
  id: string;
  productId?: string | null;
}

export type MatchType =
  | 'exact'
  | 'strong'
  | 'reference_only'
  | 'amount_only'
  | 'skonto'
  | 'partial'
  | 'fuzzy'
  | 'possible_batch';

export interface MatchCandidate {
  confidence: number;
  delta: number;
  matchType: MatchType;
  notes?: string[];
  signals: { amountMatch: 'exact' | 'skonto' | 'close' | 'partial' | 'over' | 'none'; [key: string]: unknown };
  transaction: TransactionRef;
}

export type MatchStatus =
  | 'matched'
  | 'likely_matched'
  | 'partially_matched'
  | 'overpaid'
  | 'possible_batch'
  | 'unmatched'
  | 'extraction_failed';

export interface InvoiceMatchResult {
  status: MatchStatus;
  matches?: MatchCandidate[];
  error?: string | null;
  remainingAmount?: number | null;
  totalMatchedAmount?: number | null;
}

/** REG/Protect-Ablauf, der im Browser über die Web Component fortgesetzt werden muss. */
export interface RegProtectSession {
  sessionLink: string;
  accessId: string;
}

export function isConfigured(): boolean {
  return Boolean(process.env.BANKSAPI_TENANT && process.env.BANKSAPI_BASIC_AUTH);
}

function tenant(): string {
  const value = process.env.BANKSAPI_TENANT;
  if (!value) throw new BanksapiError('BANKSAPI_TENANT ist nicht gesetzt', 500);
  return value;
}

function basicAuthHeader(): string {
  const value = process.env.BANKSAPI_BASIC_AUTH?.trim();
  if (!value) throw new BanksapiError('BANKSAPI_BASIC_AUTH ist nicht gesetzt', 500);
  return value.startsWith('Basic ') ? value : `Basic ${value}`;
}

// ---------------------------------------------------------------------------
// Tokens

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokens = new Map<'client' | 'user', CachedToken>();

async function fetchToken(params: Record<string, string>): Promise<CachedToken> {
  const res = await fetch(`${BASE_URL}/auth/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new BanksapiError(`Token konnte nicht erstellt werden (HTTP ${res.status})`, res.status, await res.text());
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 };
}

async function token(kind: 'client' | 'user'): Promise<string> {
  const cached = tokens.get(kind);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const fresh =
    kind === 'client'
      ? await fetchToken({ grant_type: 'client_credentials' })
      : await fetchToken({ grant_type: 'password', ...(await ensureUser()) });
  tokens.set(kind, fresh);
  return fresh.token;
}

// ---------------------------------------------------------------------------
// Technischer Nutzer

/** Passwortregel BANKSapi: ≥ 10 Zeichen, ≥ 2 Buchstaben, ≥ 2 Sonderzeichen/Ziffern. */
function generatePassword(): string {
  return `Ko${randomBytes(18).toString('base64url')}-9!`;
}

let ensuringUser: Promise<{ username: string; password: string }> | undefined;

/** Legt den technischen Nutzer beim ersten Bedarf an und liefert dessen Zugangsdaten. */
export function ensureUser(): Promise<{ username: string; password: string }> {
  ensuringUser ??= (async () => {
    const username = getSetting('banksapi.username');
    const password = getSetting('banksapi.password');
    if (username && password && getSetting('banksapi.tenant') === tenant()) return { username, password };

    const created = { username: `kontor-${randomUUID()}`, password: generatePassword() };
    const res = await fetch(`${BASE_URL}/auth/mgmt/v1/tenants/${encodeURIComponent(tenant())}/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token('client')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(created),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) {
      throw new BanksapiError(`BANKSapi-Nutzer konnte nicht angelegt werden (HTTP ${res.status})`, res.status, await res.text());
    }
    setSetting('banksapi.tenant', tenant());
    setSetting('banksapi.username', created.username);
    setSetting('banksapi.password', created.password);
    return created;
  })().finally(() => {
    ensuringUser = undefined;
  });
  return ensuringUser;
}

export function hasUser(): boolean {
  return Boolean(getSetting('banksapi.username')) && getSetting('banksapi.tenant') === process.env.BANKSAPI_TENANT;
}

// ---------------------------------------------------------------------------
// Anfragen mit Nutzer-Token

interface RequestOptions {
  method?: string;
  body?: unknown;
  customerIp?: string;
  /** Statuscodes, die kein Fehler sind (z. B. 451 bei REG/Protect) */
  accept?: number[];
}

async function userRequest(pathOrUrl: string, options: RequestOptions = {}): Promise<Response> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  if (!url.startsWith(`${BASE_URL}/`)) throw new BanksapiError(`Unerwartete BANKSapi-URL: ${url}`, 500);

  const send = async () =>
    fetch(url, {
      method: options.method ?? 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${await token('user')}`,
        Accept: 'application/json',
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(options.customerIp && { 'Customer-IP-Address': options.customerIp }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  let res = await send();
  if (res.status === 401) {
    // Token abgelaufen oder widerrufen: einmal neu anmelden
    tokens.delete('user');
    res = await send();
  }
  if (!res.ok && !options.accept?.includes(res.status)) {
    const body = await res.text();
    throw new BanksapiError(describeError(url, res.status, body), res.status, body);
  }
  return res;
}

function describeError(url: string, status: number, body: string): string {
  if (url.includes('/ai/') && status === 403) return 'Der BANKSapi-Mandant ist nicht für AI/Connect freigeschaltet';
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed.message ?? parsed.detail ?? parsed.error ?? '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = body.slice(0, 200);
  }
  return `BANKSapi antwortet mit HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** 451 + Location → Session-Link für die REG/Protect Web Component. */
function regProtectSession(res: Response, accessId: string, callbackUrl: string): RegProtectSession {
  const location = res.headers.get('location');
  if (res.status !== 451 || !location) {
    throw new BanksapiError(`REG/Protect-Sitzung erwartet, erhalten: HTTP ${res.status}`, res.status);
  }
  const separator = location.includes('?') ? '&' : '?';
  return { accessId, sessionLink: `${location}${separator}callbackUrl=${encodeURIComponent(callbackUrl)}` };
}

// ---------------------------------------------------------------------------
// BANKS/Connect

/** Alte, evtl. abgebrochene REG/Protect-Sitzungen verwerfen (Best Practice laut BANKSapi). */
async function invalidateRegProtectSessions(): Promise<void> {
  await userRequest('/customer/v2/regprotect/sessions', { method: 'DELETE', accept: [404] });
}

/** Startet „Bankkonto verbinden“. Die Bankauswahl und SCA übernimmt REG/Protect im Browser. */
export async function startAddBankAccess(callbackUrl: (accessId: string) => string, customerIp?: string) {
  await invalidateRegProtectSessions();
  const accessId = randomUUID();
  const res = await userRequest('/customer/v2/bankzugaenge', {
    method: 'POST',
    body: { [accessId]: {} },
    customerIp,
    accept: [451],
  });
  return regProtectSession(res, accessId, callbackUrl(accessId));
}

export async function getBankAccesses(): Promise<BankAccess[]> {
  if (!hasUser()) return [];
  const res = await userRequest('/customer/v2/bankzugaenge');
  const body = (await res.json()) as Record<string, BankAccess> | null;
  return Object.values(body ?? {});
}

export function relation(item: { relations?: Relation[] }, rel: string): string | undefined {
  return item.relations?.find((r) => r.rel === rel)?.href;
}

/**
 * Daten bei der Bank neu abrufen. Liefert eine REG/Protect-Sitzung, falls die Bank
 * dafür eine erneute Zustimmung (SCA) verlangt, sonst `null`.
 */
export async function refreshBankAccess(
  accessId: string,
  callbackUrl: string,
  customerIp?: string,
): Promise<RegProtectSession | null> {
  await invalidateRegProtectSessions();
  const res = await userRequest('/customer/v2/bankzugaenge?refresh=true', {
    method: 'POST',
    body: { [accessId]: {} },
    customerIp,
    accept: [451],
  });
  return res.status === 451 ? regProtectSession(res, accessId, callbackUrl) : null;
}

/** Abgelaufene Zustimmung erneuern (Relation `start_sca` am Bankzugang). */
export async function startSca(access: BankAccess, callbackUrl: string, customerIp?: string): Promise<RegProtectSession> {
  const href = relation(access, 'start_sca');
  if (!href) throw new BanksapiError('Für diesen Bankzugang ist keine Zustimmung zu erneuern', 409);
  await invalidateRegProtectSessions();
  const res = await userRequest(href, { method: 'POST', body: {}, customerIp, accept: [451] });
  return regProtectSession(res, access.id, callbackUrl);
}

export async function deleteBankAccess(accessId: string, customerIp?: string): Promise<void> {
  await userRequest(`/customer/v2/bankzugaenge/${encodeURIComponent(accessId)}`, {
    method: 'DELETE',
    customerIp,
    accept: [404],
  });
}

/** Gebuchte Umsätze eines Kontos ab `from` (YYYY-MM-DD). */
export async function getTransactions(access: BankAccess, product: BankProduct, from: string): Promise<Transaction[]> {
  const href =
    relation(product, 'get_kontoumsaetze') ??
    `/customer/v2/bankzugaenge/${encodeURIComponent(access.id)}/${encodeURIComponent(product.id)}/kontoumsaetze`;
  const url = new URL(href, BASE_URL);
  url.searchParams.set('from', `${from}T00:00:00`);
  const res = await userRequest(url.toString());
  return ((await res.json()) as Transaction[] | null) ?? [];
}

// ---------------------------------------------------------------------------
// AI/Connect

/**
 * Gleicht Ausgangsrechnungen mit den Umsätzen aller Bankzugänge des Nutzers ab.
 * Ein Ergebnis pro Rechnung, in Eingabereihenfolge.
 */
export async function matchInvoices(
  invoices: ExtractedInvoice[],
  excludeTransactions: TransactionRef[],
): Promise<InvoiceMatchResult[]> {
  const res = await userRequest('/customer/v2/ai/invoice-matching/', {
    method: 'POST',
    body: {
      invoices,
      invoiceDirection: 'receivable',
      excludeTransactions,
      assignUnique: true,
    },
  });
  const results = (await res.json()) as InvoiceMatchResult[];
  if (!Array.isArray(results) || results.length !== invoices.length) {
    throw new BanksapiError('Unerwartete Antwort von AI/Connect (Anzahl Ergebnisse passt nicht)', 502);
  }
  return results;
}
