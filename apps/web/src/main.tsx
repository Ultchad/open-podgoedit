import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDesktopFiles, isDesktopShell } from './desktop';
import { runningOnAndroidShell } from './usb';
import './styles.css';

// The desktop shell cannot save a `blob:` link, so exports go through a native
// save dialog. This is a no-op in a browser and in the Android shell.
installDesktopFiles();

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the offline shell only in a production build: the dev server and
// the Playwright suite must never serve a stale cached page, and the native
// shells already ship the bundle inside their package.
if (
  import.meta.env.PROD &&
  !isDesktopShell() &&
  !runningOnAndroidShell() &&
  'serviceWorker' in navigator
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error) => {
        console.warn('[POD Go] service worker registration failed', error);
      });
  });
}
