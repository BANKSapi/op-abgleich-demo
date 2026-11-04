# Kontor

Schlanke Buchhaltung für kleine Unternehmen: Kunden, Ausgangsrechnungen und offene Posten.
Zahlungseingänge lassen sich von Hand erfassen oder über BANKSapi automatisch mit offenen Posten abgleichen.

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

## Bankanbindung und Zahlungsabgleich

1. `BANKSAPI_TENANT` und `BANKSAPI_BASIC_AUTH` aus dem BANKSapi-Onboarding in `.env` eintragen. Der Basic-Auth-Wert ist bereits Base64-kodiert; ein vorangestelltes `Basic` ist optional. `.env` wird beim Start serverseitig geladen. `COMPANY_NAME` bezeichnet den Rechnungsaussteller.
2. In **Bankabgleich → Bankkonto verbinden / Bankverbindungen verwalten** die Bank auswählen. WEB/Connect `ba-bam-dashboard` verwaltet Bankzugänge; `ba-regprotect` übernimmt Bankanmeldung und SCA/TAN. Der technische BANKSapi-Benutzer wird einmal pro Mandant angelegt und über Neustarts wiederverwendet.
3. Die Anwendungsadresse muss beim Mandanten als Callback-Basis zugelassen sein, falls BANKSapi eine Allowlist eingerichtet hat. Rücksprungadressen sind `<origin>/?bankingCallback=1#/bankabgleich` und `<origin>/?bankingReentry=1#/bankabgleich`. Für lokale Entwicklung ist der Origin `http://localhost:5173`.
4. Nach der Freigabe läuft ein Abgleich. **Jetzt abgleichen** startet weitere Läufe. Zusätzlich läuft bei gestartetem Server alle 15 Minuten ein Abgleich, auch ohne geöffneten Browser. `BANKSAPI_SYNC_INTERVAL_MINUTES=0` deaktiviert diesen Zeitplan. BANKSapi synchronisiert die Bankdaten separat; der Abgleich liest den vorhandenen Datenstand und erzwingt keine neue Bankabfrage. Eine nötige Bankfreigabe lässt sich in den Web Components erneuern.

AI/Connect erhält offene Ausgangsrechnungen über `POST /customer/v2/ai/invoice-matching/` mit `invoiceDirection: receivable`, `assignUnique: true` und einem Suchfenster von 180 Tagen nach Fälligkeit. Übermittelt werden Rechnungsnummer, Datum, Fälligkeit, EUR-Währung, Aussteller, Kunde, Kundennummer, Kunden-IBAN (`debitedAccountIdentifier`, BT-91), Bruttobetrag und der nach vorhandenen Zahlungen verbleibende offene Betrag. Die Kontoumsätze bleiben bei BANKSapi; die Anwendung importiert gebuchte Umsätze zur Auflösung der zurückgegebenen Umsatzreferenzen.

Automatisch gebucht werden eindeutige Ergebnisse mit Status `matched`, mindestens 90 % Konfidenz, mindestens 10 Prozentpunkten Abstand zum nächsten Kandidaten, exakt passendem offenem Betrag und bestätigter IBAN oder Rechnungsnummer. Der Umsatz muss ein gebuchter EUR-Eingang sein. Skonto, Überzahlungen, Sammelzahlungen, mehrdeutige Vorschläge und Teilzahlungen werden zur Prüfung angezeigt. Positive EUR-Teilzahlungen bis zum offenen Betrag können dort ausdrücklich zugeordnet werden; sie reduzieren den offenen Posten um den tatsächlich eingegangenen Betrag. Skonto wird dabei nicht als Erlass ausgebucht. Das vorhandene Datenmodell unterstützt keine automatische Aufteilung einer Sammelzahlung auf mehrere Rechnungen.

