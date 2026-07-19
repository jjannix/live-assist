/**
 * football-state.js — isolated server-side client for API-Football
 * (API-Sports v3), the data source behind the break screen's live
 * score + match statistics.
 *
 * Why this is its own module: the API key NEVER leaves the server.
 * Browsers, Socket.IO payloads, logs, error messages, and the
 * persisted break-state.json only ever see normalised, Euro Studio-
 * owned snapshots plus a non-sensitive status object (a boolean
 * "hasKey", not the key itself). All provider requests originate here.
 *
 * Quota is the hard design constraint — the free plan is 100/day.
 * Strategy:
 *   • No background polling. Entering a break performs one snapshot
 *     sync, then makes zero automatic calls until the next activation.
 *   • The detailed fixture request normally embeds stats, lineups,
 *     events, and player ratings. If stats are absent, the activation
 *     sync may spend one fallback request for them (maximum two calls).
 *   • Fixture discovery (by date) is cached for a short window and
 *     concurrent identical requests are deduped onto a single fetch,
 *     so two controllers tapping "load fixtures" or "refresh" at the
 *     same time cost one call, not two.
 *
 * The module is intentionally testable: configure() accepts an
 * injected fetch implementation, a "state sink" (default: break-state)
 * and an env snapshot, so tests never touch the network or the disk.
 */

const breakState = require('./break-state');

const BASE_URL = 'https://v3.football.api-sports.io';
const REQUEST_TIMEOUT_MS = 8000;
const LIST_CACHE_TTL_MS = 60 * 1000;        // discovery cache (per date)
const MIN_REFRESH_MS = 60 * 1000;           // never poll more often than once/minute
const DEFAULT_REFRESH_MS = 60 * 1000;       // safe default per spec

// ── configurable seams (injected by tests, defaults for runtime) ──
let _fetchImpl = (...args) => fetch(...args);
let _now = () => Date.now();
let _env = {};          // refreshed from process.env by configure/reload
let _sink = breakState; // where normalised state lands
let _log = () => {};    // non-secret logger (lines, never the key)

// ── live runtime flags ──
let inBreak = false;
let pollTimer = null;
let pollTick = 0;
const inflight = new Map();     // cacheKey → Promise (dedupes concurrent calls)
const listCache = new Map();    // 'YYYY-MM-DD' → { at, data }

// ════════════════════════════════════════════════════════════════
//  Configuration
// ════════════════════════════════════════════════════════════════

/**
 * (Re)read configuration. Called at boot and on config hot-reload.
 * opts.env defaults to process.env so the live .env is authoritative.
 */
function configure(opts) {
    opts = opts || {};
    if (typeof opts.fetchImpl === 'function') _fetchImpl = opts.fetchImpl;
    if (typeof opts.now === 'function') _now = opts.now;
    if (typeof opts.log === 'function') _log = opts.log;
    if (opts.sink) _sink = opts.sink;
    _env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
}

configure();   // prime from process.env at load

function boolEnv(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
}

/** Config switch + operator runtime switch + key must all allow access. */
function isAvailable() {
    return getEnabled() && runtimeEnabled() && hasKey();
}
function runtimeEnabled() {
    const lm = _sink.getLiveMatch ? _sink.getLiveMatch() : null;
    return !lm || lm.enabled !== false;
}
function getEnabled() {
    // If the setting is absent (older hand-written .env), infer ON from
    // a present key. The in-app schema writes an explicit false by default.
    return boolEnv(_env.API_FOOTBALL_ENABLED, hasKey());
}
function hasKey() {
    return typeof _env.API_FOOTBALL_KEY === 'string' && _env.API_FOOTBALL_KEY.trim().length > 0;
}
function getLeague() {
    const n = parseInt(_env.API_FOOTBALL_LEAGUE, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;        // 1 = World Cup
}
function getSeason() {
    const n = parseInt(_env.API_FOOTBALL_SEASON, 10);
    return Number.isFinite(n) && n > 1900 ? n : 2026;
}
function getRefreshMs() {
    const n = parseInt(_env.API_FOOTBALL_REFRESH_MS, 10);
    return Number.isFinite(n) ? Math.max(MIN_REFRESH_MS, n) : DEFAULT_REFRESH_MS;
}

// ════════════════════════════════════════════════════════════════
//  Value normalisation — pure, exported for testing
// ════════════════════════════════════════════════════════════════

/**
 * Coerce a provider statistic value into a plain number or null.
 * Handles "56%", "12", 12, null, "". Percent signs are stripped; the
 * caller decides whether to treat the number as a percent.
 */
function parseStatValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '' || s.toLowerCase() === 'null') return null;
        const m = s.replace('%', '').trim();
        const n = Number(m);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

