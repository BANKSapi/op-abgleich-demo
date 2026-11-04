import { useEffect, useRef, useState } from 'react';

interface RegProtectElement extends HTMLElement {
  sessionLink: string;
  reentryUrl: string;
}

/** Hierher kehrt der Browser nach einer Redirect-SCA auf der Seite der Bank zurück. */
export const REENTRY_PATH = '/bankabgleich/rueckkehr';
/** callbackUrl für REG/Protect, falls der Browser selbst dorthin navigiert. */
export const CALLBACK_PATH = '/bankabgleich/fertig';

interface Props {
  /** Session-Link aus dem Backend; leer bei Rückkehr von der Bank (Sitzung liegt dann im localStorage der Komponente) */
  sessionLink: string;
  /** Wird mit der callbackUrl inkl. `baReentry` aufgerufen, sobald REG/Protect fertig ist */
  onFinished: (callbackUrl: string) => void;
}

/**
 * Bettet die BANKSapi REG/Protect Web Component (WEB/Connect) ein. Bankauswahl,
 * Zugangsdaten und SCA laufen vollständig in der Komponente bei BANKSapi –
 * Kontor sieht weder Online-Banking-Zugangsdaten noch TANs.
 */
export function RegProtect({ sessionLink, onFinished }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let element: RegProtectElement | undefined;
    const onSubscribed = (event: Event) => finished.current(String((event as CustomEvent).detail ?? ''));

    // Das Bundle ist groß (~1 MB) und wird daher erst bei Bedarf geladen
    import('@banksapitechnology/regprotect-web-component').then(
      () => {
        // In React StrictMode wird der Effekt einmal verworfen; der Session-Link ist nur einmal nutzbar
        if (cancelled || !container.current) return;
        element = document.createElement('ba-regprotect') as RegProtectElement;
        element.sessionLink = sessionLink;
        element.reentryUrl = `${window.location.origin}${REENTRY_PATH}?redirect=${Date.now()}`;
        element.addEventListener('subscribed', onSubscribed);
        container.current.appendChild(element);
      },
      () => setError('Die Bankverbindungs-Komponente konnte nicht geladen werden.'),
    );

    return () => {
      cancelled = true;
      element?.removeEventListener('subscribed', onSubscribed);
      element?.remove();
    };
  }, [sessionLink]);

  return error ? <p className="error">{error}</p> : <div ref={container} className="regprotect" />;
}

const reentryMessages: Record<string, string> = {
  ACCOUNT_CREATED: 'Das Bankkonto ist verbunden.',
  WAITING_FOR_PROVIDER: 'Die Bank braucht noch etwas für die Umsätze. Starten Sie den Abgleich in ein paar Minuten erneut.',
  USER_CANCELLED: 'Der Vorgang wurde abgebrochen.',
  LEGAL_NOT_ACCEPTED: 'Ohne Zustimmung zu den Nutzungsbedingungen von BANKSapi kann kein Konto verbunden werden.',
  INVALID_CREDENTIALS: 'Die Zugangsdaten zum Online-Banking waren nicht korrekt.',
  INVALID_TAN: 'Die TAN war nicht korrekt.',
  ERROR_NO_ACCOUNTS: 'Bei dieser Bank wurden keine Konten gefunden.',
  NO_ACCOUNTS: 'Bei dieser Bank wurden keine passenden Konten gefunden.',
  SESSION_TIMEOUT: 'Die Sitzung ist abgelaufen. Bitte erneut versuchen.',
  INVALID_SESSION: 'Die Sitzung ist ungültig oder abgelaufen. Bitte erneut versuchen.',
  INVALID_CALLBACK_URL_BASE:
    'Die Rücksprungadresse ist für den BANKSapi-Mandanten nicht freigegeben (PUBLIC_URL bzw. Allowlist prüfen).',
  CONCURRENT_CREATION_OF_SAME_ACCESS: 'Dieser Bankzugang wird gerade bereits angelegt.',
};

/** Ergebnis aus der callbackUrl lesen (`baReentry`). */
export function describeReentry(callbackUrl: string): { success: boolean; message: string } {
  let code = '';
  try {
    code = new URL(callbackUrl, window.location.origin).searchParams.get('baReentry') ?? '';
  } catch {
    // ungültige URL: als unbekanntes Ergebnis behandeln
  }
  return {
    success: code === 'ACCOUNT_CREATED',
    message: reentryMessages[code] ?? `Der Vorgang bei BANKSapi wurde beendet${code ? ` (${code})` : ''}.`,
  };
}
