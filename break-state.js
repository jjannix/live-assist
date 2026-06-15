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
    // Demo slides (particles/equalizer/stats/ticker) ship OFF so they
    // don't appear unless the operator opts in.
    rotation: {
        slides: ['clock', 'radial', 'score', 'message', 'ad', 'brand', 'particles', 'equalizer', 'stats', 'ticker', 'splitflap', 'neon', 'wave', 'swiss', 'audiolizer', 'flowfield', 'predictions', 'standings', 'trivia', 'mosaic'],
        active: { clock: true, radial: true, score: true, message: true, ad: true, brand: true, particles: false, equalizer: false, stats: false, ticker: false, splitflap: false, neon: false, wave: false, swiss: false, audiolizer: false, flowfield: false, predictions: false, standings: false, trivia: false, mosaic: false },
        dwellMs: 12000,
        pinned: null,
    },
    // Single sponsor ad. logoFile is a filename served from
    // /break-ads/ (uploaded via POST /api/break-ad). Empty = no logo,
    // the slide shows org name + tagline + QR only.
    ad: { orgName: '', tagline: '', url: '', logoFile: '' },
    // Demo stat callouts for the 'stats' slide. Count up from 0 when the
    // slide appears. Operator-editable in a later pass; for now seeded
    // with plausible demo values so the visual reads immediately.
    stats: [
        { label: 'Zuschauer', value: 147 },
        { label: 'Tore', value: 3 },
        { label: 'Ecken', value: 12 },
        { label: 'Freistösse', value: 8 },
    ],
    // Audience predictions for the 'predictions' slide. Audience votes
    // from /predict.html; the tally streams live to the break screen.
    predictions: {
        question: 'Wie steht es am Ende?',
        tally: {},          // { "2:1": 3, "1:1": 5, ... }
        total: 0,
    },

    // Bundesliga live table (OpenLigaDB, free + no key). Server
    // refreshes every 5 min; the slide is read-only.
    standings: {
        division: 'bl1',    // 'bl1' | 'bl2' | 'bl3'
        season: 2025,
        rows: [],           // [{ rank, name, short, icon, points, goals, against, diff, matches, w, d, l }]
        updatedAt: 0,
        loading: false,
    },

    // Operator-curated trivia. One item per dwell, big display type.
    trivia: {
        items: [
            'Wusstest du: Lewandowski erzielte 2020/21 einen Fünferpack in 9 Minuten — Bundesliga-Rekord.',
            'Wusstest du: Der FC Bayern ist mit 32 Titeln deutscher Rekordmeister.',
            'Wusstest du: 1963 wurde die Bundesliga als eingleisige Profiliga gegründet — 16 Vereine spielten die erste Saison.',
        ],
        dwellMs: 8000,
    },

    // Operator-uploaded photos, ken-burns slow zoom, cycle per dwell.
    mosaic: {
        files: [],          // filenames in public/break-mosaic/
        dwellMs: 7000,
    },
});

let state = load();
const subscribers = new Set();

// ── persistence ───────────────────────────────────────────────────

function load() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const merged = merge(structuredClone(DEFAULTS), parsed);
        reconcileSlides(merged);
        return merged;
    } catch (_) {
        return structuredClone(DEFAULTS);
    }
}

/**
 * Forward-compat: the slide list always tracks DEFAULTS so a new slide
 * added in a later version appears in an existing installation, and a
 * removed one drops out. (Arrays aren't deep-merged, so without this a
 * persisted rotation.slides would mask new defaults forever.) The
 * active{} map — already deep-merged — still controls which are on.
 */
