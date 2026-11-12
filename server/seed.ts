/**
 * Setzt die Datenbank auf Beispieldaten zurück: `npm run seed`
 *
 * Datumswerte zählen vom Stichtag aus, dem Ersten des laufenden Monats. Das passt zum Demo-Geschäftskonto
 * „demo_buchhaltung" beim BANKSapi Demo Provider, dessen Umsätze vom selben Stichtag aus datiert sind und die
 * Rechnungsnummern RE-<Jahr>-<MM><NN> tragen (z. B. RE-2026-1107 im November 2026).
 */
import './env';
import { db } from './db';
import { today } from './domain';

const stichtag = `${today().slice(0, 7)}-01`;

function daysFromStichtag(days: number): string {
  const d = new Date(`${stichtag}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const customers = [
  ['K-10001', 'Hofmann Gartenbau GmbH', 'DE44500105175407324931', 'buchhaltung@hofmann-gartenbau.example'],
  ['K-10002', 'Café Lindenblüte', 'DE12500105170648489890', 'info@cafe-lindenbluete.example'],
  ['K-10003', 'Kanzlei Berger & Partner', 'DE89370400440532013000', 'rechnungen@kanzlei-berger.example'],
  ['K-10004', 'Weber Elektrotechnik KG', 'DE02120300000000202051', 'office@weber-elektro.example'],
  ['K-10005', 'Praxis Dr. Sommer', 'DE75512108001245126199', 'verwaltung@praxis-sommer.example'],
  ['K-10006', 'Brauhaus am Markt GmbH', 'DE20701500000012345678', 'einkauf@brauhaus-am-markt.example'],
  ['K-10007', 'Schreinerei Holzmann', null, 'holzmann@schreinerei.example'],
] as const;

// [Kunde, Rechnungsdatum (Tage ab Stichtag), Zahlungsziel (Tage), Betrag in Cent, Beschreibung, Zahlungen [Tage ab Stichtag, Cent]]
const invoices: [string, number, number, number, string, [number, number][]][] = [
  ['K-10001', -75, 14, 238_000, 'Gestaltung Firmenbroschüre', [[-58, 238_000]]],
  ['K-10002', -62, 14, 59_500, 'Speisekarten Herbst, Satz und Druckvorbereitung', [[-50, 59_500]]],
  ['K-10003', -48, 30, 476_000, 'Relaunch Website, 1. Abschlag', [[-20, 200_000]]],
  ['K-10004', -41, 14, 154_700, 'Logo-Überarbeitung und Geschäftsausstattung', []],
  ['K-10005', -35, 14, 89_250, 'Praxisflyer und Terminkarten', []],
  ['K-10006', -30, 30, 321_300, 'Etiketten Winterbock, Entwurf und Reinzeichnung', []],
  ['K-10001', -21, 14, 71_400, 'Anzeige Gartenmesse', []],
  ['K-10007', -18, 30, 113_050, 'Fotoshooting Werkstatt', []],
  ['K-10002', -12, 14, 23_800, 'Social-Media-Vorlagen', []],
  ['K-10002', -10, 14, 11_900, 'Tischaufsteller', []],
  ['K-10003', -9, 30, 476_000, 'Relaunch Website, 2. Abschlag', []],
  ['K-10004', -5, 14, 41_650, 'Visitenkarten Nachdruck', []],
  ['K-10006', -2, 30, 199_920, 'Messestand Bierbörse, Grafik', []],
];

// Die Bankverbindung (banksapi_user) bleibt erhalten, nur Buchhaltungs- und Abgleichsdaten werden zurückgesetzt
db.exec(
  'DELETE FROM bank_proposals; DELETE FROM bank_dismissals; DELETE FROM bank_runs; DELETE FROM payments; DELETE FROM invoices; DELETE FROM customers;',
);

const insertCustomer = db.prepare('INSERT INTO customers (customer_number, name, iban, email) VALUES (?, ?, ?, ?)');
const customerIds = new Map<string, number>();
for (const [number, name, iban, email] of customers) {
  customerIds.set(number, Number(insertCustomer.run(number, name, iban, email).lastInsertRowid));
}

const insertInvoice = db.prepare(
  'INSERT INTO invoices (number, customer_id, issue_date, due_date, amount_cents, description) VALUES (?, ?, ?, ?, ?, ?)',
);
const insertPayment = db.prepare('INSERT INTO payments (invoice_id, booked_on, amount_cents, note) VALUES (?, ?, ?, ?)');
const [year, month] = stichtag.split('-');
invoices.forEach(([customer, issued, term, amount, description, payments], index) => {
  const number = `RE-${year}-${month}${String(index + 1).padStart(2, '0')}`;
  const invoiceId = Number(
    insertInvoice.run(number, customerIds.get(customer)!, daysFromStichtag(issued), daysFromStichtag(issued + term), amount, description)
      .lastInsertRowid,
  );
  for (const [booked, cents] of payments) {
    insertPayment.run(invoiceId, daysFromStichtag(booked), cents, 'Kontoauszug geprüft');
  }
});

console.log(`Beispieldaten angelegt: ${customers.length} Kunden, ${invoices.length} Rechnungen`);
