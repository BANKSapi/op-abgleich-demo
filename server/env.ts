import { existsSync } from 'node:fs';

// .env laden, bevor andere Module Umgebungsvariablen lesen (bereits gesetzte Variablen haben Vorrang)
if (existsSync('.env')) process.loadEnvFile('.env');
