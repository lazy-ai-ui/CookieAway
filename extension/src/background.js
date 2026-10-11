import { evalSnippets, filterCompactRules } from '@duckduckgo/autoconsent';
import compactRules from '@duckduckgo/autoconsent/rules/compact-rules.json';
import { parse } from 'tldts-experimental';

const config = {
    enabled: true,
    autoAction: 'optOut',
    enablePrehide: true,
    enableCosmeticRules: true,
    enableHeuristicDetection: true,
    // Only click explicit "reject" buttons; never "OK"/"accept"-style ones.
    heuristicMode: 'reject',
    enablePopupMutationObserver: true,
    // Some CMPs (e.g. OneTrust on puma.com) show up 3-5 s after load; with the default 2 s
    // the prehide is lifted before we click and the banner flashes.
    prehideTimeout: 6000,
    logs: {
        lifecycle: true,
        rulesteps: true,
        detectionsteps: false,
        evals: false,
        errors: true,
        messages: false,
        waits: false,
    },
};

// eTLD+1 of the page the user is on, e.g. "news.example.co.uk" -> "example.co.uk".
// Falls back to the hostname for IPs, localhost and the like.
function siteKey(url) {
    try {
        const { hostname } = new URL(url);
        return parse(hostname).domain || hostname;
    } catch {
        return null;
    }
}

// Serializes read-modify-write on storage so concurrent messages from several frames don't race.
let storageQueue = Promise.resolve();
function updateStorage(area, key, fallback, fn) {
    const run = storageQueue.then(async () => {
        const { [key]: current = fallback } = await browser.storage[area].get(key);
        const { value, result } = fn(current);
        await browser.storage[area].set({ [key]: value });
        return result;
    });
    storageQueue = run.catch(() => {});
    return run;
}

const getStored = async (area, key, fallback) => (await browser.storage[area].get(key))[key] ?? fallback;

// --- Per-tab state ---------------------------------------------------------------------------
// session.skip.once[tabId]   = { site, until }: user asked to see the site's banner. Every page load of
//                              that site in the tab until `until` is skipped — the reload may redirect
//                              (e.g. to a locale URL), so a single-use flag would be eaten by the first hop.
// session.skip.active[tabId] = site: autoconsent is off for every frame of the current page load.
// session.toastedSites      = sites that already got the full toast this browser session.
// pagesDone                 = tabs whose current page already reported success (one toast per page).
const pagesDone = new Set();
// The toast plays ~2.5 s of confirmation/exit before reloading; leave room for slow loads and redirects.
const SKIP_WINDOW_MS = 15000;

async function isEnabledForFrame(tabId, frameId, site) {
    const whitelist = await getStored('local', 'whitelist', []);
    if (whitelist.includes(site)) {
        return false;
    }
    if (frameId === 0) {
        // A top-frame init means a new page load in this tab.
        pagesDone.delete(tabId);
        return updateStorage('session', 'skip', {}, (skip) => {
            const once = { ...skip.once };
            const pending = once[tabId];
            const skipNow = pending?.site === site && Date.now() < pending.until;
            if (!skipNow) {
                delete once[tabId];
            }
            const active = { ...skip.active };
            if (skipNow) {
                active[tabId] = site;
            } else {
                delete active[tabId];
            }
            return { value: { once, active }, result: !skipNow };
        });
    }
    const skip = await getStored('session', 'skip', {});
    return skip.active?.[tabId] !== site;
}

async function onConsentDone(tabId, site, isCosmetic) {
    if (pagesDone.has(tabId)) {
        return null;
    }
    pagesDone.add(tabId);
    await updateStorage('local', 'rejectedCount', 0, (n) => ({ value: n + 1 }));
    const firstTime = await updateStorage('session', 'toastedSites', [], (sites) =>
        sites.includes(site) ? { value: sites, result: false } : { value: [...sites, site], result: true },
    );
    const toast = { type: 'cookieaway:toast', mode: firstTime ? 'full' : 'dot', kind: isCosmetic ? 'hidden' : 'rejected', site };
    await browser.tabs.sendMessage(tabId, toast, { frameId: 0 });
    return toast;
}

// Actions from the toast popover. Both are followed by a page reload in the content script.
const actions = {
    'cookieaway:skipOnce': (tabId, site) =>
        updateStorage('session', 'skip', {}, (skip) => ({
            value: { ...skip, once: { ...skip.once, [tabId]: { site, until: Date.now() + SKIP_WINDOW_MS } } },
        })),
    'cookieaway:whitelist': (tabId, site) =>
        updateStorage('local', 'whitelist', [], (list) => ({ value: list.includes(site) ? list : [...list, site] })),
};

browser.tabs.onRemoved.addListener((tabId) => {
    pagesDone.delete(tabId);
    updateStorage('session', 'skip', {}, (skip) => {
        const once = { ...skip.once };
        const active = { ...skip.active };
        delete once[tabId];
        delete active[tabId];
        return { value: { once, active } };
    });
});

// --- Messaging -------------------------------------------------------------------------------

function log(sender, ...args) {
    const host = sender.url ? new URL(sender.url).hostname : '?';
    console.log(`[CookieAway] ${host} (frame ${sender.frameId}):`, ...args);
}

async function evalInFrame(tabId, frameId, snippetId) {
    const func = evalSnippets[snippetId];
    if (!func) {
        throw new Error(`unknown eval snippet: ${snippetId}`);
    }
    const [injection] = await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        func,
    });
    return injection?.result;
}

browser.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId === undefined) {
        return;
    }
    // The site is always the page in the tab, even for messages from a CMP iframe.
    const site = siteKey(sender.tab.url ?? sender.url);
    const reply = (message) => browser.tabs.sendMessage(tabId, message, { frameId });

    if (actions[msg.type]) {
        log(sender, msg.type, site);
        return actions[msg.type](tabId, site).then(() => ({ ok: true }));
    }

    switch (msg.type) {
        case 'init':
            isEnabledForFrame(tabId, frameId, site).then((enabled) => {
                if (!enabled) {
                    log(sender, 'disabled for', site);
                }
                const rules = {
                    autoconsent: [],
                    compact: filterCompactRules(compactRules, { url: sender.url, mainFrame: frameId === 0 }),
                };
                reply({ type: 'initResp', rules, config: { ...config, enabled } });
            });
            break;
        case 'eval':
            evalInFrame(tabId, frameId, msg.snippetId)
                .catch((e) => {
                    log(sender, 'eval failed', msg.snippetId, e);
                    return false;
                })
                .then((result) => reply({ id: msg.id, type: 'evalResp', result }));
            break;
        case 'cmpDetected':
            log(sender, 'CMP detected:', msg.cmp);
            break;
        case 'popupFound':
            log(sender, 'popup found:', msg.cmp);
            break;
        case 'optOutResult':
            log(sender, 'opt-out result:', msg.cmp, msg.result);
            break;
        case 'autoconsentDone':
            log(sender, 'DONE:', msg.cmp, { cosmetic: msg.isCosmetic, clicks: msg.totalClicks, ms: msg.duration });
            onConsentDone(tabId, site, msg.isCosmetic).then(
                (toast) => toast && log(sender, 'toast:', toast.mode, toast.kind),
                (e) => log(sender, 'toast failed', e),
            );
            break;
        case 'autoconsentError':
            log(sender, 'error:', msg.details);
            break;
    }
});
