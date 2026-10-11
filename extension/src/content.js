import AutoConsent from '@duckduckgo/autoconsent';
import { rememberConsentState, resetConsent } from './consent-reset.js';
import { showToast } from './toast/toast.js';

// Temporary timing instrumentation for the banner flash investigation.
const DEBUG_TIMING = true;
const isTop = window === window.top;
const where = isTop ? 'top' : `frame ${location.hostname}`;
const t = () => `${Math.round(performance.now())}ms`;
const timing = (...args) => DEBUG_TIMING && console.log(`[CookieAway] ${t()} ${where}:`, ...args);

if (isTop) {
    console.log('[CookieAway] content script on', location.hostname);
    rememberConsentState();
}
timing('content script start, readyState =', document.readyState);

if (DEBUG_TIMING && isTop) {
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            console.log(`[CookieAway] ${Math.round(entry.startTime)}ms top: paint ${entry.name}`);
        }
    }).observe({ type: 'paint', buffered: true });
    document.addEventListener('DOMContentLoaded', () => timing('DOMContentLoaded'));
}

// Temporary: autoconsent's state as it changes, so a stuck site can be diagnosed from the console.
let lastState = '';
function logState(state) {
    const summary = JSON.stringify({
        lifecycle: state.lifecycle,
        attempts: state.findCmpAttempts,
        cmps: state.detectedCmps,
        popups: state.detectedPopups,
        heuristic: state.heuristicPatterns,
        clicks: state.clicks,
    });
    if (summary !== lastState) {
        lastState = summary;
        timing('state', summary);
    }
}

const consent = new AutoConsent((msg) => {
    if (['init', 'popupFound', 'optOutResult', 'autoconsentDone', 'autoconsentError'].includes(msg.type)) {
        timing('send', msg.type, msg.cmp ?? msg.details ?? '');
    }
    if (DEBUG_TIMING && isTop && msg.type === 'report') {
        logState(msg.state);
    }
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
        timing('toast', message.mode, message.kind, message.site);
        if (isTop) {
            showToast({ mode: message.mode, kind: message.kind, onAction, afterAction: () => location.reload() });
        }
        return;
    }
    if (message.type === 'initResp') {
        timing('initResp received');
    }
    return Promise.resolve(consent.receiveMessageCallback(message));
});

async function onAction(action) {
    await browser.runtime.sendMessage({ type: `cookieaway:${action}` });
    if (action === 'skipOnce') {
        timing('cleared consent keys', resetConsent());
    }
}
