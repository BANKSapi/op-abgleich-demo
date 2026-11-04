import './env';
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

  CREATE TABLE IF NOT EXISTS banking_identities (
    tenant TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    activated INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY,
    tenant TEXT NOT NULL,
    access_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    booked_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    counterparty TEXT NOT NULL,
    purpose TEXT NOT NULL,
    UNIQUE (tenant, access_id, product_id, transaction_id)
  );

  CREATE TABLE IF NOT EXISTS bank_allocations (
    transaction_id INTEGER PRIMARY KEY REFERENCES bank_transactions(id),
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    payment_id INTEGER UNIQUE REFERENCES payments(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id INTEGER PRIMARY KEY,
    tenant TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    booked_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS reconciliation_results (
    tenant TEXT NOT NULL,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL REFERENCES reconciliation_runs(id),
    result TEXT NOT NULL,
    PRIMARY KEY (tenant, invoice_id)
  );
`);
