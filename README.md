# Kontor

Schlanke Buchhaltung für kleine Unternehmen: Kunden, Ausgangsrechnungen und offene Posten.
Zahlungseingänge lassen sich von Hand erfassen („Zahlung erfassen“ an der Rechnung) oder über die Bankanbindung (BANKSapi) automatisch mit den offenen Posten abgleichen.

## Starten

```bash
npm install
npm run seed   # Beispieldaten anlegen (setzt die Datenbank zurück)
npm run dev    # API auf :3001, Oberfläche auf http://localhost:5173
```

Weitere Befehle:

| Befehl          | Zweck                                         |
| --------------- | --------------------------------------------- |
| `npm test`      | Unit-Tests (Node Test Runner)                 |
| `npm run build` | Typprüfung und Frontend-Build nach `dist/`    |
| `npm start`     | API liefert das gebaute Frontend mit aus      |

Konfiguration über Umgebungsvariablen, siehe `.env.example`.

## Bankabgleich (BANKSapi)

Seite **Bankabgleich** in der Oberfläche:

1. **Bankkonto verbinden**: Das Backend startet eine REG/Protect-Sitzung, die Oberfläche bettet die WEB/Connect-Komponente
   `ba-regprotect` ein (Bankauswahl, Login, TAN/SCA). Für den Test steht der [Demo Provider](https://docs.banksapi.de/guide/demo-provider) bereit.
2. **Umsätze abrufen und abgleichen**: Das Backend schickt die offenen Rechnungen (offener Betrag, Kunden-IBAN) an
   AI/Connect `POST /customer/v2/ai/invoice-matching/` und erhält je Rechnung den besten Zahlungseingang.
   Bereits verbuchte Umsätze werden als `excludeTransactions` mitgegeben.
3. Verbucht wird so:
   - **Automatisch** nur bei eindeutigem Treffer: Status `matched`, Typ `exact` (IBAN, Betrag auf den Cent und Rechnungsnummer), Konfidenz ≥ 95 %.
   - **Zur Bestätigung** (Teilzahlung, Skonto, Überzahlung, Sammelüberweisung, nur Betrag oder Referenz): als Vorschlag mit „Verbuchen“ / „Ablehnen“.
     Bestätigt wird höchstens der offene Rechnungsbetrag; abgelehnte Paare kommen nicht wieder.
   - Jeder Umsatz kann nur einmal verbucht werden (Unique-Index auf `payments`). Gebuchte Zahlungen haben die Erfassungsart „Bankabgleich“
     und lassen sich wie manuelle Zahlungen entfernen.

Konfiguration in `.env` (siehe `.env.example`): `BANKSAPI_TENANT`, `BANKSAPI_BASIC_AUTH`; optional `BANKSAPI_USERNAME`, `APP_BASE_URL`,
`COMPANY_NAME`, `BANK_AUTO_BOOK=false` (alles nur vorschlagen). Die Zugangsdaten werden nur im Backend verwendet.

Hinweise:

- BANKSapi leitet nach der Bankanbindung auf `APP_BASE_URL` zurück. Diese Adresse muss in der Callback-Allowlist des Mandanten stehen,
  sonst bricht REG/Protect mit `INVALID_CALLBACK_URL_BASE` ab.
- Das Konto gehört einem technischen BANKSapi-Benutzer (Standard `kontor`), der beim ersten Aufruf angelegt wird. Sein Passwort wird aus den
  Mandanten-Zugangsdaten abgeleitet und nicht gespeichert.
- Die Zustimmung zum Kontozugriff (PSD2) läuft nach ca. 180 Tagen ab; dann erscheint „Zustimmung erneuern“.

## Aufbau

```
server/          Express-API (TypeScript, läuft mit tsx)
  db.ts          SQLite-Schema (node:sqlite)
  domain.ts      Status offener Posten, Beträge, Datumsprüfung
  repository.ts  Datenzugriff
  index.ts       REST-Endpunkte unter /api (inkl. /api/bank/…)
  config.ts      Lädt .env, BANKSapi-Konfiguration
  banksapi.ts    Client für BANKS/Connect und AI/Connect
  matching.ts    Reine Abgleichslogik (Auto-Buchungsregel)
  reconcile.ts   Ablauf des Abgleichs, Vorschläge bestätigen
  seed.ts        Beispieldaten
src/             Oberfläche (React, Vite)
  pages/         Übersicht, Offene Posten, Rechnung, Kunden
  components/    Status-Badge, Dialog „Zahlung erfassen“
  pages/Bank.tsx Bankanbindung (WEB/Connect) und Zahlungsabgleich
```

## Datenmodell

- `customers`: Kundennummer, Name, IBAN, E-Mail
- `invoices`: Rechnungsnummer (`RE-<Jahr>-<laufende Nr.>`), Kunde, Rechnungsdatum, Fälligkeit, Bruttobetrag in Cent
- `payments`: Zahlungseingänge zu einer Rechnung (Buchungsdatum, Betrag in Cent, Erfassungsart, Notiz, bei Bankabgleich Konto und Umsatz-ID)
- `bank_suggestions`: Zuordnungsvorschläge aus dem Bankabgleich, die noch bestätigt werden müssen

Offener Betrag und Status (`offen`, `teilbezahlt`, `ueberfaellig`, `bezahlt`) werden aus Rechnung und Zahlungen berechnet.
