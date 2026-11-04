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
`);

// Migration: Verweis auf den Bankumsatz, aus dem eine Zahlung entstanden ist.
// Der Unique-Index verhindert, dass derselbe Umsatz zweimal verbucht wird.
const paymentColumns = (db.prepare('PRAGMA table_info(payments)').all() as { name: string }[]).map((c) => c.name);
if (!paymentColumns.includes('bank_product_id')) {
  db.exec('ALTER TABLE payments ADD COLUMN bank_product_id TEXT; ALTER TABLE payments ADD COLUMN bank_transaction_id TEXT;');
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS payments_bank_transaction
    ON payments (bank_product_id, bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

  -- Von AI/Connect vorgeschlagene Zuordnungen Bankumsatz → Rechnung, die noch bestätigt werden müssen
  CREATE TABLE IF NOT EXISTS bank_suggestions (
    id             INTEGER PRIMARY KEY,
    invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id     TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'vorgeschlagen' CHECK (state IN ('vorgeschlagen', 'abgelehnt')),
    match_status   TEXT NOT NULL,
    match_type     TEXT NOT NULL,
    confidence     REAL NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    booked_on      TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL,
    counterparty   TEXT NOT NULL DEFAULT '',
    purpose        TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (invoice_id, product_id, transaction_id)
  );
`);