// Coerce a single goals value (home OR away) into a non-negative
// integer. Null/undefined/missing → 0, so a not-started match reads
// 0:0 rather than "NaN" on the beamer.
function teamScore(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

// API-Football `fixture.status.short` → audience-facing label + clock.
// Returns { code, label, short, elapsed, live, finished }.
const STATUS_LABELS_DE = {
    NS:  'vor Anpfiff',
    NOT: 'vor Anpfiff',
    '1H': '1. Halbzeit',
    HT:  'Halbzeit',
    '2H': '2. Halbzeit',
    ET:  'Verlängerung',
    BT:  'Pause',
    P:   'Elfmeterschießen',
    FT:  'Spielende',
    AET: 'nach Verlängerung',
    PEN: 'nach Elfmeter',
    SUSP:'unterbrochen',
    INT: 'unterbrochen',
    PST: 'verlegt',
    CANC:'abgesagt',
    ABD: 'abgebrochen',
    AWD: 'Wertung',
    WO:  'kampflos',
    LIVE:'live',
};

function mapStatus(status) {
    status = status || {};
    const short = String(status.short || '').toUpperCase();
    const elapsed = Number.isFinite(Number(status.elapsed)) ? Math.trunc(Number(status.elapsed)) : null;
    const live = ['1H', '2H', 'ET', 'P', 'LIVE', 'HT', 'BT'].includes(short);
    const finished = ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(short);
    const label = STATUS_LABELS_DE[short] || (short || '—');
    return { code: short || null, label, short, elapsed, live, finished };
}

// A compact clock string for the lower-third / match-clock display.
function clockFromStatus(statusObj) {
    const s = mapStatus(statusObj);
    if (s.finished) return { label: s.short === 'PEN' ? 'E' : 'FT', display: s.label };
    if (s.short === 'HT') return { label: 'HT', display: 'Halbzeit' };
    if (s.short === 'NS' || s.short === 'NOT' || !s.code) return { label: 'KO', display: s.label };
    if (s.elapsed != null) return { label: s.short, display: s.elapsed + "'" };
    return { label: s.short || '—', display: s.label };
}

// Map provider statistics[] arrays (one per team) into a canonical
// { home, away } map of numbers. Unknown types are ignored; nulls stay
// null so the UI can omit them gracefully.
const STAT_KEYS = {
    'ball possession': 'possession',
    'shots on goal': 'shotsOnTarget',
    'shots off goal': 'shotsOffTarget',
    'blocked shots': 'shotsBlocked',
    'shots insidebox': 'shotsInsideBox',
    'shots outsidebox': 'shotsOutsideBox',
    'total shots': 'shotsTotal',
    'corner kicks': 'corners',
    'fouls': 'fouls',
    'offsides': 'offsides',
    'yellow cards': 'yellowCards',
    'red cards': 'redCards',
    'goalkeeper saves': 'saves',
    'total passes': 'passes',
    'passes accurate': 'passesAccurate',
    'passes %': 'passesPct',
};

function normalizeStatistics(response) {
    const out = {};
    for (const k of Object.values(STAT_KEYS)) out[k] = { home: null, away: null };
    const rows = Array.isArray(response) ? response : (response && response.response) || [];
    rows.forEach((row, idx) => {
        const side = idx === 0 ? 'home' : 'away';
        const stats = (row && Array.isArray(row.statistics)) ? row.statistics : [];
        for (const entry of stats) {
            const type = String(entry && entry.type || '').trim().toLowerCase();
            const key = STAT_KEYS[type];
            if (!key) continue;
            out[key][side] = parseStatValue(entry && entry.value);
        }
    });
    return out;
}

function fixtureSide(team, home, away) {
    const rawId = team && team.id;
    const id = rawId == null ? null : Number(rawId);
    if (Number.isFinite(id) && home && home.id != null && Number(home.id) === id) return 'home';
    if (Number.isFinite(id) && away && away.id != null && Number(away.id) === id) return 'away';
    const name = String(team && team.name || '').trim().toLowerCase();
    if (name && name === String(home && home.name || '').trim().toLowerCase()) return 'home';
    if (name && name === String(away && away.name || '').trim().toLowerCase()) return 'away';
    return null;
}

function cleanPlayer(player) {
    player = player || {};
    return {
        name: String(player.name || '—').slice(0, 36),
        number: statNumber(player.number) != null ? Math.max(0, Math.min(99, Math.trunc(Number(player.number)))) : null,
        position: String(player.pos || player.position || '').slice(0, 4),
        grid: /^\d{1,2}:\d{1,2}$/.test(String(player.grid || '')) ? String(player.grid) : null,
    };
}

function normalizeLineups(rows, home, away) {
    const out = { home: null, away: null };
    for (const row of Array.isArray(rows) ? rows : []) {
        const side = fixtureSide(row && row.team, home, away);
        if (!side) continue;
        out[side] = {
            formation: String(row.formation || '').slice(0, 12),
            coach: String(row.coach && row.coach.name || '').slice(0, 36),
            startXI: (Array.isArray(row.startXI) ? row.startXI : []).slice(0, 11).map(x => cleanPlayer(x && x.player)),
            substitutes: (Array.isArray(row.substitutes) ? row.substitutes : []).slice(0, 15).map(x => cleanPlayer(x && x.player)),
        };
    }
    return out;
}

function normalizeEvents(rows, home, away) {
    return (Array.isArray(rows) ? rows : []).map(row => {
        const side = fixtureSide(row && row.team, home, away);
        if (!side) return null;
        const elapsed = statNumber(row && row.time && row.time.elapsed);
        const extra = statNumber(row && row.time && row.time.extra);
        return {
            minute: Number.isFinite(elapsed) ? Math.max(0, Math.min(150, Math.trunc(elapsed))) : null,
            extra: Number.isFinite(extra) ? Math.max(0, Math.min(30, Math.trunc(extra))) : null,
            side,
            type: String(row.type || '').slice(0, 12),
            detail: String(row.detail || '').slice(0, 30),
            player: String(row.player && row.player.name || '').slice(0, 36),
            assist: String(row.assist && row.assist.name || '').slice(0, 36),
        };
    }).filter(Boolean).slice(0, 100);
}

function statNumber(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizeTopPlayers(rows, home, away) {
    const players = [];
    for (const teamRow of Array.isArray(rows) ? rows : []) {
        const side = fixtureSide(teamRow && teamRow.team, home, away);
        if (!side) continue;
        for (const row of Array.isArray(teamRow.players) ? teamRow.players : []) {
            const p = row && row.player || {};
            const s = row && Array.isArray(row.statistics) && row.statistics[0] || {};
            const games = s.games || {}, goals = s.goals || {}, shots = s.shots || {}, passes = s.passes || {};
            const tackles = s.tackles || {}, duels = s.duels || {};
            const rating = statNumber(games.rating);
            if (!String(p.name || '').trim() || rating == null) continue;
            players.push({
                name: String(p.name).slice(0, 36), side,
                number: statNumber(games.number) != null ? Math.max(0, Math.min(99, Math.trunc(Number(games.number)))) : null,
                position: String(games.position || '').slice(0, 16),
                rating: Math.max(0, Math.min(10, Math.round(rating * 10) / 10)),
                minutes: statNumber(games.minutes), goals: statNumber(goals.total), assists: statNumber(goals.assists),
                shots: statNumber(shots.total), shotsOn: statNumber(shots.on), keyPasses: statNumber(passes.key),
                tackles: statNumber(tackles.total), interceptions: statNumber(tackles.interceptions),
                duelsWon: statNumber(duels.won), saves: statNumber(goals.saves),
            });
        }
    }
    return players.sort((a, b) => b.rating - a.rating || (b.goals || 0) - (a.goals || 0) || (b.assists || 0) - (a.assists || 0)).slice(0, 3);
}

/**
 * Normalise a /fixtures response entry (or the inner object of a list
 * response) into a Euro Studio-owned snapshot. No provider logos,
 * ids-as-strings, or nested schemas leak through — just plain names,
 * numbers, and a status summary.
 */
function normalizeFixture(entry, stats) {
    if (!entry || typeof entry !== 'object') return null;
    const f = entry.fixture || {};
    const teams = entry.teams || {};
    const home = teams.home || {};
    const away = teams.away || {};
    const goals = entry.goals || {};
    const league = entry.league || {};

    const statusObj = f.status || {};
    const clock = clockFromStatus(statusObj);

    const snapshot = {
        fixtureId: Number.isFinite(Number(f.id)) ? Math.trunc(Number(f.id)) : null,
        competition: String(league.name || 'World Cup').slice(0, 40),
        home: { name: String(home.name || 'Heim').slice(0, 24), score: teamScore(goals.home) },
        away: { name: String(away.name || 'Gast').slice(0, 24), score: teamScore(goals.away) },
        status: mapStatus(statusObj),
        clock,
        stats: normalizeStatistics(stats || entry.statistics || []),
        lineups: normalizeLineups(entry.lineups, home, away),
        events: normalizeEvents(entry.events, home, away),
        topPlayers: normalizeTopPlayers(entry.players, home, away),
        kickoff: Number.isFinite(Number(f.timestamp)) ? Math.trunc(Number(f.timestamp) * 1000) : null,
        updatedAt: _now(),
    };
    return snapshot;
}

/** Compact list-item view for the "pick today's fixture" workflow. */
function normalizeFixtureListItem(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const f = entry.fixture || {};
    const teams = entry.teams || {};
    const goals = entry.goals || {};
    const s = mapStatus(f.status);
    return {
        fixtureId: Number.isFinite(Number(f.id)) ? Math.trunc(Number(f.id)) : null,
        home: String((teams.home || {}).name || 'Heim').slice(0, 24),
        away: String((teams.away || {}).name || 'Gast').slice(0, 24),
        homeScore: teamScore(goals.home),
        awayScore: teamScore(goals.away),
        status: s.short || 'NS',
        live: !!s.live,
        finished: !!s.finished,
        kickoff: Number.isFinite(Number(f.timestamp)) ? Math.trunc(Number(f.timestamp) * 1000) : null,
        elapsed: Number.isFinite(Number((f.status || {}).elapsed)) ? Math.trunc(Number(f.status.elapsed)) : null,
    };
}

// ════════════════════════════════════════════════════════════════
//  HTTP — server-side only, key in header, timeout + classification
// ════════════════════════════════════════════════════════════════

function classifyError(err, httpStatus) {
    if (!err && httpStatus == null) return null;
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED')) return 'network';
    if (httpStatus === 401 || httpStatus === 403) return 'auth';
    if (httpStatus === 429) return 'rate-limit';
    if (httpStatus != null && (httpStatus < 200 || httpStatus >= 300)) return 'http-' + httpStatus;
    if (err) return 'network';
    return null;
}

/**
 * Authenticated GET with timeout. Returns { data, remaining }.
 * `remaining` is a non-sensitive number when the provider exposes
 * quota metadata (response body `account.remaining_requests` or the
 * documented rate-limit headers); otherwise null. We never assume the
 * headers exist.
 */
async function apiGet(search, op) {
    const url = BASE_URL + (search || '');
    const headers = {
        'x-apisports-key': String(_env.API_FOOTBALL_KEY || ''),
    };
    let res;
    try {
        res = await _fetchImpl(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (e) {
        const reason = classifyError(e);
        _log('API-Football ' + op + ' failed: ' + reason);
        const err = new Error(reason || 'network');
        err.reason = reason;
        throw err;
    }

    if (!res.ok) {
        const reason = classifyError(null, res.status);
        _log('API-Football ' + op + ' HTTP ' + res.status + ' (' + reason + ')');
        const err = new Error(reason || ('http-' + res.status));
        err.reason = reason;
        err.httpStatus = res.status;
        throw err;
    }

    let data;
    try {
        data = await res.json();
    } catch (e) {
        const err = new Error('parse');
        err.reason = 'parse';
        _log('API-Football ' + op + ' returned non-JSON');
        throw err;
    }

    // Provider error array (auth, bad params, …) — surface the class
    // only, never the raw body which can echo the request.
    if (data && data.errors && !isEmptyErrors(data.errors)) {
        // Classify known provider responses without forwarding their raw
        // text to clients/logs (it may change or contain request details).
        const providerText = safeErrorText(data.errors).toLowerCase();
        let reason = 'provider-error';
        if (res.status === 401 || res.status === 403) reason = 'auth';
        else if (providerText.includes('plan') && (providerText.includes('season') || providerText.includes('access'))) reason = 'plan-access';
        else if (providerText.includes('rate') || providerText.includes('limit')) reason = 'rate-limit';
        _log('API-Football ' + op + ' reported: ' + reason);
        const err = new Error(reason);
        err.reason = reason;
        throw err;
    }

    const remaining = extractRemaining(res, data);
    return { data, remaining };
}

function isEmptyErrors(errors) {
    if (errors == null) return true;
    if (Array.isArray(errors)) return errors.length === 0;
    if (typeof errors === 'object') return Object.keys(errors).length === 0;
    return false;
}

function safeErrorText(errors) {
    if (Array.isArray(errors)) return errors.map(String).join(' ');
    if (errors && typeof errors === 'object') return Object.entries(errors).map(([k, v]) => String(k) + ' ' + String(v)).join(' ');
    return String(errors || '');
}

function extractRemaining(res, data) {
    // Documented response-body account block (some plans).
    if (data && data.account && Number.isFinite(Number(data.account.remaining_requests))) {
        return Math.max(0, Math.trunc(Number(data.account.remaining_requests)));
    }
    // Documented rate-limit headers (present on some responses). We do
    // NOT assume these exist; missing → null.
    try {
        const v = res.headers && (res.headers.get('x-ratelimit-requests-remaining') || res.headers.get('x-ratelimit-remaining'));
        if (v != null && v !== '' && Number.isFinite(Number(v))) return Math.max(0, Math.trunc(Number(v)));
    } catch (_) { /* headers may be undefined in tests */ }
    return null;
}

// ── fixture discovery (by date), cached + deduped ────────────────

function validDate(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const [y, m, day] = d.split('-').map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, day));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === day;
}

/**
 * Load fixtures for a date. Cached for LIST_CACHE_TTL_MS and deduped
 * against concurrent calls for the same date, so several controllers
 * opening the picker at once cost a single request.
 */
async function listFixtures(date) {
    const today = localDateString(_now());
    if (date !== undefined && !validDate(date)) throw makeError('invalid-date');
    const d = date || today;
    if (!getEnabled() || !runtimeEnabled()) throw makeError('disabled');
    if (!hasKey()) throw makeError('no-key');
    const cached = listCache.get(d);
    if (cached && (_now() - cached.at) < LIST_CACHE_TTL_MS) {
        return { date: d, fixtures: cached.data, cached: true };
    }
    const key = 'list:' + d;
    if (inflight.has(key)) return inflight.get(key);

    const task = (async () => {
        const league = getLeague();
        const season = getSeason();
        const search = '/fixtures?league=' + league + '&season=' + season + '&date=' + encodeURIComponent(d);
        try {
            let result;
            let fallback = false;
            try {
                // Required primary API-Football discovery query.
                result = await apiGet(search, 'fixtures?date');
            } catch (e) {
                if (e.reason !== 'plan-access') throw e;
                // Some Free accounts expose current fixtures via the
                // date-only feed while rejecting the equivalent season
                // filter. Spend one guarded fallback request and filter
                // server-side; cache/dedup still prevents device fan-out.
                result = await apiGet('/fixtures?date=' + encodeURIComponent(d), 'fixtures?date-fallback');
                fallback = true;
            }
            const resp = Array.isArray(result.data && result.data.response) ? result.data.response : [];
            const scoped = fallback ? resp.filter(entry => {
                const l = entry && entry.league;
                return Number(l && l.id) === league && Number(l && l.season) === season;
            }) : resp;
            const fixtures = scoped.map(normalizeFixtureListItem).filter(Boolean);
            if (fallback) _log('Fixture discovery fallback found ' + fixtures.length + ' matching fixture(s)');
            listCache.set(d, { at: _now(), data: fixtures });
            noteRemaining(result.remaining);
            return { date: d, fixtures, cached: false, fallback };
        } catch (e) {
            recordAttempt(e.reason || 'network', null);
            throw e;
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, task);
    return task;
}

// ════════════════════════════════════════════════════════════════
//  Sync — fetch the selected fixture + (sometimes) statistics
// ════════════════════════════════════════════════════════════════

function validFixtureId(id) {
    const n = Number(id);
    return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n < 0x7fffffff;
}

function selectedFixtureId() {
    const cur = _sink.getLiveMatch ? _sink.getLiveMatch() : null;
    const id = cur && cur.selectedFixtureId;
    return validFixtureId(id) ? Math.trunc(Number(id)) : null;
}

/** Fetch the detailed fixture (always) and statistics (when needed). */
async function sync(opts) {
    opts = opts || {};
    const fixtureId = selectedFixtureId();

    // Quota guard rails — never call the API when we shouldn't.
    if (!getEnabled() || !runtimeEnabled()) return statusWithReason('disabled');
    if (!hasKey()) return statusWithReason('no-key');
    if (!fixtureId) return statusWithReason('no-fixture');

    const withStats = opts.withStats !== false && shouldFetchStats(opts.force);
    const key = 'sync:' + fixtureId + ':' + (withStats ? 's' : 'n');
    if (inflight.has(key)) return inflight.get(key);

    const task = (async () => {
        let snapshot = null;
        let source = null;
        let remaining = null;
        try {
            // 1. Detailed fixture — score / status / clock / teams.
            const fr = await apiGet('/fixtures?id=' + fixtureId, 'fixtures?id');
            const fResp = fr && fr.data && Array.isArray(fr.data.response) ? fr.data.response : [];
            const entry = fResp[0];
            remaining = fr.remaining;
            if (!entry) throw makeError('empty');

            // 2. Prefer statistics embedded in the fixture detail. On
            // supported competitions this avoids a second API request.
            let stats = Array.isArray(entry.statistics) && entry.statistics.length ? entry.statistics : null;
            if (stats) {
                source = 'fixture+embedded';
            } else if (withStats) {
                try {
                    const sr = await apiGet('/fixtures/statistics?fixture=' + fixtureId, 'fixtures/statistics');
                    stats = sr && sr.data;
                    remaining = sr.remaining != null ? sr.remaining : remaining;
                    source = 'fixture+statistics';
                } catch (statErr) {
                    // Stats are a nice-to-have; a failure there must not
                    // discard a perfectly good fixture/score result.
                    source = 'fixture';
                    _log('Statistics fetch failed (' + (statErr.reason || '?') + ') — keeping fixture data');
                }
            } else {
                source = 'fixture';
            }

            snapshot = normalizeFixture(entry, stats);
            if (!snapshot) throw makeError('parse');

            publishSnapshot(snapshot, { source, remaining });
            recordAttempt(null, _now());
            _log('Synced ' + snapshot.home.name + ' ' + snapshot.home.score + ':' + snapshot.away.score + ' ' + snapshot.away.name +
                ' (' + (snapshot.status.label) + ')' + (source === 'fixture+statistics' ? ' +stats' : ''));
            return getStatus();
        } catch (e) {
            recordAttempt(e.reason || 'network', null);
            // Stale-data behaviour: keep the last good snapshot; only
            // the sync metadata flips to the error state. A failure
            // never blanks a valid manual or previously-synced score.
            return getStatus();
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, task);
    return task;
}

/**
 * Decide whether THIS sync may pay for the statistics fallback.
 * Only explicit/activation refreshes are allowed to do so; a caller
 * using force=false consumes only the embedded fixture payload.
 */
function shouldFetchStats(force) {
    return !!force;
}

// ════════════════════════════════════════════════════════════════
//  Break-lifecycle one-shot sync
// ════════════════════════════════════════════════════════════════

/** Capture one match snapshot when the break screen is activated. */
function startBreakPolling() {
    stopBreakPolling();
    if (!isAvailable()) { inBreak = true; emitStatus(); return; }
    inBreak = true;
    pollTick = 0;
    emitStatus();
    // Play is stopped during the break, so repeated polling would only
    // burn quota without changing the deck.
    sync({ force: true }).catch(() => {});
}

/** Clear break lifecycle state when returning to the game. */
function stopBreakPolling() {
    inBreak = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    emitStatus();
}

function isInBreak() { return inBreak; }

// ════════════════════════════════════════════════════════════════
//  Selection + status
// ════════════════════════════════════════════════════════════════

function selectFixture(id) {
    if (!validFixtureId(id)) return false;
    _sink.setLiveMatch({ selectedFixtureId: Math.trunc(Number(id)), manualOverride: false, snapshot: null });
    // Don't auto-sync here — the operator's "Sync" button (or entering
    // a break) drives the request, keeping quota under explicit control.
    emitStatus();
    return true;
}

function clearSelection() {
    _sink.setLiveMatch({ selectedFixtureId: null, manualOverride: false, snapshot: null });
    emitStatus();
}

function setRuntimeEnabled(on) {
    const enabled = !!on;
    _sink.setLiveMatch({ enabled });
    if (!enabled && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    } else if (enabled && inBreak && !pollTimer) {
        // Turning live data back on during a break captures one fresh
        // snapshot immediately; it does not start a timer.
        startBreakPolling();
        return;
    }
    emitStatus();
}

/** Clear the manual override and immediately apply the last snapshot. */
function resyncFromLive() {
    _sink.setLiveMatch({ manualOverride: false });
    _sink.applyLiveMatchSnapshot && _sink.applyLiveMatchSnapshot();
    emitStatus();
}

// ── write-back into break-state ──────────────────────────────────

function publishSnapshot(snapshot, meta) {
    _sink.setLiveMatch({
        snapshot,
        sync: {
            lastUpdated: _now(),
            lastAttempt: _now(),
            lastError: null,
            remaining: meta && meta.remaining != null ? meta.remaining : currentRemaining,
            source: meta && meta.source || null,
        },
    });
    // Apply to the displayed score/team/clock unless the operator has
    // taken manual control (see break-state manualOverride semantics).
    _sink.applyLiveMatchSnapshot && _sink.applyLiveMatchSnapshot();
}

let currentRemaining = null;
function noteRemaining(n) {
    if (n == null) return;
    currentRemaining = n;
    _sink.setLiveMatch({ sync: { remaining: n } });
    emitStatus();
}

function recordAttempt(reason, updatedMs) {
    // NOTE: we intentionally do NOT touch sync.remaining here. It is
    // set by publishSnapshot (on success) or noteRemaining (from a
    // list call) and must survive a later attempt — clobbering it
    // with a stale module-level cache would erase the real quota value.
    _sink.setLiveMatch({
        sync: {
            lastAttempt: _now(),
            lastError: reason || null,
            lastUpdated: updatedMs || (_sink.getLiveMatch && _sink.getLiveMatch() && _sink.getLiveMatch().sync && _sink.getLiveMatch().sync.lastUpdated) || null,
        },
    });
    emitStatus();
}

function statusWithReason(reason) {
    recordAttempt(reason, null);
    return getStatus();
}

/** Public, non-sensitive status for the operator UI. Never the key. */
function getStatus() {
    const lm = _sink.getLiveMatch ? _sink.getLiveMatch() : {};
    const sync = (lm && lm.sync) || {};
    return {
        available: isAvailable(),
        enabled: getEnabled(),
        hasKey: hasKey(),
        league: getLeague(),
        season: getSeason(),
        refreshMs: getRefreshMs(),
        inBreak: inBreak,
        polling: !!pollTimer,
        runtimeEnabled: !lm || lm.enabled !== false,
        selectedFixtureId: lm && validFixtureId(lm.selectedFixtureId) ? Math.trunc(Number(lm.selectedFixtureId)) : null,
        manualOverride: !!(lm && lm.manualOverride),
        hasSnapshot: !!(lm && lm.snapshot),
        lastUpdated: sync.lastUpdated || null,
        lastAttempt: sync.lastAttempt || null,
        lastError: sync.lastError || null,
        remaining: Number.isFinite(sync.remaining) ? sync.remaining : null,
        source: sync.source || null,
    };
}

function emitStatus() {
    if (typeof _onStatus === 'function') _onStatus(getStatus());
}
let _onStatus = null;
function onStatus(fn) { _onStatus = fn; }

// ════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════

function makeError(reason) { const e = new Error(reason); e.reason = reason; return e; }

function localDateString(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

function resetForTest() {
    // Test-only: clear all caches/timers so cases are independent.
    inflight.clear();
    listCache.clear();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    inBreak = false;
    pollTick = 0;
    currentRemaining = null;
}

module.exports = {
    configure,
    // lifecycle
    startBreakPolling, stopBreakPolling, isInBreak, onStatus,
    // selection + sync
    listFixtures, selectFixture, clearSelection, sync, setRuntimeEnabled, resyncFromLive,
    getStatus,
    // pure helpers (tested directly)
    parseStatValue, normalizeStatistics, normalizeFixture, normalizeFixtureListItem,
    normalizeLineups, normalizeEvents, normalizeTopPlayers,
    mapStatus, clockFromStatus, classifyError, shouldFetchStats,
    validFixtureId, validDate,
    resetForTest,
    // config readers
    isAvailable, getEnabled, hasKey, getLeague, getSeason, getRefreshMs,
};
