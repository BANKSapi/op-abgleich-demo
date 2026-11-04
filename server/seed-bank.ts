/**
 * Nur für BANKSapi-Testmandanten: `npm run seed:bank`
 *
 * Legt für den BANKSapi-Benutzer von Kontor ein Testkonto (Bank Access Builder) mit Zahlungseingängen
 * zu den Beispielrechnungen aus `npm run seed` an. So lässt sich der Abgleich ohne echtes Bankkonto
 * vorführen – die Demo-Bank von BANKSapi liefert nur zufällige Umsätze.
 *
 * Voraussetzung: In der Oberfläche wurde einmal „Bankkonto verbinden“ gestartet (legt den Benutzer an).
 */
import './env';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { today } from './domain';

const base = process.env.BANKSAPI_BASE_URL ?? 'https://banksapi.io';
const basicAuth = process.env.BANKSAPI_BASIC_AUTH ?? '';
const user = db.prepare('SELECT username, password FROM banksapi_user WHERE id = 1').get() as
  | { username: string; password: string }
  | undefined;
if (!user || !basicAuth) {
  console.error('Kein BANKSapi-Benutzer: zuerst in Kontor unter „Bankabgleich“ auf „Bankkonto verbinden“ klicken.');
  process.exit(1);
}

const tokenRes = await fetch(`${base}/auth/oauth2/token`, {
  method: 'POST',
  headers: {
    Authorization: basicAuth.startsWith('Basic ') ? basicAuth : `Basic ${basicAuth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ grant_type: 'password', username: user.username, password: user.password }),
});
if (!tokenRes.ok) throw new Error(`Token: HTTP ${tokenRes.status}`);
const { access_token: token } = (await tokenRes.json()) as { access_token: string };
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

function day(offset: number): string {
  const d = new Date(`${today()}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return `${d.toISOString().slice(0, 10)} 00:00:00`;
}
const year = today().slice(0, 4);
const re = (n: number) => `RE-${year}-${String(n).padStart(4, '0')}`;

// Passend zu den Beispielrechnungen in seed.ts (Nummern RE-<Jahr>-0101 …)
const transactions = [
  // eindeutig: Rechnungsnummer, Betrag und IBAN stimmen → wird automatisch gebucht
  { betrag: 1547.0, buchungsdatum: day(-20), gegenkontoInhaber: 'Weber Elektrotechnik KG', gegenkontoIban: 'DE02120300000000202051', verwendungszweck: `${re(104)} Logo-Ueberarbeitung` },
  { betrag: 892.5, buchungsdatum: day(-15), gegenkontoInhaber: 'Praxis Dr. Sommer', gegenkontoIban: 'DE75512108001245126199', verwendungszweck: `Rechnung ${re(105)}` },
  // Restzahlung nach erfasster Abschlagszahlung
  { betrag: 2760.0, buchungsdatum: day(-8), gegenkontoInhaber: 'Kanzlei Berger & Partner', gegenkontoIban: 'DE89370400440532013000', verwendungszweck: `Restzahlung ${re(103)}` },
  // Skonto: 2 % abgezogen → Vorschlag
  { betrag: 3148.74, buchungsdatum: day(-12), gegenkontoInhaber: 'Brauhaus am Markt GmbH', gegenkontoIban: 'DE20701500000012345678', verwendungszweck: `${re(106)} abzgl. 2% Skonto` },
  // Sammelüberweisung über zwei Rechnungen → Vorschlag
  { betrag: 357.0, buchungsdatum: day(-3), gegenkontoInhaber: 'Cafe Lindenbluete', gegenkontoIban: 'DE12500105170648489890', verwendungszweck: `${re(109)} ${re(110)}` },
  // ohne Rechnungsnummer, Kunde ohne hinterlegte IBAN → Vorschlag
  { betrag: 1130.5, buchungsdatum: day(-6), gegenkontoInhaber: 'Holzmann, Peter', gegenkontoIban: 'DE44500105175407324931', verwendungszweck: 'Fotos Werkstatt' },
  // ohne Bezug zu Rechnungen
  { betrag: 49.9, buchungsdatum: day(-10), gegenkontoInhaber: 'Telekom Deutschland GmbH', gegenkontoIban: 'DE81100100100123456789', verwendungszweck: 'Gutschrift Kundenkonto' },
  { betrag: -1250.0, buchungsdatum: day(-25), gegenkontoInhaber: 'Hausverwaltung Kramer', gegenkontoIban: 'DE51100100100987654321', verwendungszweck: 'Miete Buero' },
];

const iban = 'DE02100100100006820101';
const accessId = randomUUID();
const builder = await fetch(`${base}/customer/v2/bankzugaenge/builder`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    id: accessId,
    providerId: '00000000-0000-0000-0000-000000000000',
    bankprodukte: [
      {
        id: iban,
        status: 'VOLLSTAENDIG',
        bezeichnung: 'Geschäftskonto (Testdaten)',
        kategorie: 'GIROKONTO',
        saldo: 12_480.35,
        aktualisierungszeitpunkt: day(0),
        saldoDatum: day(0),
        waehrung: 'EUR',
        kontonummer: '0006820101',
        iban,
        bic: 'PBNKDEFFXXX',
        blz: '10010010',
        kreditinstitut: 'Testbank (BANKSapi Builder)',
        inhaber: process.env.COMPANY_NAME ?? 'Muster Design GmbH',
      },
    ],
  }),
});
if (builder.status !== 201) throw new Error(`Builder: HTTP ${builder.status} ${await builder.text()}`);

const push = await fetch(`${base}/customer/v2/bankzugaenge/${accessId}/${iban}/kontoumsaetze`, {
  method: 'POST',
  headers,
  body: JSON.stringify(transactions.map((t) => ({ ...t, waehrung: 'EUR', wertstellungsdatum: t.buchungsdatum }))),
});
if (push.status !== 201) throw new Error(`Umsätze: HTTP ${push.status} ${await push.text()}`);

console.log(`Testkonto ${iban} mit ${transactions.length} Umsätzen angelegt (Bankzugang ${accessId}).`);
