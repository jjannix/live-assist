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
        // The slides you've curated as the core deck. The others are
        // opt-in from the Slides (rotation) panel in the operator page.
        slides: ['clock', 'radial', 'score', 'stats', 'stats_shots', 'stats_radar', 'stats_control', 'lineup_home', 'lineup_away', 'timeline', 'goals', 'performers', 'message', 'ad', 'weather', 'brand', 'mercury', 'flowfield', 'nebel', 'deutsch'],
        active: { clock: true, radial: true, score: true, stats: true, stats_shots: true, stats_radar: true, stats_control: true, lineup_home: true, lineup_away: true, timeline: true, goals: true, performers: true, message: true, ad: true, weather: true, brand: true, mercury: true, flowfield: true, nebel: true, deutsch: true },
        dwellMs: 12000,
        pinned: null,
    },
    // Single sponsor ad. logoFile is a filename served from
    // /break-ads/ (uploaded via POST /api/break-ad). Empty = no logo,
    // the slide shows org name + tagline + QR only.
    // Sponsors are now a list. Each entry renders as a broadcast-style
    // bumper that crossfades into the next on the ad slide. Migration
    // from the old single-sponsor shape (orgName/tagline/url/logoFile)
    // happens in reconcile() below.
    ad: {
        items: [],         // [{ orgName, tagline, url, logoFile }]
        dwellMs: 8000,     // per-sponsor dwell when multiple are configured
    },
    // Break screen visual mode: 'default' | 'germany'.
    // Subtly changes the colour palette (accent, glow, orbs) so
    // the operator can give halftime a national touch.
    mode: 'default',

    // Live match data from API-Football (football-state.js). All
    // fields here are NON-SECRET: the API key never appears in this
    // object, the Socket.IO payload, or the persisted JSON. The
    // snapshot is a normalised, Euro Studio-owned view (plain team
    // names + numbers + a status summary) — provider schemas don't
    // leak through. See football-state.js for the fetch/normalise
    // logic and the quota-conscious break-only polling strategy.
    liveMatch: {
        enabled: true,              // operator runtime on/off
        selectedFixtureId: null,    // the operator's picked fixture
        manualOverride: false,      // when true, manual edits win over live
        snapshot: null,             // last-good normalised provider snapshot
        sync: {
            lastUpdated: null,      // epoch ms of last successful fetch
            lastAttempt: null,      // epoch ms of last attempt (incl. failed)
            lastError: null,        // classified error string (non-secret)
            remaining: null,        // provider quota remaining, if exposed
            source: null,           // 'fixture' | 'fixture+statistics'
        },
    },

    // (No additional state — only the 7 curated slides remain.)
    // Live local weather for the "weather" slide. Populated by the
    // weather-state poller (Open-Meteo, no API key). All fields null
    // until the first successful fetch; the slide degrades to a
    // loading / "—" state when empty.
    weather: {
        temp: null,           // current temperature, °C
        feelsLike: null,      // apparent temperature, °C
        code: null,           // WMO weather code
        label: '',            // "Klar", "Regen", …
        wind: null,           // km/h
        windDir: '',          // 16-point compass, German (O = Ost)
        humidity: null,       // %
        uv: null,
        high: null,           // today's max, °C
        low: null,            // today's min, °C
        hourly: [],           // [{ time, temp, code }] next ~6 h
        scene: '',            // 'clear-day' | 'rain' | … (drives the bg)
        isDay: true,
        location: '',         // free-text label (city / ground)
        updatedAt: null,      // epoch ms of last successful fetch
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
        reconcileAd(merged);
        reconcileLiveMatch(merged);
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

// Migrate the old single-sponsor shape (ad.orgName, ad.tagline, ad.url,
// ad.logoFile) into the new ad.items[] list. Runs once on load for any
// persisted state that predates the multi-sponsor refactor.
function reconcileAd(s) {
    if (!s.ad) return;
    if (Array.isArray(s.ad.items)) {
        s.ad.items = s.ad.items
            .filter(x => x && typeof x === 'object')
            .slice(0, 8)
            .map(normalizeSponsor);
    } else {
        s.ad.items = [];
    }
    if (s.ad.orgName || s.ad.tagline || s.ad.url || s.ad.logoFile) {
        s.ad.items.unshift(normalizeSponsor(s.ad));
    }
    if (!Number.isFinite(s.ad.dwellMs)) s.ad.dwellMs = 8000;
    // Clear the legacy fields so they don't keep re-migrating
    s.ad.orgName = ''; s.ad.tagline = ''; s.ad.url = ''; s.ad.logoFile = '';
}

function normalizeSponsor(x) {
    return {
        orgName: String(x.orgName || '').slice(0, 60),
        tagline: String(x.tagline || '').slice(0, 80),
        url:     String(x.url || '').slice(0, 200),
        logoFile:String(x.logoFile || '').slice(0, 80),
    };
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
        let edited = false;
        if (typeof partial.matchClock.label === 'string')   { state.matchClock.label = partial.matchClock.label.slice(0, 8); edited = true; }
        if (typeof partial.matchClock.display === 'string') { state.matchClock.display = partial.matchClock.display.slice(0, 12); edited = true; }
        if (edited && state.liveMatch && state.liveMatch.selectedFixtureId) state.liveMatch.manualOverride = true;
    }
    commit();
}

