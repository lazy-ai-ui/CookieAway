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
    $('report').disabled = !site;

    toggle.addEventListener('change', () => setWhitelisted(site, !toggle.checked));
    $('report').addEventListener('click', reportProblem);
    $('copy').addEventListener('click', copyProblems);
    $('clear').addEventListener('click', () => browser.storage.local.set({ problems: [] }));
    for (const button of document.querySelectorAll('[data-pause]')) {
        button.addEventListener('click', () => setPause(button.dataset.pause));
    }
    $('resume').addEventListener('click', () => setPause(null));
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' || area === 'session') render();
    });
    await render();
}

async function render() {
    const [{ whitelist = [], rejectedCount = 0, problems = [], pausedUntil = 0 }, { paused = false }] = await Promise.all([
        browser.storage.local.get(['whitelist', 'rejectedCount', 'problems', 'pausedUntil']),
        browser.storage.session.get(['paused']),
    ]);
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

    renderPause(pausedUntil, paused);

    $('problems').hidden = problems.length === 0;
    $('problem-count').textContent = problems.length;
}

function renderPause(pausedUntil, paused) {
    const timed = Date.now() < pausedUntil;
    const on = paused || timed;
    $('pause').classList.toggle('paused', on);
    $('pause-actions').hidden = on;
    $('resume').hidden = !on;
    if (!on) {
        $('pause-state').textContent = 'Пауза везде:';
    } else if (paused) {
        $('pause-state').textContent = 'На паузе до перезапуска Safari';
    } else {
        const time = new Date(pausedUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        $('pause-state').textContent = `На паузе до ${time}`;
    }
}

// Applies to the open page right away, like the site switch.
async function setPause(mode) {
    await browser.runtime.sendMessage({ type: 'cookieaway:setPause', mode });
    if (site) {
        browser.tabs.reload(tab.id);
    }
}

// Saves what autoconsent did on this page, so a stubborn site can be debugged later.
async function reportProblem() {
    const button = $('report');
    button.disabled = true;
    await browser.runtime.sendMessage({ type: 'cookieaway:reportProblem', tabId: tab.id, url: tab.url });
    button.textContent = 'Сохранено';
}

async function copyProblems() {
    const { problems = [] } = await browser.storage.local.get(['problems']);
    await navigator.clipboard.writeText(JSON.stringify(problems, null, 2));
    flash($('copy'), 'Скопировано');
}

function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = original), 1500);
}

// The change applies to the open page right away: reload it if it's the affected site.
async function setWhitelisted(entry, whitelisted) {
    await browser.runtime.sendMessage({ type: 'cookieaway:setWhitelisted', site: entry, whitelisted });
    if (entry === site) {
        browser.tabs.reload(tab.id);
    }
}

init();
