/**
 * Schlanker Client für die BANKSapi-Schnittstellen, die Kontor nutzt:
 * - BANKS/Connect Auth: Client- und User-Token, technischen Benutzer anlegen
 * - BANKS/Connect Customer: Bankzugänge (REG/Protect), Kontoumsätze
 * - AI/Connect: Rechnungsabgleich (invoice-matching)
 *
 * Doku: https://docs.banksapi.de/guide/quickstart.html, https://docs.banksapi.de/guide/ai-connect.html
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from './db';

const baseUrl = new URL(process.env.BANKSAPI_BASE_URL ?? 'https://banksapi.io');

export class BanksApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.BANKSAPI_TENANT && process.env.BANKSAPI_BASIC_AUTH);
}

function config() {
  const tenant = process.env.BANKSAPI_TENANT;
  const basicAuth = process.env.BANKSAPI_BASIC_AUTH;
  if (!tenant || !basicAuth) {
    throw new BanksApiError('BANKSapi ist nicht konfiguriert (BANKSAPI_TENANT und BANKSAPI_BASIC_AUTH fehlen)');
  }
  return { tenant, basicAuth: basicAuth.startsWith('Basic ') ? basicAuth : `Basic ${basicAuth}` };
}

// ---------------------------------------------------------------------------
// Typen (Auszug aus der OpenAPI-Spezifikation)

export interface Relation {
  rel: string;
  href: string;
}

export interface Message {
  code?: string;
  level?: string;
  message?: string;
  details?: string;
}

export interface BankProduct {
  id: string;
  bezeichnung?: string;
  kategorie?: string;
  iban?: string;
  kreditinstitut?: string;
  inhaber?: string;
  saldo?: number;
  waehrung?: string;
  status?: string;
  aktualisierungszeitpunkt?: string;
  relations?: Relation[];
  messages?: Message[];
}

export interface BankAccess {
  id: string;
  providerId?: string;
  status?: string;
  aktualisierungszeitpunkt?: string;
  relations?: Relation[];
  messages?: Message[];
  bankprodukte?: BankProduct[];
}

export interface Transaction {
  id?: string;
  betrag: number;
  waehrung?: string;
  verwendungszweck?: string;
  buchungsdatum: string;
  gegenkontoInhaber?: string;
  gegenkontoIban?: string;
}

/** Rechnungsfelder nach EN 16931, wie sie AI/Connect erwartet (Schema ExtractedInvoice). */
export interface ExtractedInvoice {
  invoiceNumber: string;
  invoiceIssueDate: string;
  paymentDueDate?: string;
  amountDueForPayment: number;
  invoiceTotalAmountWithVat?: number;
  invoiceCurrencyCode: string;
  sellerName: string;
  buyerName?: string;
  buyerIdentifier?: string;
  debitedAccountIdentifier?: string;
}

export interface TransactionRef {
  id: string;
  productId?: string | null;
}

export type MatchStatus =
  | 'matched'
  | 'likely_matched'
  | 'partially_matched'
  | 'overpaid'
  | 'possible_batch'
  | 'unmatched'
  | 'extraction_failed';

export interface MatchCandidate {
  confidence: number;
  delta: number;
  matchType: string;
  notes?: string[];
  transaction: TransactionRef;
}

export interface InvoiceMatchResult {
  status: MatchStatus;
  matches?: MatchCandidate[];
  error?: string | null;
  remainingAmount?: number | null;
  totalMatchedAmount?: number | null;
}

export interface InvoiceMatchingRequest {
  invoices: ExtractedInvoice[];
  invoiceDirection?: 'receivable' | 'payable';
  excludeTransactions?: TransactionRef[];
  searchWindowDays?: number;
  assignUnique?: boolean;
}

/** Ergebnis eines interaktiven Aufrufs: entweder erledigt oder der Nutzer muss durch REG/Protect. */
export type InteractiveResult = { done: true } | { done: false; location: string };

// ---------------------------------------------------------------------------
// Tokens

interface CachedToken {
  value: string;
  expiresAt: number;
}

let clientToken: CachedToken | undefined;
let userToken: CachedToken | undefined;

