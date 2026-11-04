/**
 * Lädt `.env` (falls vorhanden), bevor andere Module Umgebungsvariablen lesen.
 * Muss als erstes Modul importiert werden. Bereits gesetzte Variablen haben Vorrang.
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
