import AutoConsent from '@duckduckgo/autoconsent';

// Temporary timing instrumentation for the banner flash investigation.
const DEBUG_TIMING = true;
const isTop = window === window.top;
const where = isTop ? 'top' : `frame ${location.hostname}`;
const t = () => `${Math.round(performance.now())}ms`;
const timing = (...args) => DEBUG_TIMING && console.log(`[CookieAway] ${t()} ${where}:`, ...args);

if (isTop) {
    console.log('[CookieAway] content script on', location.hostname);
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

const consent = new AutoConsent((msg) => {
    if (['init', 'popupFound', 'optOutResult', 'autoconsentDone'].includes(msg.type)) {
        timing('send', msg.type, msg.cmp ?? '');
    }
    return browser.runtime.sendMessage(msg);
});

browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'initResp') {
        timing('initResp received');
    }
    return Promise.resolve(consent.receiveMessageCallback(message));
});
