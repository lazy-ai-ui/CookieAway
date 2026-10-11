import { showToast } from '../src/toast/toast.js';

const $ = (sel) => document.querySelector(sel);
const log = (text) => {
    const line = document.createElement('div');
    line.textContent = `${(performance.now() / 1000).toFixed(2)}s  ${text}`;
    $('#log').prepend(line);
};

function show(mode, kind) {
    log(`show ${mode} / ${kind}`);
    showToast({
        mode,
        kind,
        reducedMotion: $('#reduced').checked || undefined,
        openShadow: true,
        onAction: async (action) => {
            log(`action: ${action}`);
            await new Promise((r) => setTimeout(r, 150));
        },
        afterAction: (action) => log(`after ${action}: page would reload now`),
    });
}

document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-mode]');
    if (button) {
        show(button.dataset.mode, button.dataset.kind);
    }
});
$('#dark').addEventListener('change', (e) => document.body.classList.toggle('dark', e.target.checked));
$('#aggressive').addEventListener('change', (e) => ($('#evil').media = e.target.checked ? 'all' : 'not all'));

// Samples pill geometry every frame: window.trace(ms) -> [{t, w, scale, opacity, text}]
window.trace = (ms = 5000) =>
    new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
            const root = document.querySelector('cookieaway-toast')?.shadowRoot;
            const pill = root?.querySelector('.pill');
            const t = Math.round(performance.now() - t0);
            if (pill) {
                const cs = getComputedStyle(pill);
                out.push({ t, w: Math.round(pill.getBoundingClientRect().width), tr: cs.transform, op: cs.opacity, text: getComputedStyle(root.querySelector('.text')).opacity });
            } else {
                out.push({ t, gone: true });
            }
            if (t < ms) requestAnimationFrame(tick);
            else resolve(out);
        };
        tick();
    });
