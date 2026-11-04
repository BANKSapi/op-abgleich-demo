import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Nur das Backend lädt .env; Vite bekommt keine BANKSapi-Zugangsdaten.
if (existsSync('.env')) loadEnvFile('.env');
