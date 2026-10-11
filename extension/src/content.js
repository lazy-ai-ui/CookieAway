import AutoConsent from '@duckduckgo/autoconsent';
import { rememberConsentState, resetConsent } from './consent-reset.js';
import { showToast } from './toast/toast.js';

const isTop = window === window.top;

if (isTop) {
    rememberConsentState();
}

const consent = new AutoConsent((msg) => {
    if (msg.type === 'optOutResult' && msg.result) {
        keepHidden(consent.foundCmp?.prehideSelectors);
    }
    return browser.runtime.sendMessage(msg);
});

// autoconsent lifts its prehide right after clicking "reject", while many CMPs are still fading
// their banner out, so it blinks for a moment. Keep it hidden a little longer, then step aside
// so the site's "cookie settings" link still works.
function keepHidden(selectors, ms = 1500) {
    if (!selectors?.length) return;
    const style = document.createElement('style');
    style.textContent = `${selectors.join(',')} { opacity: 0 !important; pointer-events: none !important; }`;
    (document.head || document.documentElement).append(style);
    setTimeout(() => style.remove(), ms);
}

browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'cookieaway:toast') {
        if (isTop) {
            showToast({ mode: message.mode, kind: message.kind, onAction, afterAction: () => location.reload() });
        }
        return;
    }
    return Promise.resolve(consent.receiveMessageCallback(message));
});

async function onAction(action) {
    await browser.runtime.sendMessage({ type: `cookieaway:${action}` });
    if (action === 'skipOnce') {
        resetConsent();
    }
}