function patchTeam(team, patch) {
    if (typeof patch.name === 'string')  team.name = patch.name.slice(0, 24);
    if (Number.isFinite(patch.score))    team.score = Math.max(0, Math.min(99, Math.trunc(patch.score)));
    // Manual score/name edits are an explicit override: if a live
    // fixture is selected, the operator's hand-typed values win until
    // they hit "Resync from live". This guarantees an API failure or
    // stale snapshot can never blank or corrupt a valid manual score.
    if (state.liveMatch && state.liveMatch.selectedFixtureId) {
        state.liveMatch.manualOverride = true;
    }
}

function setScore(side, delta) {
    if (side !== 'home' && side !== 'away') return;
    state[side].score = Math.max(0, Math.min(99, state[side].score + (delta > 0 ? 1 : -1)));
    if (state.liveMatch && state.liveMatch.selectedFixtureId) state.liveMatch.manualOverride = true;
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

// ── multi-sponsor ad management ───────────────────────────────────
// Each sponsor is one entry in state.ad.items. The slide renders a
// panel per item and crossfades between them on a dwell timer.

/** Add a new blank sponsor at the end of the list. */
function addSponsor(sponsor) {
    if (state.ad.items.length >= 8) return;
    state.ad.items.push(normalizeSponsor(sponsor || {}));
    commit();
}

/** Update one sponsor in place (by index). */
function updateSponsor(i, patch) {
    if (!Number.isInteger(i) || i < 0 || i >= state.ad.items.length) return;
    const cur = state.ad.items[i];
    if (typeof patch.orgName === 'string')  cur.orgName = patch.orgName.slice(0, 60);
    if (typeof patch.tagline === 'string')  cur.tagline = patch.tagline.slice(0, 80);
    if (typeof patch.url === 'string')      cur.url = patch.url.slice(0, 200);
    if (typeof patch.logoFile === 'string') cur.logoFile = patch.logoFile.slice(0, 80);
    commit();
}

/** Remove the sponsor at index. */
function removeSponsor(i) {
    if (!Number.isInteger(i) || i < 0 || i >= state.ad.items.length) return;
    state.ad.items.splice(i, 1);
    commit();
}

/** Set just the logo for the sponsor at index. Used by the upload endpoint. */
function setSponsorLogo(i, filename) {
    if (!Number.isInteger(i) || i < 0 || i >= state.ad.items.length) return;
    state.ad.items[i].logoFile = String(filename || '').slice(0, 80);
    commit();
}

/** Per-sponsor dwell time. */
function setAdDwell(ms) {
    if (Number.isFinite(ms)) state.ad.dwellMs = Math.max(2000, Math.min(60000, ms));
    commit();
}

/** Backward-compat shim: legacy setAd() routes a single-sponsor patch
 *  into items[0]. Existing callsites keep working. */
function setAd(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (!state.ad.items.length) addSponsor({});
    updateSponsor(0, patch);
}

// Forward-compat for liveMatch: ensure the section + its nested sync
// object exist with the default shape on an older persisted file.
function reconcileLiveMatch(s) {
    if (!s.liveMatch || typeof s.liveMatch !== 'object') s.liveMatch = structuredClone(DEFAULTS.liveMatch);
    if (!s.liveMatch.sync || typeof s.liveMatch.sync !== 'object') s.liveMatch.sync = structuredClone(DEFAULTS.liveMatch.sync);
    // Redact defensively: if a key ever slipped in (it never should),
    // drop it on load so it can't be re-persisted or broadcast.
    delete s.liveMatch.apiKey;
    delete s.liveMatch.key;
}

/** Read-only view of the live-match block (no secrets here). */
function getLiveMatch() {
    return structuredClone(state.liveMatch);
}

/**
 * Merge a (validated, sanitised) patch into state.liveMatch. Only
 * known keys are honoured; nested sync is deep-merged. Never accepts
 * a key — that lives only in process.env, never in state.
 */
function setLiveMatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const lm = state.liveMatch;
    if (typeof patch.enabled === 'boolean') lm.enabled = patch.enabled;
    if (patch.selectedFixtureId === null || Number.isInteger(patch.selectedFixtureId)) {
        lm.selectedFixtureId = patch.selectedFixtureId;
    }
    if (typeof patch.manualOverride === 'boolean') lm.manualOverride = patch.manualOverride;
    if (patch.snapshot === null || (patch.snapshot && typeof patch.snapshot === 'object')) {
        lm.snapshot = patch.snapshot === null ? null : sanitizeSnapshot(patch.snapshot);
    }
    if (patch.sync && typeof patch.sync === 'object') {
        const s = lm.sync;
        if (patch.sync.lastUpdated === null || Number.isFinite(patch.sync.lastUpdated)) s.lastUpdated = patch.sync.lastUpdated;
        if (patch.sync.lastAttempt === null || Number.isFinite(patch.sync.lastAttempt)) s.lastAttempt = patch.sync.lastAttempt;
        if (typeof patch.sync.lastError === 'string') s.lastError = patch.sync.lastError.slice(0, 40);
        else if (patch.sync.lastError === null) s.lastError = null;
        if (patch.sync.remaining === null || Number.isFinite(patch.sync.remaining)) s.remaining = patch.sync.remaining;
        if (typeof patch.sync.source === 'string') s.source = patch.sync.source.slice(0, 30);
        else if (patch.sync.source === null) s.source = null;
    }
    commit();
}

