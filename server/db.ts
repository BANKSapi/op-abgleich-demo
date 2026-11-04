import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DATABASE_PATH ?? 'data/kontor.db';
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id              INTEGER PRIMARY KEY,
    customer_number TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    iban            TEXT,
    email           TEXT
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id           INTEGER PRIMARY KEY,
    number       TEXT NOT NULL UNIQUE,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    issue_date   TEXT NOT NULL,
    due_date     TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    description  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY,
    invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    booked_on    TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method       TEXT NOT NULL DEFAULT 'manuell',
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Einfache Schlüssel/Wert-Ablage, u. a. für den technischen BANKSapi-Nutzer
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Zahlungseingänge vom Bankkonto (nur Gutschriften), Zwischenspeicher für Anzeige und Abgleich
  CREATE TABLE IF NOT EXISTS bank_transactions (
    access_id         TEXT NOT NULL,
    product_id        TEXT NOT NULL,
    id                TEXT NOT NULL,
    booked_on         TEXT NOT NULL,
    amount_cents      INTEGER NOT NULL,
    counterparty_name TEXT NOT NULL DEFAULT '',
    counterparty_iban TEXT NOT NULL DEFAULT '',
    purpose           TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (access_id, product_id, id)
  );

  -- Zuordnungsvorschläge aus AI/Connect, die eine Bestätigung brauchen
  CREATE TABLE IF NOT EXISTS match_suggestions (
    id             INTEGER PRIMARY KEY,
    invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    access_id      TEXT NOT NULL,
    product_id     TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
    result_status  TEXT NOT NULL,
    match_type     TEXT NOT NULL,
    confidence     REAL NOT NULL,
    notes          TEXT NOT NULL DEFAULT '[]',
    state          TEXT NOT NULL DEFAULT 'offen' CHECK (state IN ('offen', 'abgelehnt')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (invoice_id, access_id, product_id, transaction_id)
  );
`);

// Migration: Zahlungen merken sich den Bankumsatz, aus dem sie stammen
const paymentColumns = (db.prepare('PRAGMA table_info(payments)').all() as { name: string }[]).map((c) => c.name);
for (const column of ['bank_access_id', 'bank_product_id', 'bank_transaction_id']) {
  if (!paymentColumns.includes(column)) db.exec(`ALTER TABLE payments ADD COLUMN ${column} TEXT`);
}
db.exec(
  'CREATE INDEX IF NOT EXISTS payments_bank_transaction ON payments (bank_access_id, bank_product_id, bank_transaction_id)',
);
