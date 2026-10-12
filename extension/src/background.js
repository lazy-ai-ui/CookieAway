import { evalSnippets, filterCompactRules } from '@duckduckgo/autoconsent';
import compactRules from '@duckduckgo/autoconsent/rules/compact-rules.json';
import { siteKey } from './site.js';

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
        lifecycle: false,
        rulesteps: false,
        detectionsteps: false,
        evals: false,
        errors: true,
        messages: false,
        waits: false,
    },
};

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

// --- Pause ---------------------------------------------------------------------------------------
// local.pausedUntil  = timestamp: paused everywhere for a while (survives a Safari restart).
// session.paused     = true: paused until Safari quits.
const PAUSE_HOUR_MS = 60 * 60 * 1000;

async function isPaused() {
    const [until, session] = await Promise.all([getStored('local', 'pausedUntil', 0), getStored('session', 'paused', false)]);
    return session || Date.now() < until;
}

function setPause(mode) {
    return Promise.all([
        browser.storage.local.set({ pausedUntil: mode === 'hour' ? Date.now() + PAUSE_HOUR_MS : 0 }),
        browser.storage.session.set({ paused: mode === 'session' }),
    ]);
}

// Not touched on this page: paused, or the site is in the exceptions list.
async function isOff(site) {
    const whitelist = await getStored('local', 'whitelist', []);
    return (await isPaused()) || whitelist.includes(site);
}

async function isEnabledForFrame(tabId, frameId, site) {
    if (await isOff(site)) {
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
        return;
    }
    pagesDone.add(tabId);
    await updateStorage('local', 'rejectedCount', 0, (n) => ({ value: n + 1 }));
    const firstTime = await updateStorage('session', 'toastedSites', [], (sites) =>
        sites.includes(site) ? { value: sites, result: false } : { value: [...sites, site], result: true },
    );
    const toast = { type: 'cookieaway:toast', mode: firstTime ? 'full' : 'dot', kind: isCosmetic ? 'hidden' : 'rejected', site };
    markDone(tabId);
    await browser.tabs.sendMessage(tabId, toast, { frameId: 0 });
}

// Actions from the toast popover. Both are followed by a page reload in the content script.
const actions = {
    'cookieaway:skipOnce': (tabId, site) =>
        updateStorage('session', 'skip', {}, (skip) => ({
            value: { ...skip, once: { ...skip.once, [tabId]: { site, until: Date.now() + SKIP_WINDOW_MS } } },
        })),
    'cookieaway:whitelist': (tabId, site) => setWhitelisted(site, true),
};

function setWhitelisted(site, whitelisted) {
    return updateStorage('local', 'whitelist', [], (list) => {
        const rest = list.filter((s) => s !== site);
        return { value: whitelisted ? [...rest, site] : rest };
    });
}

// --- Toolbar icon ------------------------------------------------------------------------------
// Crossed out where we don't touch the page; a check mark once this page's banner was handled.
const ICON = 'images/toolbar-icon.svg';
const ICON_OFF = 'images/toolbar-icon-off.svg';

async function updateIcon(tabId, url) {
    const off = await isOff(siteKey(url));
    await browser.action.setIcon({ tabId, path: off ? ICON_OFF : ICON });
}

function markDone(tabId) {
    Promise.all([
        browser.action.setBadgeBackgroundColor?.({ tabId, color: '#34c759' }),
        browser.action.setBadgeText({ tabId, text: '✓' }),
    ]).catch(() => {});
}

// Every navigation, web page or not, so a previous page's state never lingers. Safari resets
// a tab's icon once the new page commits, so it is set again on init and when loading completes.
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'loading') {
        browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    }
    if (change.status === 'loading' || change.status === 'complete') {
        updateIcon(tabId, tab.url).catch(() => {});
    }
});

// --- Diagnostics -------------------------------------------------------------------------------
// session.frames[tabId][frameId] = what autoconsent did in that frame on the current page load.
// Written only when a frame's lifecycle changes, so a page costs a handful of writes. The popup's
// "banner didn't close" button copies it into local.problems for later debugging.
const MAX_PROBLEMS = 50;
const lastLifecycle = new Map(); // `${tabId}:${frameId}` -> lifecycle

function pageUrl(url) {
    try {
        const { origin, pathname } = new URL(url);
        return origin + pathname; // no query or hash: they can carry personal data
    } catch {
        return null;
    }
}

