/**
 * break-state.js — the single source of truth for the audience-facing
 * break screen (break.html) and its operator editor (break-control.html).
 *
 * Both surfaces are pure views over this state. The server owns the clock
 * (not the browser) so a page refresh or a reconnect never loses time, and
 * a multi-device setup sees identical numbers.
 *
 * State is persisted to break-state.json so a mid-match server restart
 * doesn't wipe the score / clock. (This is also the start of fixing the
 * in-memory-only profile problem flagged in the code review — same pattern
 * can back the audio profiles later.)
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'break-state.json');
const DEFAULT_HALFTIME_SEC = 900;   // 15 minutes

const DEFAULTS = Object.freeze({
    title: 'HALBZEIT',
    message: '',
    home: { name: '', score: 0 },
    away: { name: '', score: 0 },
    // The match time frozen at the whistle — a free-text snapshot the
    // operator types ("45:00", "HT", "2nd half 67:20"). Not a live clock.
    matchClock: { label: 'HT', display: '' },
    // The break countdown. Server-driven: while running we store the
    // absolute end time, so remaining = endsAt - now is always exact
    // regardless of how often clients ask.
    timer: {
        durationSec: DEFAULT_HALFTIME_SEC,
        running: false,
        endsAt: null,           // epoch ms; null when paused/reset
        remainingSec: DEFAULT_HALFTIME_SEC,
    },
    // Slide rotation. The break screen cycles through active slides;
    // `pinned` locks one (null = free rotation). `current` is the
    // index into the active list — but the client owns the tick, so
    // the server only persists the *config*, not the live pointer.
    rotation: {
        slides: ['clock', 'radial', 'score', 'message', 'ad', 'brand'],
        active: { clock: true, radial: true, score: true, message: true, ad: true, brand: true },
        dwellMs: 12000,
        pinned: null,
    },
    // Single sponsor ad. logoFile is a filename served from
    // /break-ads/ (uploaded via POST /api/break-ad). Empty = no logo,
    // the slide shows org name + tagline + QR only.
    ad: { orgName: '', tagline: '', url: '', logoFile: '' },
});

let state = load();
const subscribers = new Set();

// ── persistence ───────────────────────────────────────────────────

function load() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return merge(structuredClone(DEFAULTS), parsed);
    } catch (_) {
        return structuredClone(DEFAULTS);
    }
}

function persist() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) { /* best-effort — the show must go on */ }
}

// Deep-merge known sub-objects so a partial on-disk file (missing new
// keys added in a later version) still hydrates cleanly from defaults.
function merge(base, extra) {
    for (const k of Object.keys(extra || {})) {
        if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) &&
            extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k])) {
            base[k] = merge(base[k], extra[k]);
        } else {
            base[k] = extra[k];
        }
    }
    return base;
}

// ── reads ─────────────────────────────────────────────────────────

/**
 * Current state, with the timer's remainingSec computed live if running.
 * Callers get an immutable snapshot; mutate via the update functions.
 */
function get() {
    if (state.timer.running && state.timer.endsAt) {
        const rem = Math.max(0, Math.round((state.timer.endsAt - Date.now()) / 1000));
        return { ...state, timer: { ...state.timer, remainingSec: rem } };
    }
    // Snapshot so callers can't mutate our internal object
    return structuredClone(state);
}

// ── writes ────────────────────────────────────────────────────────

function commit() {
    persist();
    emit();
}

function emit() {
    const snapshot = get();
    for (const fn of subscribers) {
        try { fn(snapshot); } catch (_) { /* one bad subscriber can't kill the tick */ }
    }
}

/**
 * Apply a partial update from the operator UI.
 * Only known top-level / nested keys are honoured; unknown junk is ignored.
 */
function update(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (typeof partial.title === 'string')   state.title = partial.title.slice(0, 40);
    if (typeof partial.message === 'string') state.message = partial.message.slice(0, 120);
    if (partial.home) patchTeam(state.home, partial.home);
    if (partial.away) patchTeam(state.away, partial.away);
    if (partial.matchClock) {
        if (typeof partial.matchClock.label === 'string')   state.matchClock.label = partial.matchClock.label.slice(0, 8);
        if (typeof partial.matchClock.display === 'string') state.matchClock.display = partial.matchClock.display.slice(0, 12);
    }
    commit();
}

