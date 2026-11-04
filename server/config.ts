import { existsSync } from 'node:fs';

// .env laden (Node ≥ 22.13), falls vorhanden. Bereits gesetzte Variablen haben Vorrang.
if (existsSync('.env')) process.loadEnvFile('.env');

export interface BanksapiConfig {
  baseUrl: string;
  tenant: string;
  /** Wert für den Authorization-Header, immer mit "Basic "-Präfix. */
  basicAuth: string;
  /** Technischer BANKSapi-Benutzer, der dieses Unternehmen repräsentiert. */
  username: string;
  /** Basis-URL dieser Anwendung, Ziel der Weiterleitung nach REG/Protect. */
  appBaseUrl: string;
  /** Name des Rechnungsstellers (Pflichtfeld für AI/Connect, hier das eigene Unternehmen). */
  companyName: string;
  /** Eindeutige Treffer ohne Rückfrage verbuchen. */
  autoBook: boolean;
}

/** Gibt null zurück, solange die Zugangsdaten nicht gesetzt sind. */
export function banksapiConfig(): BanksapiConfig | null {
  const tenant = process.env.BANKSAPI_TENANT?.trim();
  const basic = process.env.BANKSAPI_BASIC_AUTH?.trim();
  if (!tenant || !basic) return null;
  const port = process.env.PORT ?? '3001';
  const production = process.env.NODE_ENV === 'production';
  return {
    baseUrl: (process.env.BANKSAPI_BASE_URL ?? 'https://banksapi.io').replace(/\/$/, ''),
    tenant,
    basicAuth: /^basic\s/i.test(basic) ? basic : `Basic ${basic}`,
    username: process.env.BANKSAPI_USERNAME?.trim() || 'kontor',
    appBaseUrl: (process.env.APP_BASE_URL ?? (production ? `http://localhost:${port}` : 'http://localhost:5173')).replace(/\/$/, ''),
    companyName: process.env.COMPANY_NAME?.trim() || 'Muster Design GmbH',
    autoBook: process.env.BANK_AUTO_BOOK !== 'false',
  };
}
