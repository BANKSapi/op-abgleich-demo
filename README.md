# Kontor

Schlanke Buchhaltung für kleine Unternehmen: Kunden, Ausgangsrechnungen und offene Posten.
Zahlungseingänge kommen per Bankabgleich (BANKSapi) oder werden von Hand erfasst („Zahlung erfassen“ an der Rechnung).

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

Konfiguration über Umgebungsvariablen, siehe `.env.example`. Eine `.env` im Projektverzeichnis wird beim Start automatisch geladen.

## Aufbau

```
server/          Express-API (TypeScript, läuft mit tsx)
  db.ts          SQLite-Schema (node:sqlite)
  domain.ts      Status offener Posten, Beträge, Datumsprüfung
  repository.ts  Datenzugriff
  index.ts       REST-Endpunkte unter /api
  seed.ts        Beispieldaten
  banksapi.ts    BANKSapi-Client (Tokens, Bankzugang, Umsätze, AI/Connect)
  matching.ts    Entscheidungsregeln: automatisch buchen oder vorschlagen
  reconcile.ts   Ablauf eines Abgleichs, Vorschläge bestätigen
  bank-routes.ts REST-Endpunkte unter /api/bank
src/             Oberfläche (React, Vite)
  pages/         Übersicht, Offene Posten, Rechnung, Kunden
  components/    Status-Badge, Dialog „Zahlung erfassen“, REG/Protect-Komponente
```

## Datenmodell

- `customers`: Kundennummer, Name, IBAN, E-Mail
- `invoices`: Rechnungsnummer (`RE-<Jahr>-<laufende Nr.>`), Kunde, Rechnungsdatum, Fälligkeit, Bruttobetrag in Cent
- `payments`: Zahlungseingänge zu einer Rechnung (Buchungsdatum, Betrag in Cent, Erfassungsart, Notiz, ggf. Bankumsatz)
- `bank_transactions`: Gutschriften der verbundenen Konten (Zwischenspeicher)
- `match_suggestions`: Zuordnungsvorschläge zur Prüfung, abgelehnte Zuordnungen
- `settings`: u. a. Zugangsdaten des technischen BANKSapi-Nutzers

Offener Betrag und Status (`offen`, `teilbezahlt`, `ueberfaellig`, `bezahlt`) werden aus Rechnung und Zahlungen berechnet.

## Bankabgleich (BANKSapi)

Seite **Bankabgleich**: Geschäftskonto verbinden, Zahlungseingänge abrufen und den offenen Posten zuordnen.

1. **Bankverbindung** – Kontor legt beim ersten Mal einen technischen BANKSapi-Nutzer an. „Bankkonto verbinden“
   startet einen Bankzugang; Bankauswahl, Online-Banking-Login und TAN laufen in der eingebetteten
   REG/Protect Web Component von BANKSapi (WEB/Connect, `@banksapitechnology/regprotect-web-component`).
   Kontor sieht keine Bankzugangsdaten. Zum Testen den „Demo Provider“ mit `demo` / `demo` wählen.
2. **Abgleich** – Kontor holt die Gutschriften der verbundenen Konten und schickt alle unbezahlten Rechnungen
   (Rechnungsnummer, offener Betrag, Fälligkeit, Kunde, Kundennummer, Kunden-IBAN) an
   AI/Connect *Invoice Matching*. Bereits voll verbuchte Umsätze werden ausgeschlossen.
3. **Buchen** – automatisch gebucht wird nur ein eindeutiger Treffer: Status `matched`, Treffertyp
   `exact`/`strong`/`reference_only`, Betrag auf den Cent genau, Sicherheit ≥ `BANKSAPI_AUTO_BOOK_CONFIDENCE`.
   Alles andere (Skonto, Teilzahlung, Sammelüberweisung, nur Betrag, Gebührenabzug …) erscheint unter
   **Zu prüfen** und wird per „Buchen“ oder „Ablehnen“ entschieden. Abgelehnte Zuordnungen werden nicht erneut
   vorgeschlagen. Eine Sammelüberweisung kann auf mehrere Rechnungen verteilt werden.

Der Abgleich läuft auf Knopfdruck, nach dem Verbinden eines Kontos, nach „Umsätze aktualisieren“ und
im Hintergrund (`BANKSAPI_RECONCILE_INTERVAL_MINUTES`). Bank-Buchungen lassen sich an der Rechnung wie
manuelle Zahlungen entfernen; der Umsatz steht danach wieder für den Abgleich zur Verfügung.

Hinweise für den Betrieb:

- Rücksprünge aus REG/Protect kommen unter `/bankabgleich/fertig` und `/bankabgleich/rueckkehr` (nach
  Redirect-SCA bei der Bank) an. Für den Produktivbetrieb `PUBLIC_URL` setzen und die Adresse bei BANKSapi
  in die Callback-Allowlist des Mandanten eintragen lassen.
- Die Zugangsdaten des technischen BANKSapi-Nutzers liegen unverschlüsselt in der SQLite-Datenbank.
  Die Datenbankdatei entsprechend schützen.
- Die Kontor-API hat keine eigene Anmeldung. Nur in einem vertrauenswürdigen Netz betreiben.
