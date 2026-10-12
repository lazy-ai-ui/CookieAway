import AutoConsent from '@duckduckgo/autoconsent';
import { rememberConsentState, resetConsent } from './consent-reset.js';
import { showToast } from './toast/toast.js';

const isTop = window === window.top;

// Same as the prehideTimeout in background.js: never keep a banner hidden longer than this.
const PREHIDE_TIMEOUT = 6000;
// After a successful opt-out many CMPs fade their banner out; keep it hidden through that.
const FADE_OUT_MS = 1500;
// Rules that come without prehide selectors, so their banner shows until the click lands.
const EXTRA_PREHIDE = ['#usercentrics-root', '#usercentrics-cmp-ui'];

if (isTop) {
    rememberConsentState();
}

const consent = new AutoConsent((msg) => {
    if (msg.type === 'report') {
        onLifecycle(msg.state.lifecycle);
    } else if (msg.type === 'optOutResult') {
        if (msg.result) {
            hide([...(consent.foundCmp?.prehideSelectors ?? []), ...EXTRA_PREHIDE], FADE_OUT_MS);
        }
        extraPrehide?.release();
    }
    return browser.runtime.sendMessage(msg);
});

// Hides elements with opacity (autoconsent's visibility checks ignore it) until released.
function hide(selectors, ms) {
    if (!selectors.length) return null;
    const style = document.createElement('style');
    style.textContent = `${selectors.join(',')} { opacity: 0 !important; pointer-events: none !important; }`;
    (document.head || document.documentElement).append(style);
    const release = () => style.remove();
    setTimeout(release, ms);
    return { release };
}

let extraPrehide = null;

// --- Late banners ----------------------------------------------------------------------------
// autoconsent gives up ~10 s after load. Some sites only show their banner once the user has
// dismissed something else (e.g. a language picker), so look again after the user interacts.
const RESCANS = 3;
const RECENT_INTERACTION_MS = 5000;
let rescansLeft = RESCANS;
let idle = false;
let lastInteraction = 0;
let rescanTimer = null;

function onLifecycle(lifecycle) {
    if (lifecycle === 'nothingDetected' || lifecycle === 'done') {
        extraPrehide?.release();
    }
    idle = lifecycle === 'nothingDetected';
    if (idle && Date.now() - lastInteraction < RECENT_INTERACTION_MS) {
        scheduleRescan();
    }
}

function scheduleRescan() {
    if (!idle || rescansLeft === 0) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
        if (!idle) return;
        idle = false;
        rescansLeft--;
        consent.start();
    }, 1000);
}

if (isTop) {
    const onInteraction = () => {
        lastInteraction = Date.now();
        scheduleRescan();
    };
    addEventListener('click', onInteraction, true);
    addEventListener('keydown', onInteraction, true);
}

browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'cookieaway:toast') {
        if (isTop) {
            showToast({ mode: message.mode, kind: message.kind, onAction, afterAction: () => location.reload() });
        }
        return;
    }
    if (message.type === 'initResp' && message.config?.enabled) {
        extraPrehide = hide(EXTRA_PREHIDE, PREHIDE_TIMEOUT);
    }
    return Promise.resolve(consent.receiveMessageCallback(message));
});

async function onAction(action) {
    await browser.runtime.sendMessage({ type: `cookieaway:${action}` });
    if (action === 'skipOnce') {
        resetConsent();
    }
}