async function createToken(body: Record<string, string>): Promise<CachedToken> {
  const res = await fetch(new URL('/auth/oauth2/token', baseUrl), {
    method: 'POST',
    headers: { Authorization: config().basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    throw new BanksApiError(`BANKSapi-Anmeldung fehlgeschlagen (HTTP ${res.status})`, res.status);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  // eine Minute Puffer, damit kein Token kurz vor Ablauf benutzt wird
  return { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
}

async function getClientToken(): Promise<string> {
  if (!clientToken || clientToken.expiresAt < Date.now()) {
    clientToken = await createToken({ grant_type: 'client_credentials' });
  }
  return clientToken.value;
}

interface StoredUser {
  username: string;
  password: string;
}

function storedUser(): StoredUser | undefined {
  return db.prepare('SELECT username, password FROM banksapi_user WHERE id = 1').get() as StoredUser | undefined;
}

export function hasUser(): boolean {
  return storedUser() !== undefined;
}

/**
 * Legt beim ersten Aufruf den technischen BANKSapi-Benutzer der Firma an.
 * Kontor ist eine Einzelmandanten-Anwendung, daher genügt ein Benutzer für alle Bankzugänge.
 */
async function ensureUser(): Promise<StoredUser> {
  const existing = storedUser();
  if (existing) return existing;

  const user = { username: `kontor-${randomUUID()}`, password: randomBytes(32).toString('base64url') };
  const res = await fetch(new URL(`/auth/mgmt/v1/tenants/${encodeURIComponent(config().tenant)}/users`, baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getClientToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (res.status !== 201) {
    throw new BanksApiError(`BANKSapi-Benutzer konnte nicht angelegt werden (HTTP ${res.status})`, res.status);
  }
  db.prepare('INSERT INTO banksapi_user (id, username, password) VALUES (1, ?, ?)').run(user.username, user.password);
  return user;
}

async function getUserToken(): Promise<string> {
  if (!userToken || userToken.expiresAt < Date.now()) {
    const user = await ensureUser();
    userToken = await createToken({ grant_type: 'password', username: user.username, password: user.password });
  }
  return userToken.value;
}

// ---------------------------------------------------------------------------
// Customer API

/**
 * URLs aus `relations` kommen von BANKSapi. Bevor der Bearer-Token mitgeschickt wird,
 * prüfen wir, dass die URL wirklich auf BANKSapi zeigt.
 */
function apiUrl(pathOrHref: string): URL {
  const url = new URL(pathOrHref, baseUrl);
  if (url.protocol !== baseUrl.protocol || url.hostname !== baseUrl.hostname) {
    throw new BanksApiError(`Unerwartete BANKSapi-URL: ${url.origin}`);
  }
  // BANKSapi liefert in Relationen teils den Standardport explizit mit (https://banksapi.io:443/…)
  url.port = baseUrl.port;
  return url;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  customerIp?: string;
  query?: Record<string, string | undefined>;
}

async function customerRequest(pathOrHref: string, options: RequestOptions = {}): Promise<Response> {
  const url = apiUrl(pathOrHref);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${await getUserToken()}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.customerIp) headers['Customer-IP-Address'] = options.customerIp;
  return fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
}

async function expectJson<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) throw new BanksApiError(`${action} fehlgeschlagen (HTTP ${res.status})`, res.status);
  return (await res.json()) as T;
}

/** 451 + Location bedeutet: Der Nutzer muss den Vorgang in REG/Protect abschließen. */
function interactive(res: Response, action: string): InteractiveResult {
  if (res.status === 451) {
    const location = res.headers.get('location');
    if (!location) throw new BanksApiError(`${action}: BANKSapi hat keinen REG/Protect-Link geliefert`);
    return { done: false, location: apiUrl(location).toString() };
  }
  if (res.ok) return { done: true };
  throw new BanksApiError(`${action} fehlgeschlagen (HTTP ${res.status})`, res.status);
}

/** Alte, ggf. abgebrochene REG/Protect-Sitzungen verwerfen, bevor ein neuer Vorgang startet. */
async function deleteRegProtectSessions(): Promise<void> {
  const res = await customerRequest('/customer/v2/regprotect/sessions', { method: 'DELETE' });
  if (!res.ok) throw new BanksApiError(`REG/Protect-Sitzungen konnten nicht beendet werden (HTTP ${res.status})`, res.status);
}

/** Startet das Hinzufügen eines Bankzugangs; der Nutzer wählt Bank und Konten in REG/Protect. */
export async function startAddBankAccess(customerIp: string | undefined): Promise<{ accessId: string; location: string }> {
  await deleteRegProtectSessions();
  const accessId = randomUUID();
  const res = await customerRequest('/customer/v2/bankzugaenge', {
    method: 'POST',
    body: { [accessId]: {} },
    customerIp,
    // Für den ersten Abruf auch Umsätze älter als 90 Tage holen (spart spätere SCA)
    query: { maxTransactions: 'paymentAccounts', paymentAccountsOnly: 'true' },
  });
  const result = interactive(res, 'Bankzugang anlegen');
  if (result.done) throw new BanksApiError('BANKSapi hat keinen REG/Protect-Link geliefert (Mandant nicht für REG/Protect eingerichtet?)');
  return { accessId, location: result.location };
}

export async function listBankAccesses(): Promise<BankAccess[]> {
  const res = await customerRequest('/customer/v2/bankzugaenge');
  return Object.values(await expectJson<Record<string, BankAccess>>(res, 'Bankzugänge abrufen'));
}

async function getBankAccess(accessId: string): Promise<BankAccess> {
  const res = await customerRequest(`/customer/v2/bankzugaenge/${encodeURIComponent(accessId)}`);
  return expectJson<BankAccess>(res, 'Bankzugang abrufen');
}

/** Holt frische Daten von der Bank. Kann eine erneute Zustimmung (SCA) erfordern. */
export async function refreshBankAccess(accessId: string, customerIp: string | undefined): Promise<InteractiveResult> {
  await deleteRegProtectSessions();
  const res = await customerRequest('/customer/v2/bankzugaenge', {
    method: 'POST',
    body: { [accessId]: {} },
    customerIp,
    query: { refresh: 'true' },
  });
  return interactive(res, 'Bankzugang aktualisieren');
}

/** Erneuert die Zustimmung (Consent) über die Relation `start_sca`. */
export async function renewConsent(accessId: string, customerIp: string | undefined): Promise<InteractiveResult> {
  const access = await getBankAccess(accessId);
  const startSca = access.relations?.find((r) => r.rel === 'start_sca');
  if (!startSca) return { done: true };
  await deleteRegProtectSessions();
  const res = await customerRequest(startSca.href, { method: 'POST', body: {}, customerIp });
  return interactive(res, 'Zustimmung erneuern');
}

export async function deleteBankAccess(accessId: string, customerIp: string | undefined): Promise<void> {
  const res = await customerRequest(`/customer/v2/bankzugaenge/${encodeURIComponent(accessId)}`, {
    method: 'DELETE',
    customerIp,
  });
  if (!res.ok && res.status !== 404) {
    throw new BanksApiError(`Bankzugang konnte nicht entfernt werden (HTTP ${res.status})`, res.status);
  }
}

/** Gebuchte Umsätze eines Bankprodukts ab `from` (YYYY-MM-DD), über die Relation `get_kontoumsaetze`. */
export async function getTransactions(product: BankProduct, from: string): Promise<Transaction[]> {
  const relation = product.relations?.find((r) => r.rel === 'get_kontoumsaetze');
  if (!relation) return [];
  const res = await customerRequest(relation.href, { query: { from: `${from}T00:00:00` } });
  return expectJson<Transaction[]>(res, `Umsätze für ${product.iban ?? product.id} abrufen`);
}

// ---------------------------------------------------------------------------
// AI/Connect

/** Ordnet Rechnungen den Kontoumsätzen des Benutzers zu. Ergebnis in Reihenfolge der Rechnungen. */
export async function matchInvoices(request: InvoiceMatchingRequest): Promise<InvoiceMatchResult[]> {
  const res = await customerRequest('/customer/v2/ai/invoice-matching/', { method: 'POST', body: request });
  if (res.status === 403) {
    throw new BanksApiError('Der BANKSapi-Mandant ist nicht für AI/Connect freigeschaltet', 403);
  }
  if (res.status === 408) {
    throw new BanksApiError('AI/Connect hat nicht rechtzeitig geantwortet, bitte später erneut versuchen', 408);
  }
  return expectJson<InvoiceMatchResult[]>(res, 'Rechnungsabgleich (AI/Connect)');
}
