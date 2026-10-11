import css from './toast.css';

const TEXT = {
    rejected: 'Куки отклонены',
    hidden: 'Куки-баннер скрыт',
};
const CONFIRM = {
    skipOnce: 'Покажем после перезагрузки',
    whitelist: 'Сайт в исключениях',
};

const HOLD_FULL = 3000;
const HOLD_DOT = 900;
const CONFIRM_MS = 2000;
const CIRCLE = 36;

const POP = 'cubic-bezier(0.34, 1.9, 0.64, 1)';
const POP_ICON = 'cubic-bezier(0.34, 2.2, 0.64, 1)';
const EXPAND = 'cubic-bezier(0.34, 1.6, 0.64, 1)';
const COLLAPSE = 'cubic-bezier(0.5, 0, 0.75, 0)';

const COOKIE_ICON = `
<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <mask id="bite"><rect width="16" height="16" fill="#fff"/><circle cx="14.2" cy="2.4" r="3.4" fill="#000"/></mask>
  <circle cx="8" cy="8.2" r="7" fill="#e0a55c" mask="url(#bite)"/>
  <circle cx="5.2" cy="6" r="1.15" fill="#6b3f1d"/>
  <circle cx="9.4" cy="9.6" r="1.15" fill="#6b3f1d"/>
  <circle cx="5.4" cy="11.2" r="0.95" fill="#6b3f1d"/>
  <circle cx="11.6" cy="6.3" r="0.8" fill="#6b3f1d"/>
</svg>`;

const EYE_ICON = `
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
  <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/>
  <circle cx="8" cy="8" r="2"/>
</svg>`;

const PAUSE_ICON = `
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
  <circle cx="8" cy="8" r="6.3"/>
  <path d="M3.6 3.6l8.8 8.8"/>
</svg>`;

const TEMPLATE = `
<div class="anchor">
  <div class="popover" role="menu" hidden>
    <button class="item" role="menuitem" data-action="skipOnce">${EYE_ICON}<span>Показать баннер сайта</span></button>
    <button class="item" role="menuitem" data-action="whitelist">${PAUSE_ICON}<span>Не трогать этот сайт</span></button>
  </div>
  <button class="pill" aria-haspopup="menu" aria-expanded="false">
    <span class="track">
      <span class="shadow"></span>
      <span class="cap"></span>
      <span class="mid"></span>
      <span class="cap cap-right"></span>
      <span class="clip">
        <span class="content">
          <span class="icon">${COOKIE_ICON}</span>
          <span class="text"><span class="label"></span><span class="sep">·</span><span class="edit">Изменить</span></span>
        </span>
      </span>
    </span>
  </button>
</div>`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Animates from -> to and leaves `to` applied inline afterwards (no lingering fill).
function run(el, from, to, options) {
    Object.assign(el.style, to);
    return el.animate([from, to], { fill: 'backwards', ...options }).finished.catch(() => {});
}

let current = null;

/**
 * Shows the toast at the bottom of the page.
 * @param {object} opts
 * @param {'full'|'dot'} opts.mode       full toast or just the circle (repeat on the same site)
 * @param {'rejected'|'hidden'} opts.kind  real opt-out or cosmetic hiding
 * @param {(action: 'skipOnce'|'whitelist') => Promise<void>} [opts.onAction]  called when the user picks an action
 * @param {(action) => void} [opts.afterAction]  called once the toast is gone after an action (e.g. reload)
 * @param {boolean} [opts.reducedMotion]  overrides prefers-reduced-motion (for the dev harness)
 * @param {boolean} [opts.openShadow]  open shadow root so the dev harness can inspect it
 */
export function showToast(opts) {
    current?.destroy();
    current = new Toast(opts);
    return current;
}

class Toast {
    constructor({ mode = 'full', kind = 'rejected', onAction, afterAction, reducedMotion, openShadow }) {
        this.openShadow = openShadow;
        this.mode = mode;
        this.kind = kind;
        this.onAction = onAction;
        this.afterAction = afterAction;
        this.reduced = reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.alive = true;
        this.hovered = false;
        this.popoverOpen = false;
        this.action = null;

        this.mount();
        this.play();
    }

