import { evalSnippets, filterCompactRules } from '@duckduckgo/autoconsent';
import compactRules from '@duckduckgo/autoconsent/rules/compact-rules.json';

const config = {
    enabled: true,
    autoAction: 'optOut',
    enablePrehide: true,
    enableCosmeticRules: true,
    enableHeuristicDetection: true,
    // Only click explicit "reject" buttons; never "OK"/"accept"-style ones.
    heuristicMode: 'reject',
    enablePopupMutationObserver: true,
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

// Phase 3: whitelist lookup (eTLD+1) goes here.
async function isEnabledForUrl(url) {
    return true;
}

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
    const reply = (message) => browser.tabs.sendMessage(tabId, message, { frameId });

    switch (msg.type) {
        case 'init':
            isEnabledForUrl(sender.url).then((enabled) => {
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
            // Phase 3: trigger toast from here.
            log(sender, 'DONE:', msg.cmp, { cosmetic: msg.isCosmetic, clicks: msg.totalClicks, ms: msg.duration });
            break;
        case 'autoconsentError':
            log(sender, 'error:', msg.details);
            break;
    }
});