Bankumsätze werden mit Mandant, Bankzugang, Produkt-ID und Umsatz-ID dauerhaft identifiziert. Buchung und Verknüpfung zum Bankumsatz erfolgen in einer SQLite-Transaktion. Bereits zugeordnete oder ausgeschlossene Umsätze werden bei Folgeläufen als `excludeTransactions` an AI/Connect übergeben. Bei mehrdeutigen Produkt-/Umsatzreferenzen aus mehreren Bankzugängen erfolgt keine Zuordnung. Wird eine Bankzahlung an der Rechnung entfernt, bleibt der Bankumsatz ausgeschlossen und wird nicht erneut automatisch gebucht. **Ausschließen** ist ebenfalls dauerhaft. `npm run seed` setzt Buchhaltungs- und Abgleichdaten zurück; der technische BANKSapi-Benutzer bleibt erhalten.

Die technische Benutzerkennung und ihr zufälliges Passwort sind in SQLite mit AES-256-GCM verschlüsselt; der Schlüssel wird aus Mandant und `BANKSAPI_BASIC_AUTH` abgeleitet. Diese Konfiguration zusammen mit der Datenbank sichern: ein Wechsel des Basic-Auth-Werts erfordert eine Migration der gespeicherten Benutzerkennung. Client-Tokens und API-Zugangsdaten verlassen das Backend nicht. Die Web Components erhalten nur einen kurzlebigen Benutzertoken ohne Zahlungsinitiierungs-Scope; die Anwendung hält ihn im Arbeitsspeicher und erneuert ihn bei Ablauf. Lediglich der laufende REG/Protect-Sessionlink liegt bis zum Abschluss/Abbruch in `sessionStorage`, damit ein SCA-Rücksprung möglich ist. Die npm-Versionen der Widgets sind festgelegt und werden lokal über `/banking-widgets/` ausgeliefert.

Kontor ist weiterhin eine Anwendung für eine einzelne Firma ohne eigene Benutzeranmeldung. Ein öffentlicher Betrieb benötigt einen vorgeschalteten Zugangsschutz für die gesamte Anwendung einschließlich `/api` und HTTPS.

Die Rechnungszuordnung von AI/Connect ist derzeit als Beta dokumentiert. Die Integration prüft das Antwortformat und stoppt bei unerwarteten Antworten ohne neue Buchung. Die automatisierten Tests verwenden eine isolierte In-Memory-Datenbank und simulierte BANKSapi-Antworten; sie benötigen keine Testmandanten-Zugangsdaten.

Referenzen: [WEB/Connect](https://docs.banksapi.de/guide/webconnect.html), [BANKSapi-Referenzimplementierung](https://github.com/BANKSapi/banking-widgets-demo), [AI/Connect – Invoice Matching](https://docs.banksapi.de/api/ai-connect.html#tag/invoice-matching).

## Aufbau

```
server/          Express-API (TypeScript, läuft mit tsx)
  db.ts          SQLite-Schema (node:sqlite)
  domain.ts      Status offener Posten, Beträge, Datumsprüfung
  repository.ts  Datenzugriff
  index.ts       REST-Endpunkte unter /api
  seed.ts        Beispieldaten
  banksapi.ts    OAuth, technischer Benutzer und BANKSapi-Client
  reconciliation.ts  Umsatzimport, AI-Zuordnung, Buchungen und Zeitplan
  banking-routes.ts  REST-Endpunkte für Bankabgleich und Widget-Token
src/             Oberfläche (React, Vite)
  pages/         Übersicht, Offene Posten, Rechnung, Kunden
  components/    Status-Badge, Dialog „Zahlung erfassen“
```

## Datenmodell

- `customers`: Kundennummer, Name, IBAN, E-Mail
- `invoices`: Rechnungsnummer (`RE-<Jahr>-<laufende Nr.>`), Kunde, Rechnungsdatum, Fälligkeit, Bruttobetrag in Cent
- `payments`: Zahlungseingänge zu einer Rechnung (Buchungsdatum, Betrag in Cent, Erfassungsart, Notiz)
- `banking_identities`: verschlüsselte technische BANKSapi-Benutzer pro Mandant
- `bank_transactions`, `bank_allocations`: importierte Umsätze, dauerhafte Buchungsreferenzen und Ausschlüsse
- `reconciliation_runs`, `reconciliation_results`: Laufstatus und aktuelle AI/Connect-Vorschläge

Offener Betrag und Status (`offen`, `teilbezahlt`, `ueberfaellig`, `bezahlt`) werden aus Rechnung und Zahlungen berechnet.
