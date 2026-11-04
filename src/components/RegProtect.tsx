import { useEffect, useRef, useState } from 'react';

/** Rücksprungadresse nach einer Redirect-SCA bei der Bank; dort wird das Web Component neu gestartet. */
export const REENTRY_PATH = '/bank/reentry';

interface Props {
  /** Link aus dem 451-Location-Header inkl. callbackUrl. Leer beim Wiedereinstieg nach Redirect-SCA. */
  sessionLink?: string;
  /** Wird mit dem baReentry-Code aufgerufen, sobald REG/Protect fertig ist (z. B. ACCOUNT_CREATED). */
  onFinished: (baReentry: string) => void;
}

/**
 * Bettet das REG/Protect Web Component von BANKSapi (WEB/Connect) ein. Dort wählt der Nutzer seine
 * Bank und gibt die Online-Banking-Zugangsdaten ein – diese erreichen Kontor nie.
 * https://www.npmjs.com/package/@banksapitechnology/regprotect-web-component
 */
export function RegProtect({ sessionLink, onFinished }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let element: HTMLElement | undefined;

    function onSubscribed(event: Event) {
      // event.detail ist die callbackUrl, ergänzt um baReentry
      const detail = (event as CustomEvent<string>).detail;
      let code = 'ERROR';
      try {
        code = new URL(detail, window.location.href).searchParams.get('baReentry') ?? code;
      } catch {
        // ungültige URL → als Fehler behandeln
      }
      finished.current(code);
    }

    // Das Bundle ist groß (~1 MB) und wird nur hier gebraucht
    import('@banksapitechnology/regprotect-web-component').then(
      () => {
        // Die Sitzung lässt sich nur einmal öffnen: nicht starten, wenn die Komponente schon wieder weg ist
        if (cancelled || !container.current) return;
        element = document.createElement('ba-regprotect');
        Object.assign(element, {
          sessionLink: sessionLink ?? '',
          reentryUrl: `${window.location.origin}${REENTRY_PATH}`,
          portalButtonLabel: 'Zurück zu Kontor',
        });
        element.addEventListener('subscribed', onSubscribed);
        container.current.appendChild(element);
      },
      () => setError('Die Bankanbindung konnte nicht geladen werden. Bitte Seite neu laden.'),
    );

    return () => {
      cancelled = true;
      element?.removeEventListener('subscribed', onSubscribed);
      element?.remove();
    };
  }, [sessionLink]);

  if (error) return <p className="error">{error}</p>;
  return <div ref={container} className="regprotect" />;
}
