import { useEffect, useRef, useState } from 'react';

export const BANK_SESSION_KEY = 'kontor-regprotect-session';
let loading: Promise<void> | undefined;

function loadWidgets() {
  if (!loading) {
    const scripts = Promise.all([
      ['/banking-widgets/efc/efc-loader.js', 'module', 'ba-bam-dashboard'],
      ['/banking-widgets/regprotect/ba-regprotect.js', 'text/javascript', 'ba-regprotect'],
    ].map(([src, type, tag]) => new Promise<void>((resolve, reject) => {
      if (customElements.get(tag)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.type = type;
      script.onload = () => { customElements.whenDefined(tag).then(() => resolve()); };
      script.onerror = () => { script.remove(); reject(new Error('BANKSapi-Web-Components konnten nicht geladen werden. Bitte erneut öffnen.')); };
      document.head.appendChild(script);
    }))).then(() => undefined);
    loading = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Zeitlimit beim Laden der BANKSapi-Web-Components. Bitte erneut öffnen.')), 30_000);
      scripts.then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
    }).catch(error => { loading = undefined; throw error; });
  }
  return loading;
}

export function BankConnection({ token, onComplete, onError, onRefreshToken }: {
  token: string;
  onComplete: () => void;
  onError: (message: string) => void;
  onRefreshToken: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [sessionLink, setSessionLink] = useState(() => sessionStorage.getItem(BANK_SESSION_KEY));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let element: HTMLElement | undefined;
    setReady(false);
    void loadWidgets().then(() => {
      if (cancelled || !container.current) return;
      element = document.createElement(sessionLink ? 'ba-regprotect' : 'ba-bam-dashboard');
      if (sessionLink) {
        element.setAttribute('session-link', sessionLink);
        element.setAttribute('reentry-url', `${window.location.origin}/?bankingReentry=1#/bankabgleich`);
        element.setAttribute('hide-portal-button', 'true');
        element.addEventListener('subscribed', (event) => {
          sessionStorage.removeItem(BANK_SESSION_KEY);
          const callback = (event as CustomEvent<string>).detail;
          const reason = typeof callback === 'string' ? new URL(callback, window.location.origin).searchParams.get('baReentry') : null;
          setSessionLink(null);
          if (reason && /ERROR|INVALID|FAILED|ABORT|DENIED|NO_CALLBACK|CANCEL/.test(reason)) {
            onError(`Bankfreigabe wurde nicht abgeschlossen (${reason}). Bitte erneut versuchen.`);
          } else {
            history.replaceState(null, '', '/#/bankabgleich');
            onComplete();
          }
        });
      } else {
        element.setAttribute('token', token);
        element.setAttribute('hide-back-button', 'true');
        element.setAttribute('max-transactions', 'paymentAccounts');
        element.addEventListener('openRegprotect', (event) => {
          try {
            const url = new URL((event as CustomEvent<{ sessionLink: string }>).detail.sessionLink);
            if (url.protocol !== 'https:' || url.hostname !== 'banksapi.io') throw new Error('Ungültige REG/Protect-URL');
            url.searchParams.set('callbackUrl', `${window.location.origin}/?bankingCallback=1#/bankabgleich`);
            sessionStorage.setItem(BANK_SESSION_KEY, url.toString());
            setSessionLink(url.toString());
          } catch { onError('Die Bankfreigabe konnte nicht geöffnet werden.'); }
        });
        element.addEventListener('emitError', (event) => {
          const { status } = (event as CustomEvent<{ status: number }>).detail;
          if (status === 401) onRefreshToken();
          else onError(`Bankverbindungen konnten nicht geladen werden (HTTP ${status}). Bitte erneut versuchen.`);
        });
      }
      container.current.replaceChildren(element);
      setReady(true);
    }).catch((error: Error) => { if (!cancelled) onError(error.message); });
    return () => { cancelled = true; element?.remove(); };
  }, [sessionLink, token, onComplete, onError, onRefreshToken]);

  return <>
    {!ready && <p className="muted" role="status">Bankverbindungen werden geladen …</p>}
    <div className="bank-widget" ref={container} />
  </>;
}
