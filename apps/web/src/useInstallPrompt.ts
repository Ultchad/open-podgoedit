// Install prompt for the offline PWA.
//
// Chromium fires `beforeinstallprompt` when the page satisfies the install
// criteria. Deferring the event lets the header offer an explicit **Install**
// button instead of relying on the browser's own menu. Safari and Firefox do
// not fire it; there the button stays hidden and the browser's Share/Install
// command is still available.
import { useCallback, useEffect, useState } from 'react';

/** The non-standard event Chromium fires for an installable page. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export interface InstallPrompt {
  /** True when the browser offered a prompt and the app is not installed. */
  canInstall: boolean;
  /** True when the page is already running as an installed app. */
  installed: boolean;
  /** Show the browser's install prompt. */
  install(): Promise<void>;
}

export function useInstallPrompt(): InstallPrompt {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    function onBeforeInstall(event: Event) {
      // Keep the event so the header can replay it from a click.
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setPrompt(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) {
      return;
    }
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === 'accepted') {
      setInstalled(true);
    }
    // A dismissed prompt cannot be replayed; wait for the next event.
    setPrompt(null);
  }, [prompt]);

  return { canInstall: prompt !== null && !installed, installed, install };
}
