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

  -- Technischer BANKSapi-Benutzer der Firma (genau einer pro Installation)
  CREATE TABLE IF NOT EXISTS banksapi_user (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Zuordnungsvorschläge aus dem letzten Bankabgleich, die noch bestätigt werden müssen
  CREATE TABLE IF NOT EXISTS bank_proposals (
    id             INTEGER PRIMARY KEY,
    invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    access_id      TEXT NOT NULL,
    product_id     TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    booked_on      TEXT NOT NULL,
    tx_cents       INTEGER NOT NULL,
    book_cents     INTEGER NOT NULL CHECK (book_cents > 0),
    counterparty   TEXT NOT NULL DEFAULT '',
    purpose        TEXT NOT NULL DEFAULT '',
    match_status   TEXT NOT NULL,
    match_type     TEXT NOT NULL,
    confidence     REAL NOT NULL,
    notes          TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (invoice_id, product_id, transaction_id)
  );

  -- Zuordnungen, die abgelehnt wurden (Vorschlag verworfen oder Zahlung aus dem Abgleich entfernt).
  -- Sie werden bei späteren Abgleichen weder gebucht noch erneut vorgeschlagen.
  CREATE TABLE IF NOT EXISTS bank_dismissals (
    invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id     TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (invoice_id, product_id, transaction_id)
  );

  CREATE TABLE IF NOT EXISTS bank_runs (
    id           INTEGER PRIMARY KEY,
    finished_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    invoices     INTEGER NOT NULL,
    transactions INTEGER NOT NULL,
    booked       INTEGER NOT NULL,
    proposed     INTEGER NOT NULL,
    unmatched    INTEGER NOT NULL
  );
`);

// Migration: Zahlungen aus dem Bankabgleich verweisen auf den Kontoumsatz bei BANKSapi
const paymentColumns = (db.prepare('PRAGMA table_info(payments)').all() as { name: string }[]).map((c) => c.name);
for (const column of ['bank_access_id', 'bank_product_id', 'bank_transaction_id']) {
  if (!paymentColumns.includes(column)) db.exec(`ALTER TABLE payments ADD COLUMN ${column} TEXT`);
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS payments_bank_transaction
    ON payments (invoice_id, bank_product_id, bank_transaction_id)
    WHERE bank_transaction_id IS NOT NULL
`);

/** Führt fn in einer Transaktion aus. */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