function recordFrame(tabId, frameId, url, summary) {
    return updateStorage('session', 'frames', {}, (frames) => ({
        value: { ...frames, [tabId]: { ...frames[tabId], [frameId]: { url: pageUrl(url), ...summary } } },
    }));
}

function onReport(tabId, frameId, url, state) {
    const key = `${tabId}:${frameId}`;
    if (lastLifecycle.get(key) === state.lifecycle) return;
    lastLifecycle.set(key, state.lifecycle);
    recordFrame(tabId, frameId, url, {
        lifecycle: state.lifecycle,
        cmps: state.detectedCmps,
        popups: state.detectedPopups,
        attempts: state.findCmpAttempts,
        heuristic: state.heuristicPatterns?.length ?? 0,
        snippets: state.heuristicSnippets?.slice(0, 2).map((s) => s.slice(0, 100)),
        clicks: state.clicks,
    });
}

function forgetTab(tabId) {
    for (const key of lastLifecycle.keys()) {
        if (key.startsWith(`${tabId}:`)) lastLifecycle.delete(key);
    }
    return updateStorage('session', 'frames', {}, (frames) => {
        const { [tabId]: _, ...rest } = frames;
        return { value: rest };
    });
}

async function reportProblem(tabId, url) {
    const frames = (await getStored('session', 'frames', {}))[tabId] ?? {};
    const entry = {
        time: new Date().toISOString(),
        site: siteKey(url),
        url: pageUrl(url),
        version: browser.runtime.getManifest().version,
        frames: Object.entries(frames).map(([frameId, frame]) => ({ frameId: Number(frameId), ...frame })),
    };
    await updateStorage('local', 'problems', [], (list) => ({ value: [...list, entry].slice(-MAX_PROBLEMS) }));
    return entry;
}

browser.tabs.onRemoved.addListener((tabId) => {
    pagesDone.delete(tabId);
    forgetTab(tabId);
    updateStorage('session', 'skip', {}, (skip) => {
        const once = { ...skip.once };
        const active = { ...skip.active };
        delete once[tabId];
        delete active[tabId];
        return { value: { once, active } };
    });
});

// --- Messaging -------------------------------------------------------------------------------

function warn(sender, ...args) {
    const host = sender.url ? new URL(sender.url).hostname : '?';
    console.warn(`[CookieAway] ${host} (frame ${sender.frameId}):`, ...args);
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
    // From the toolbar popup: it has no tab of its own and names the site explicitly.
    if (msg.type === 'cookieaway:setWhitelisted') {
        return setWhitelisted(msg.site, msg.whitelisted).then(() => ({ ok: true }));
    }
    if (msg.type === 'cookieaway:setPause') {
        return setPause(msg.mode).then(() => ({ ok: true }));
    }
    if (msg.type === 'cookieaway:reportProblem') {
        return reportProblem(msg.tabId, msg.url);
    }

    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId === undefined) {
        return;
    }
    // The site is always the page in the tab, even for messages from a CMP iframe.
    const site = siteKey(sender.tab.url ?? sender.url);
    const reply = (message) => browser.tabs.sendMessage(tabId, message, { frameId });

    if (actions[msg.type]) {
        return actions[msg.type](tabId, site).then(() => ({ ok: true }));
    }

    switch (msg.type) {
        case 'init':
            if (frameId === 0) {
                // A new page load in this tab; storage writes are queued, so this lands first.
                forgetTab(tabId);
                updateIcon(tabId, sender.tab.url ?? sender.url).catch(() => {});
            }
            isEnabledForFrame(tabId, frameId, site).then((enabled) => {
                if (!enabled) {
                    recordFrame(tabId, frameId, sender.url, { lifecycle: 'disabled' });
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
                    warn(sender, 'eval failed', msg.snippetId, e);
                    return false;
                })
                .then((result) => reply({ id: msg.id, type: 'evalResp', result }));
            break;
        case 'report':
            onReport(tabId, frameId, sender.url, msg.state);
            break;
        case 'autoconsentDone':
            onConsentDone(tabId, site, msg.isCosmetic).catch((e) => warn(sender, 'toast failed', e));
            break;
        case 'cookieaway:noticeHidden':
            // Hidden without clicking (see content.js): reported like a cosmetic opt-out.
            onConsentDone(tabId, site, true).catch((e) => warn(sender, 'toast failed', e));
            break;
        case 'autoconsentError':
            warn(sender, 'error:', msg.details);
            break;
    }
});