function reconcileSlides(s) {
    if (!s.rotation) return;
    s.rotation.slides = [...DEFAULTS.rotation.slides];
    if (!s.rotation.active) s.rotation.active = {};
    for (const k of DEFAULTS.rotation.slides) {
        if (typeof s.rotation.active[k] !== 'boolean') s.rotation.active[k] = false;
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
    if (partial.predictions) {
        if (typeof partial.predictions.question === 'string') state.predictions.question = partial.predictions.question.slice(0, 80);
    }
    if (partial.standings) {
        if (typeof partial.standings.division === 'string' && /^(bl1|bl2|bl3)$/.test(partial.standings.division)) {
            if (state.standings.division !== partial.standings.division) {
                state.standings.division = partial.standings.division;
                // Schedule a server-side refresh if a refresh fn is wired
                if (typeof onStandingsDivisionChange === 'function') onStandingsDivisionChange(partial.standings.division);
            }
        }
    }
    // Op-style mutations (for non-patch operations like trivia add/remove)
    if (partial.op === 'trivia/add'   && typeof partial.text === 'string') addTrivia(partial.text);
    if (partial.op === 'trivia/remove' && Number.isInteger(partial.index))  removeTriviaAt(partial.index);
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

/** Replace the stats array (demo callouts for the 'stats' slide). */
function setStats(arr) {
    if (!Array.isArray(arr)) return;
    state.stats = arr
        .filter(s => s && typeof s === 'object')
        .slice(0, 6)
        .map(s => ({
            label: String(s.label || '').slice(0, 24),
            value: Math.max(0, Math.min(99999, Math.trunc(Number(s.value) || 0))),
        }));
    commit();
}

// ── audience predictions ──────────────────────────────────────────

/** Record one audience prediction (score string like "2:1"). */
function votePrediction(score) {
    const s = String(score || '').trim().slice(0, 12);
    if (!s) return;
    state.predictions.tally[s] = (state.predictions.tally[s] || 0) + 1;
    state.predictions.total++;
    commit();
}

function clearPredictions() {
    state.predictions.tally = {};
    state.predictions.total = 0;
    commit();
}

// ── standings (Bundesliga live) ───────────────────────────────────

/** Replace the standings table wholesale. Called by the server after
 *  fetching from OpenLigaDB. */
function setStandings(patch) {
    patch = patch || {};
    if (typeof patch.division === 'string' && /^(bl1|bl2|bl3)$/.test(patch.division)) {
        state.standings.division = patch.division;
    }
    if (Number.isFinite(patch.season)) state.standings.season = patch.season;
    if (Array.isArray(patch.rows)) state.standings.rows = patch.rows;
    state.standings.updatedAt = Date.now();
    state.standings.loading = false;
    commit();
}

function setStandingsLoading(v) {
    state.standings.loading = !!v;
    commit();
}

// ── trivia (operator-curated) ─────────────────────────────────────

function setTrivia(patch) {
    patch = patch || {};
    if (Array.isArray(patch.items)) {
        state.trivia.items = patch.items
            .filter(t => typeof t === 'string' && t.trim())
            .slice(0, 30)
            .map(t => t.trim().slice(0, 240));
    }
    if (Number.isFinite(patch.dwellMs)) state.trivia.dwellMs = Math.max(2000, Math.min(60000, patch.dwellMs));
    commit();
}

function addTrivia(text) {
    const t = String(text || '').trim().slice(0, 240);
    if (!t || state.trivia.items.length >= 30) return;
    state.trivia.items.push(t);
    commit();
}

function removeTriviaAt(i) {
    if (!Number.isInteger(i) || i < 0 || i >= state.trivia.items.length) return;
    state.trivia.items.splice(i, 1);
    commit();
}

// ── mosaic (operator-uploaded photos) ─────────────────────────────

function addMosaicFile(name) {
    name = String(name || '').trim();
    if (!name || state.mosaic.files.includes(name)) return;
    if (state.mosaic.files.length >= 24) return;
    state.mosaic.files.push(name);
    commit();
}

function removeMosaicFile(name) {
    const i = state.mosaic.files.indexOf(name);
    if (i < 0) return;
    state.mosaic.files.splice(i, 1);
    commit();
}

function setMosaicDwell(ms) {
    if (Number.isFinite(ms)) state.mosaic.dwellMs = Math.max(2000, Math.min(60000, ms));
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
    setRotation, setAd, setAdLogo, setStats, votePrediction, clearPredictions,
    setStandings, setStandingsLoading,
    setTrivia, addTrivia, removeTriviaAt,
    addMosaicFile, removeMosaicFile, setMosaicDwell,
    subscribe,
    DEFAULTS,
};