    mount() {
        const host = document.createElement('cookieaway-toast');
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        const root = host.attachShadow({ mode: this.openShadow ? 'open' : 'closed' });
        root.innerHTML = `<style>${css}</style>${TEMPLATE}`;

        this.host = host;
        this.root = root;
        this.anchor = root.querySelector('.anchor');
        this.pill = root.querySelector('.pill');
        this.parts = {
            track: root.querySelector('.track'),
            shadow: root.querySelector('.shadow'),
            mid: root.querySelector('.mid'),
            capRight: root.querySelector('.cap-right'),
            clip: root.querySelector('.clip'),
            content: root.querySelector('.content'),
        };
        this.width = CIRCLE;
        this.content = root.querySelector('.content');
        this.icon = root.querySelector('.icon');
        this.text = root.querySelector('.text');
        this.label = root.querySelector('.label');
        this.popover = root.querySelector('.popover');

        if (this.mode === 'dot') {
            this.anchor.classList.add('dot');
            this.pill.tabIndex = -1;
            this.pill.setAttribute('aria-hidden', 'true');
        }

        this.pill.addEventListener('pointerenter', () => this.setHovered(true));
        this.pill.addEventListener('pointerleave', () => this.setHovered(false));
        this.pill.addEventListener('click', () => (this.popoverOpen ? this.closePopover() : this.openPopover()));
        this.popover.addEventListener('click', (e) => {
            const item = e.target.closest('[data-action]');
            if (item) {
                this.choose(item.dataset.action);
            }
        });
        this.onOutsidePointer = (e) => {
            if (!e.composedPath().includes(host)) {
                this.closePopover();
            }
        };
        this.onKey = (e) => this.handleKey(e);

        document.documentElement.append(host);
        // Top layer keeps us above page stacking contexts, transforms and z-index wars.
        if (typeof host.showPopover === 'function') {
            host.popover = 'manual';
            try {
                host.showPopover();
            } catch {
                // Fall back to the plain fixed + z-index host.
            }
        }
    }

    destroy() {
        this.alive = false;
        this.closePopover();
        clearTimeout(this.holdTimer);
        this.host.remove();
        if (current === this) {
            current = null;
        }
    }

    async play() {
        // Filled after mount so the live region announces the text.
        this.label.textContent = TEXT[this.kind] ?? TEXT.rejected;

        if (this.reduced) {
            await this.appearReduced();
        } else if (this.mode === 'dot') {
            await this.appearCircle();
        } else {
            await this.appearFull();
        }
        if (!this.alive) return;

        await this.hold(this.mode === 'dot' ? HOLD_DOT : HOLD_FULL);
        if (!this.alive) return;

        if (this.action) {
            await this.confirmAction();
            if (!this.alive) return;
        }

        if (this.reduced) {
            await run(this.anchor, { opacity: 1 }, { opacity: 0 }, { duration: 300, easing: 'ease-in' });
        } else if (this.mode === 'dot') {
            await this.vanishCircle();
        } else {
            await this.disappearFull();
        }

        const action = this.action?.name;
        this.destroy();
        if (action) {
            this.afterAction?.(action);
        }
    }

    // --- Appear / disappear ----------------------------------------------------------------

    appearCircle() {
        this.icon.style.opacity = '0';
        return Promise.all([
            run(this.pill, { transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }, { duration: 320, easing: POP }),
            run(
                this.icon,
                { transform: 'scale(.4) rotate(-40deg)', opacity: 0 },
                { transform: 'scale(1) rotate(0deg)', opacity: 1 },
                { duration: 384, delay: 80, easing: POP_ICON },
            ),
        ]);
    }

    async appearFull() {
        this.text.style.opacity = '0';
        const circle = this.appearCircle();
        await wait(320 + 250);
        if (!this.alive) return;

        await Promise.all([
            circle,
            this.resize(this.content.offsetWidth, { duration: 450, easing: EXPAND }),
            run(this.text, { opacity: 0 }, { opacity: 1 }, { duration: 220, delay: 140, easing: 'ease-out' }),
            run(this.text, { translate: '-6px 0' }, { translate: '0 0' }, { duration: 280, delay: 140, easing: 'ease-out' }),
        ]);
    }

    async appearReduced() {
        if (this.mode === 'full') {
            this.setWidth(this.content.offsetWidth);
        }
        await run(this.anchor, { opacity: 0 }, { opacity: 1 }, { duration: 250, easing: 'ease-out' });
    }

