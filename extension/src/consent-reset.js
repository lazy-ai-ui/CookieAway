// Forgets the choice the site stored after our opt-out, so its banner shows again after a reload.
// Only consent keys are touched — never the whole site storage (that would log the user out).

// Keys of popular CMPs, cleared whenever they exist.
const NAME_PREFIXES = [
    // OneTrust
    'OptanonConsent',
    'OptanonAlertBoxClosed',
    'OTAdditionalConsentString',
    'eupubconsent',
    // Cookiebot
    'CookieConsent',
    // Didomi
    'didomi_',
    // Usercentrics
    'uc_',
    'ucData',
    'ucString',
    // Sourcepoint
    '_sp_',
    'consentUUID',
    'consentDate',
    // Quantcast / InMobi
    '_cmpRepromptHash',
    'addtl_consent',
    // TrustArc
    'notice_',
    'cmapi_',
    // IAB TCF / US privacy, shared by many CMPs
    'euconsent',
    'usprivacy',
];

// Custom banners (e.g. adidas' "notice_preferences") use their own names. A key that appeared or
// changed after page load and is named like a consent key is most likely what our click stored.
const CONSENT_HINT = /consent|gdpr|notice|privacy|cookie|cmp|tcf/i;

const isKnownKey = (name) => NAME_PREFIXES.some((prefix) => name.startsWith(prefix));

function readCookies() {
    const cookies = {};
    for (const part of document.cookie.split(';')) {
        const i = part.indexOf('=');
        const name = (i < 0 ? part : part.slice(0, i)).trim();
        if (name) {
            cookies[name] = i < 0 ? '' : part.slice(i + 1);
        }
    }
    return cookies;
}

function readStorage(name) {
    try {
        return { ...window[name] };
    } catch {
        // Storage can be disabled on some pages.
        return {};
    }
}

const snapshot = () => ({ cookies: readCookies(), localStorage: readStorage('localStorage'), sessionStorage: readStorage('sessionStorage') });

let baseline = null;

// Call at document_start, before the page had a chance to store anything this load.
export function rememberConsentState() {
    baseline = snapshot();
}

function keysToClear(current, before) {
    return Object.keys(current).filter(
        (name) => isKnownKey(name) || (before && before[name] !== current[name] && CONSENT_HINT.test(name)),
    );
}

function deleteCookie(name) {
    // A cookie may be set on the host or on any parent domain; try them all on path "/".
    const parts = location.hostname.split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i++) {
        domains.push(`; domain=.${parts.slice(i).join('.')}`);
    }
    for (const domain of domains) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
}

export function resetConsent() {
    const now = snapshot();
    const cleared = keysToClear(now.cookies, baseline?.cookies);
    cleared.forEach(deleteCookie);
    for (const area of ['localStorage', 'sessionStorage']) {
        for (const key of keysToClear(now[area], baseline?.[area])) {
            try {
                window[area].removeItem(key);
                cleared.push(key);
            } catch {
                // Storage can be disabled on some pages.
            }
        }
    }
    return cleared;
}