// Strip any unexpected keys before a snapshot is stored, so a future
// provider schema change can't smuggle unrelated fields into state.
function sanitizeSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const pick = (o, keys) => {
        const out = {};
        for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
        return out;
    };
    const out = pick(snap, ['fixtureId', 'competition', 'home', 'away', 'status', 'clock', 'stats', 'kickoff', 'updatedAt']);
    if (snap.home) out.home = pick(snap.home, ['name', 'score']);
    if (snap.away) out.away = pick(snap.away, ['name', 'score']);
    if (snap.status) out.status = pick(snap.status, ['code', 'label', 'short', 'elapsed', 'live', 'finished']);
    if (snap.clock) out.clock = pick(snap.clock, ['label', 'display']);
    if (snap.stats && typeof snap.stats === 'object') {
        out.stats = {};
        for (const k of Object.keys(snap.stats)) {
            const v = snap.stats[k];
            if (v && typeof v === 'object') out.stats[k] = pick(v, ['home', 'away']);
        }
    }
    if (snap.lineups && typeof snap.lineups === 'object') {
        out.lineups = {};
        for (const side of ['home', 'away']) {
            const lineup = snap.lineups[side];
            if (!lineup || typeof lineup !== 'object') { out.lineups[side] = null; continue; }
            out.lineups[side] = pick(lineup, ['formation', 'coach']);
            out.lineups[side].startXI = (Array.isArray(lineup.startXI) ? lineup.startXI : []).slice(0, 11).map(p => pick(p || {}, ['name', 'number', 'position', 'grid']));
            out.lineups[side].substitutes = (Array.isArray(lineup.substitutes) ? lineup.substitutes : []).slice(0, 15).map(p => pick(p || {}, ['name', 'number', 'position']));
        }
    }
    out.events = (Array.isArray(snap.events) ? snap.events : []).slice(0, 100).map(e => pick(e || {}, ['minute', 'extra', 'side', 'type', 'detail', 'player', 'assist']));
    out.topPlayers = (Array.isArray(snap.topPlayers) ? snap.topPlayers : []).slice(0, 3).map(p => pick(p || {}, ['name', 'side', 'number', 'position', 'rating', 'minutes', 'goals', 'assists', 'shots', 'shotsOn', 'keyPasses', 'tackles', 'interceptions', 'duelsWon', 'saves']));
    return out;
}

/**
 * Apply the last live snapshot to the displayed score / teams / clock
 * — UNLESS manualOverride is set, in which case the operator's hand-
 * typed values are kept untouched. Called after every successful sync
 * and on explicit "Resync from live". A missing/empty snapshot is a
 * no-op so the manual state is never clobbered by a failed fetch.
 */
function applyLiveMatchSnapshot() {
    const lm = state.liveMatch;
    if (!lm || lm.manualOverride) return;
    const snap = lm.snapshot;
    if (!snap) return;
    if (snap.home && typeof snap.home.name === 'string') state.home.name = snap.home.name.slice(0, 24);
    if (snap.away && typeof snap.away.name === 'string') state.away.name = snap.away.name.slice(0, 24);
    if (snap.home && Number.isFinite(snap.home.score)) state.home.score = Math.max(0, Math.min(99, Math.trunc(snap.home.score)));
    if (snap.away && Number.isFinite(snap.away.score)) state.away.score = Math.max(0, Math.min(99, Math.trunc(snap.away.score)));
    if (snap.clock) {
        if (typeof snap.clock.label === 'string')   state.matchClock.label = snap.clock.label.slice(0, 8);
        if (typeof snap.clock.display === 'string') state.matchClock.display = snap.clock.display.slice(0, 12);
    }
    commit();
}

/** Merge a weather snapshot from the poller into state.weather. */
function setWeather(patch) {
    if (!patch || typeof patch !== 'object') return;
    state.weather = Object.assign({}, state.weather, patch);
    commit();
}

/** Toggle or set the visual mode ('default' | 'germany'). */
function setMode(mode) {
    if (mode !== 'default' && mode !== 'germany') return;
    state.mode = mode;
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
    setRotation, setAd,
    addSponsor, updateSponsor, removeSponsor, setSponsorLogo, setAdDwell,
    setWeather, setMode,
    getLiveMatch, setLiveMatch, applyLiveMatchSnapshot,
    subscribe,
    DEFAULTS,
};
