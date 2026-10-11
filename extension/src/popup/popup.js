import { siteKey } from '../site.js';

const $ = (id) => document.getElementById(id);
const toggle = $('enabled');

let tab = null;
let site = null;

async function init() {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    // No URL: a non-web page, or Safari hasn't been given access to this site.
    site = siteKey(tab?.url);
    $('host').textContent = site ?? 'Недоступно на этой странице';
    toggle.disabled = !site;

    toggle.addEventListener('change', () => setWhitelisted(site, !toggle.checked));
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') render();
    });
    await render();
}

async function render() {
    const { whitelist = [], rejectedCount = 0 } = await browser.storage.local.get(['whitelist', 'rejectedCount']);
    toggle.checked = !!site && !whitelist.includes(site);
    $('count').textContent = rejectedCount.toLocaleString('ru-RU');

    const items = [...whitelist].sort().map((entry) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = entry;
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.title = 'Убрать из исключений';
        remove.setAttribute('aria-label', `Убрать ${entry} из исключений`);
        remove.addEventListener('click', () => setWhitelisted(entry, false));
        li.append(name, remove);
        return li;
    });
    $('whitelist').replaceChildren(...items);
    $('empty').hidden = items.length > 0;
}

// The change applies to the open page right away: reload it if it's the affected site.
async function setWhitelisted(entry, whitelisted) {
    await browser.runtime.sendMessage({ type: 'cookieaway:setWhitelisted', site: entry, whitelisted });
    if (entry === site) {
        browser.tabs.reload(tab.id);
    }
}

init();
