# Kontor

Schlanke Buchhaltung für kleine Unternehmen: Kunden, Ausgangsrechnungen und offene Posten.
Zahlungseingänge werden bisher von Hand erfasst („Zahlung erfassen“ an der Rechnung).

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

## Aufbau

```
server/          Express-API (TypeScript, läuft mit tsx)
  db.ts          SQLite-Schema (node:sqlite)
  domain.ts      Status offener Posten, Beträge, Datumsprüfung
  repository.ts  Datenzugriff
  index.ts       REST-Endpunkte unter /api
  seed.ts        Beispieldaten
src/             Oberfläche (React, Vite)
  pages/         Übersicht, Offene Posten, Rechnung, Kunden
  components/    Status-Badge, Dialog „Zahlung erfassen“
```

## Datenmodell

- `customers`: Kundennummer, Name, IBAN, E-Mail
- `invoices`: Rechnungsnummer (`RE-<Jahr>-<laufende Nr.>`), Kunde, Rechnungsdatum, Fälligkeit, Bruttobetrag in Cent
- `payments`: Zahlungseingänge zu einer Rechnung (Buchungsdatum, Betrag in Cent, Erfassungsart, Notiz)

Offener Betrag und Status (`offen`, `teilbezahlt`, `ueberfaellig`, `bezahlt`) werden aus Rechnung und Zahlungen berechnet.