function patchTeam(team, patch) {
    if (typeof patch.name === 'string')  team.name = patch.name.slice(0, 24);
    if (Number.isFinite(patch.score))    team.score = Math.max(0, Math.min(99, Math.trunc(patch.score)));
}

function setScore(side, delta) {
    if (side !== 'home' && side !== 'away') return;
    state[side].score = Math.max(0, Math.min(99, state[side].score + (delta > 0 ? 1 : -1)));
    commit();
}

// ── timer controls ────────────────────────────────────────────────

function startTimer() {
    // Resume from remaining; if already at 0, reset to duration first
    if (state.timer.remainingSec <= 0) state.timer.remainingSec = state.timer.durationSec;
    state.timer.running = true;
    state.timer.endsAt = Date.now() + state.timer.remainingSec * 1000;
    commit();
}

function pauseTimer() {
    if (!state.timer.running) return;
    state.timer.remainingSec = get().timer.remainingSec;   // freeze exact remaining
    state.timer.running = false;
    state.timer.endsAt = null;
    commit();
}

function resetTimer(sec) {
    state.timer.running = false;
    state.timer.endsAt = null;
    const d = Number.isFinite(sec) ? sec : state.timer.durationSec;
    state.timer.durationSec = Math.max(1, Math.min(3600, Math.trunc(d)));
    state.timer.remainingSec = state.timer.durationSec;
    commit();
}

function setDuration(sec) {
    state.timer.durationSec = Math.max(1, Math.min(3600, Math.trunc(Number(sec) || DEFAULT_HALFTIME_SEC)));
    if (!state.timer.running) state.timer.remainingSec = state.timer.durationSec;
    commit();
}

/** Nudge the remaining time by ±seconds (operator corrects drift). */
function adjustTimer(deltaSec) {
    const now = get().timer.remainingSec + Math.trunc(deltaSec);
    state.timer.remainingSec = Math.max(0, Math.min(3600, now));
    if (state.timer.running) state.timer.endsAt = Date.now() + state.timer.remainingSec * 1000;
    commit();
}

// ── rotation config ───────────────────────────────────────────────

function setRotation(patch) {
    if (!patch || typeof patch !== 'object') return;
    const r = state.rotation;
    if (patch.active && typeof patch.active === 'object') {
        // Only flip known slides; ignore junk keys.
        for (const k of Object.keys(r.active)) {
            if (typeof patch.active[k] === 'boolean') r.active[k] = patch.active[k];
        }
    }
    if (Number.isFinite(patch.dwellMs)) r.dwellMs = Math.max(3000, Math.min(60000, Math.trunc(patch.dwellMs)));
    // pinned must name a known slide, or be null to free-rotate
    if (patch.pinned === null || (typeof patch.pinned === 'string' && r.active.hasOwnProperty(patch.pinned))) {
        r.pinned = patch.pinned;
    }
    commit();
}

// ── sponsor ad ────────────────────────────────────────────────────

function setAd(patch) {
    if (!patch || typeof patch !== 'object') return;
    const ad = state.ad;
    if (typeof patch.orgName === 'string')  ad.orgName = patch.orgName.slice(0, 48);
    if (typeof patch.tagline === 'string')  ad.tagline = patch.tagline.slice(0, 80);
    if (typeof patch.url === 'string')      ad.url = patch.url.slice(0, 200);
    if (typeof patch.logoFile === 'string') ad.logoFile = patch.logoFile.slice(0, 120);
    commit();
}

/** Set just the logo filename (called by the upload endpoint). */
function setAdLogo(filename) {
    state.ad.logoFile = String(filename || '').slice(0, 120);
    commit();
}

// ── pub/sub ───────────────────────────────────────────────────────

/** Subscribe to state changes. Returns an unsubscribe fn. */
function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

module.exports = {
    get, update, setScore,
    startTimer, pauseTimer, resetTimer, setDuration, adjustTimer,
    setRotation, setAd, setAdLogo,
    subscribe,
    DEFAULTS,
};