    vanishCircle(delay = 0) {
        return Promise.all([
            run(this.pill, { transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.6)', opacity: 0 }, { duration: 180, delay, easing: 'ease-in' }),
            run(this.icon, { transform: 'rotate(0deg) scale(1)' }, { transform: 'rotate(20deg) scale(.6)' }, { duration: 180, delay, easing: 'ease-in' }),
        ]);
    }

    // All exit steps are scheduled up front on one timeline: chaining them through promises leaves
    // a gap of a few frames between collapse and vanish on busy pages, which reads as a stutter.
    // This only works because every step is compositor-driven (see resize).
    async disappearFull() {
        await Promise.all([
            run(this.text, { opacity: 1, translate: '0 0' }, { opacity: 0, translate: '-6px 0' }, { duration: 150, easing: 'ease-in' }),
            this.resize(CIRCLE, { duration: 300, delay: 60, easing: COLLAPSE }),
            this.vanishCircle(60 + 300),
        ]);
    }

    // --- Width ---------------------------------------------------------------------------------
    // The button is laid out at `box` (the widest width of the animation) and every part is placed
    // for the visible width `w` with transforms only, each linear in `w`. All parts share timing
    // and easing, so they stay in lockstep on the compositor, overshoot included.

    partStyles(box, w) {
        return {
            track: { translate: `${(box - w) / 2}px 0` },
            shadow: { transform: `scaleX(${w / box})` },
            mid: { transform: `scaleX(${box > CIRCLE ? (w - CIRCLE) / (box - CIRCLE) : 0})` },
            capRight: { translate: `${w - CIRCLE}px 0` },
            clip: { translate: `${w - box}px 0` },
            content: { translate: `${box - w}px 0` },
        };
    }

    setWidth(w) {
        this.width = w;
        this.pill.style.width = `${w}px`;
        const styles = this.partStyles(w, w);
        for (const [name, style] of Object.entries(styles)) {
            Object.assign(this.parts[name].style, style);
        }
    }

    async resize(to, options) {
        const from = this.width;
        const box = Math.max(from, to);
        this.width = to;
        this.pill.style.width = `${box}px`;
        const start = this.partStyles(box, from);
        const end = this.partStyles(box, to);
        await Promise.all(Object.keys(start).map((name) => run(this.parts[name], start[name], end[name], options)));
        // Same picture, tighter box: keeps the focus ring and hit area on the visible pill.
        if (this.alive && this.width === to) {
            this.setWidth(to);
        }
    }

    // --- Hold timer (paused on hover, while the popover is open, while an action runs) -----

    hold(ms) {
        if (this.action) return Promise.resolve();
        return new Promise((resolve) => {
            this.holdLeft = ms;
            this.holdDone = resolve;
            this.updateHold();
        });
    }

    endHold() {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
        const done = this.holdDone;
        this.holdDone = null;
        done?.();
    }

    updateHold() {
        if (!this.holdDone) return;
        const paused = this.hovered || this.popoverOpen;
        if (paused && this.holdTimer) {
            clearTimeout(this.holdTimer);
            this.holdTimer = null;
            this.holdLeft -= performance.now() - this.holdStart;
        } else if (!paused && !this.holdTimer) {
            this.holdStart = performance.now();
            this.holdTimer = setTimeout(() => this.endHold(), Math.max(0, this.holdLeft));
        }
    }

    setHovered(hovered) {
        this.hovered = hovered;
        this.updateHold();
    }

    // --- Popover ---------------------------------------------------------------------------

    openPopover() {
        if (this.popoverOpen || this.action || this.mode === 'dot') return;
        this.popoverOpen = true;
        this.updateHold();
        this.popover.hidden = false;
        this.pill.setAttribute('aria-expanded', 'true');
        run(this.popover, { opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }, { duration: 180, easing: 'ease-out' });
        this.popover.querySelector('.item').focus();
        addEventListener('pointerdown', this.onOutsidePointer, true);
        addEventListener('keydown', this.onKey, true);
    }

    closePopover({ focusPill = false } = {}) {
        if (!this.popoverOpen) return;
        this.popoverOpen = false;
        this.popover.hidden = true;
        this.pill.setAttribute('aria-expanded', 'false');
        removeEventListener('pointerdown', this.onOutsidePointer, true);
        removeEventListener('keydown', this.onKey, true);
        if (focusPill) {
            this.pill.focus();
        }
        this.updateHold();
    }

    handleKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.closePopover({ focusPill: true });
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            const items = [...this.popover.querySelectorAll('.item')];
            const index = items.indexOf(this.root.activeElement);
            const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next].focus();
        }
    }

    // --- Actions ---------------------------------------------------------------------------

    choose(name) {
        if (this.action) return;
        this.action = { name, done: Promise.resolve(this.onAction?.(name)) };
        this.closePopover();
        this.pill.blur();
        this.endHold();
    }

    async confirmAction() {
        try {
            await this.action.done;
        } catch (e) {
            console.error('[CookieAway] action failed', e);
            this.action = null;
            return;
        }
        if (!this.alive) return;

        if (this.reduced) {
            this.anchor.classList.add('confirm');
            this.label.textContent = CONFIRM[this.action.name];
            this.setWidth(this.content.offsetWidth);
        } else {
            await run(this.text, { opacity: 1 }, { opacity: 0 }, { duration: 120, easing: 'ease-in' });
            if (!this.alive) return;
            this.anchor.classList.add('confirm');
            this.label.textContent = CONFIRM[this.action.name];
            await Promise.all([
                this.resize(this.content.offsetWidth, { duration: 300, easing: EXPAND }),
                run(this.text, { opacity: 0 }, { opacity: 1 }, { duration: 200, delay: 60, easing: 'ease-out' }),
            ]);
        }
        await wait(CONFIRM_MS);
    }
}
