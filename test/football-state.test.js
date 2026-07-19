// Deterministic tests for football-state.js. HTTP is mocked — the real
// API is never contacted. Covers normalisation, null/partial stats,
// status mapping, caching/dedup, disabled/missing-key behaviour,
// stale-data handling, quota surfacing, and break-refresh gating.

const assert = require('node:assert/strict');
const test = require('node:test');
const football = require('../football-state');

// ── helpers ───────────────────────────────────────────────────────

const DEFAULT_LM = {
    enabled: true,
    selectedFixtureId: null,
    manualOverride: false,
    snapshot: null,
    sync: { lastUpdated: null, lastAttempt: null, lastError: null, remaining: null, source: null },
};

// A minimal in-memory sink that mirrors break-state's liveMatch write
// semantics (merge + apply-to-displayed-unless-override), so we can
// assert on what the operator/audience would actually see.
function makeSink(initial) {
    const s = {
        home: { name: '', score: 0 },
        away: { name: '', score: 0 },
        matchClock: { label: 'HT', display: '' },
        liveMatch: JSON.parse(JSON.stringify(initial || DEFAULT_LM)),
    };
    return {
        _s: s,
        getLiveMatch() { return JSON.parse(JSON.stringify(s.liveMatch)); },
        setLiveMatch(patch) {
            const lm = s.liveMatch;
            if (!patch) return;
            if (typeof patch.enabled === 'boolean') lm.enabled = patch.enabled;
            if (patch.selectedFixtureId === null || Number.isInteger(patch.selectedFixtureId)) lm.selectedFixtureId = patch.selectedFixtureId;
            if (typeof patch.manualOverride === 'boolean') lm.manualOverride = patch.manualOverride;
            if (patch.snapshot === null) lm.snapshot = null;
            else if (patch.snapshot && typeof patch.snapshot === 'object') lm.snapshot = JSON.parse(JSON.stringify(patch.snapshot));
            if (patch.sync && typeof patch.sync === 'object') {
                const o = lm.sync, n = patch.sync;
                if (n.lastUpdated === null || Number.isFinite(n.lastUpdated)) o.lastUpdated = n.lastUpdated;
                if (n.lastAttempt === null || Number.isFinite(n.lastAttempt)) o.lastAttempt = n.lastAttempt;
                if (n.lastError === null || typeof n.lastError === 'string') o.lastError = n.lastError;
                if (n.remaining === null || Number.isFinite(n.remaining)) o.remaining = n.remaining;
                if (n.source === null || typeof n.source === 'string') o.source = n.source;
            }
        },
        applyLiveMatchSnapshot() {
            const lm = s.liveMatch;
            if (!lm || lm.manualOverride || !lm.snapshot) return;
            const snap = lm.snapshot;
            if (snap.home && typeof snap.home.name === 'string') s.home.name = snap.home.name;
            if (snap.away && typeof snap.away.name === 'string') s.away.name = snap.away.name;
            if (snap.home && Number.isFinite(snap.home.score)) s.home.score = snap.home.score;
            if (snap.away && Number.isFinite(snap.away.score)) s.away.score = snap.away.score;
            if (snap.clock && typeof snap.clock.label === 'string') s.matchClock.label = snap.clock.label;
            if (snap.clock && typeof snap.clock.display === 'string') s.matchClock.display = snap.clock.display;
        },
    };
}

// Build a mock fetch that dispatches by URL substring → handler.
// Disambiguation: the fixture URL is `…/fixtures?id=` while the
// statistics URL is `…/fixtures/statistics?fixture=`. A route whose match
// mentions `/statistics` only matches statistics calls; a fixture
// route only matches when `/statistics` is absent. This keeps the
// per-test route tables short and unambiguous.
function mockFetch(routes) {
    const calls = [];
    const fn = async (url) => {
        calls.push(String(url));
        const isStats = typeof url === 'string' && url.includes('/statistics');
        for (const route of routes) {
            const routeIsStats = route.match.includes('/statistics');
            if (isStats !== routeIsStats) continue;
            if (typeof url === 'string' && url.includes(route.match)) {
                const body = typeof route.body === 'function' ? route.body(url) : route.body;
                const ok = route.ok !== false;
                return {
                    ok,
                    status: route.status || (ok ? 200 : 500),
                    headers: { get: (h) => (route.headers && route.headers[h.toLowerCase()]) || null },
                    json: async () => body,
                };
            }
        }
        throw new Error('mock: no route for ' + url);
    };
    fn.calls = calls;
    return fn;
}

function fixtureDetailBody(opts) {
    opts = opts || {};
    return {
        response: [{
            fixture: {
                id: 9001,
                timestamp: opts.timestamp != null ? opts.timestamp : 1750000000,
                status: opts.status || { short: '2H', elapsed: 67 },
            },
            teams: { home: { name: 'Germany' }, away: { name: 'Brazil' } },
            goals: { home: opts.homeScore != null ? opts.homeScore : 2, away: opts.awayScore != null ? opts.awayScore : 1 },
            league: { id: 1, name: 'World Cup' },
        }],
    };
}

function statisticsBody() {
    return {
        response: [
            { team: { id: 1 }, statistics: [
                { type: 'Ball Possession', value: '56%' },
                { type: 'Shots on Goal', value: 5 },
                { type: 'Shots off Goal', value: 4 },
                { type: 'Blocked Shots', value: 3 },
                { type: 'Shots insidebox', value: 8 },
                { type: 'Shots outsidebox', value: 4 },
                { type: 'Total Shots', value: 12 },
                { type: 'Corner Kicks', value: 6 },
                { type: 'Fouls', value: 9 },
                { type: 'Yellow Cards', value: 2 },
                { type: 'Red Cards', value: null },
                { type: 'Total passes', value: 480 },
                { type: 'Passes accurate', value: 408 },
                { type: 'Passes %', value: '85%' },
            ]},
            { team: { id: 2 }, statistics: [
                { type: 'Ball Possession', value: '44%' },
                { type: 'Shots on Goal', value: 3 },
                { type: 'Shots off Goal', value: 3 },
                { type: 'Blocked Shots', value: 2 },
                { type: 'Shots insidebox', value: 5 },
                { type: 'Shots outsidebox', value: 3 },
                { type: 'Total Shots', value: 8 },
                { type: 'Corner Kicks', value: 4 },
                { type: 'Fouls', value: null },
                { type: 'Yellow Cards', value: 3 },
                { type: 'Red Cards', value: 1 },
                { type: 'Total passes', value: 377 },
                { type: 'Passes accurate', value: 298 },
            ]},
        ],
    };
}

function setup(opts) {
    const sink = makeSink(opts && opts.sink);
    const fetchImpl = opts && opts.fetchImpl;
    football.configure({
        fetchImpl,
        sink,
        env: opts && opts.env != null ? opts.env : { API_FOOTBALL_KEY: 'test-key', API_FOOTBALL_ENABLED: 'true' },
        now: opts && opts.now,
        log: () => {},
    });
    football.resetForTest();
    return { sink, fetchImpl };
}

// ── pure value normalisation ──────────────────────────────────────

test('parseStatValue handles percent, number, null, empty', () => {
    assert.equal(football.parseStatValue('56%'), 56);
    assert.equal(football.parseStatValue(12), 12);
    assert.equal(football.parseStatValue('12'), 12);
    assert.equal(football.parseStatValue(null), null);
    assert.equal(football.parseStatValue(undefined), null);
    assert.equal(football.parseStatValue(''), null);
    assert.equal(football.parseStatValue('null'), null);
    assert.equal(football.parseStatValue('abc'), null);
    assert.equal(football.parseStatValue(NaN), null);
});

test('normalizeStatistics maps both teams and tolerates null/unknown', () => {
    const out = football.normalizeStatistics(statisticsBody());
    assert.deepEqual(out.possession, { home: 56, away: 44 });
    assert.deepEqual(out.shotsOnTarget, { home: 5, away: 3 });
    assert.deepEqual(out.shotsOffTarget, { home: 4, away: 3 });
    assert.deepEqual(out.shotsBlocked, { home: 3, away: 2 });
    assert.deepEqual(out.shotsInsideBox, { home: 8, away: 5 });
    assert.deepEqual(out.shotsOutsideBox, { home: 4, away: 3 });
    assert.deepEqual(out.shotsTotal, { home: 12, away: 8 });
    assert.deepEqual(out.corners, { home: 6, away: 4 });
    assert.deepEqual(out.fouls, { home: 9, away: null });   // away foul missing
    assert.deepEqual(out.redCards, { home: null, away: 1 });
    assert.deepEqual(out.yellowCards, { home: 2, away: 3 });
    assert.deepEqual(out.passesPct, { home: 85, away: null });
    assert.deepEqual(out.passes, { home: 480, away: 377 });
    assert.deepEqual(out.passesAccurate, { home: 408, away: 298 });
    // Every canonical key exists, even if entirely absent from the payload
    assert.deepEqual(out.offsides, { home: null, away: null });
    assert.deepEqual(out.saves, { home: null, away: null });
});

test('normalizeStatistics handles empty / missing arrays', () => {
    assert.deepEqual(football.normalizeStatistics(null).possession, { home: null, away: null });
    assert.deepEqual(football.normalizeStatistics({ response: [] }).possession, { home: null, away: null });
});

// ── status / clock mapping ────────────────────────────────────────

test('mapStatus classifies live, finished, and labels', () => {
    assert.equal(football.mapStatus({ short: '2H', elapsed: 67 }).live, true);
    assert.equal(football.mapStatus({ short: '2H', elapsed: 67 }).finished, false);
    assert.equal(football.mapStatus({ short: '2H', elapsed: 67 }).elapsed, 67);
    assert.equal(football.mapStatus({ short: 'FT' }).finished, true);
    assert.equal(football.mapStatus({ short: 'HT' }).live, true);
    assert.equal(football.mapStatus({ short: 'NS' }).live, false);
    assert.equal(football.mapStatus({ short: 'PEN' }).finished, true);
    assert.equal(football.mapStatus({ short: 'PEN' }).label, 'nach Elfmeter');
    assert.equal(football.mapStatus({ short: 'NS' }).label, 'vor Anpfiff');
    assert.equal(football.mapStatus({}).code, null);
});

test('clockFromStatus produces compact match-clock fields', () => {
    assert.deepEqual(football.clockFromStatus({ short: '2H', elapsed: 67 }), { label: '2H', display: "67'" });
    assert.deepEqual(football.clockFromStatus({ short: 'HT' }), { label: 'HT', display: 'Halbzeit' });
    const ft = football.clockFromStatus({ short: 'FT' });
    assert.equal(ft.label, 'FT');
    const ns = football.clockFromStatus({ short: 'NS' });
    assert.equal(ns.label, 'KO');
});

test('normalizeFixture maps teams, score, status, clock', () => {
    football.configure({ env: { API_FOOTBALL_KEY: 'k' }, now: () => 1000, log: () => {}, sink: makeSink() });
    // normalizeFixture takes the inner entry object (the same object
    // sync() extracts as data.response[0]), not the { response:[…] } wrapper.
    const snap = football.normalizeFixture(fixtureDetailBody().response[0], statisticsBody());
    assert.equal(snap.home.name, 'Germany');
    assert.equal(snap.away.name, 'Brazil');
    assert.equal(snap.home.score, 2);
    assert.equal(snap.away.score, 1);
    assert.equal(snap.status.short, '2H');
    assert.equal(snap.clock.display, "67'");
    assert.equal(snap.competition, 'World Cup');
    assert.equal(snap.stats.possession.home, 56);
    assert.equal(snap.updatedAt, 1000);
    assert.equal(snap.fixtureId, 9001);
});

test('normalizeFixture maps embedded lineups, events, and top performers without provider objects', () => {
    football.configure({ env: { API_FOOTBALL_KEY: 'k' }, now: () => 1000, log: () => {}, sink: makeSink() });
    const entry = fixtureDetailBody().response[0];
    entry.teams.home.id = 1; entry.teams.away.id = 2;
    entry.lineups = [
        { team: { id: 1, name: 'Germany' }, formation: '4-2-3-1', coach: { name: 'Coach H' }, startXI: [
            { player: { id: 99, name: 'M. Keeper', number: 1, pos: 'G', grid: '1:1', photo: 'secret-url' } },
            { player: { id: 98, name: 'A. Defender', number: 4, pos: 'D', grid: '2:1' } },
        ], substitutes: [{ player: { id: 90, name: 'B. Bench', number: 12, pos: 'G' } }] },
        { team: { id: 2, name: 'Brazil' }, formation: '4-3-3', coach: { name: 'Coach A' }, startXI: [], substitutes: [] },
    ];
    entry.events = [
        { time: { elapsed: 12, extra: null }, team: { id: 1 }, player: { id: 10, name: 'T. Scorer' }, assist: { id: 11, name: 'A. Assist' }, type: 'Goal', detail: 'Normal Goal' },
        { time: { elapsed: 30 }, team: { id: 2 }, player: { name: 'D. Carded' }, type: 'Card', detail: 'Yellow Card' },
    ];
    entry.players = [
        { team: { id: 1 }, players: [{ player: { id: 10, name: 'T. Scorer', photo: 'secret-url' }, statistics: [{ games: { number: 9, position: 'Attacker', rating: '8.4', minutes: 90 }, goals: { total: 1, assists: 0 }, shots: { total: 4, on: 2 }, passes: { key: 2 }, tackles: { total: 1, interceptions: 0 }, duels: { won: 5 } }] }] },
        { team: { id: 2 }, players: [{ player: { id: 20, name: 'A. Keeper' }, statistics: [{ games: { number: 1, position: 'Goalkeeper', rating: '7.7', minutes: 90 }, goals: { total: 0, assists: 0, saves: 5 } }] }] },
    ];
    entry.statistics = statisticsBody().response;
    const snap = football.normalizeFixture(entry);
    assert.equal(snap.lineups.home.formation, '4-2-3-1');
    assert.equal(snap.lineups.home.startXI[0].name, 'M. Keeper');
    assert.equal(snap.lineups.home.startXI[0].grid, '1:1');
    assert.equal(snap.lineups.home.startXI[0].id, undefined);
    assert.equal(snap.events[0].minute, 12);
    assert.equal(snap.events[0].player, 'T. Scorer');
    assert.equal(snap.events[0].id, undefined);
    assert.equal(snap.topPlayers[0].name, 'T. Scorer');
    assert.equal(snap.topPlayers[0].rating, 8.4);
    assert.equal(snap.topPlayers[0].photo, undefined);
    assert.equal(snap.stats.possession.home, 56);
});

test('sync uses embedded statistics and rich fixture data without a second request', async () => {
    const body = fixtureDetailBody();
    body.response[0].statistics = statisticsBody().response;
    body.response[0].events = [];
    body.response[0].lineups = [];
    body.response[0].players = [];
    const fetchImpl = mockFetch([{ match: '/fixtures?id=9001', body }]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync({ force: true });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(status.source, 'fixture+embedded');
    assert.equal(sink.getLiveMatch().snapshot.stats.possession.home, 56);
});

test('normalizeFixture is robust to null goals', () => {
    football.configure({ env: { API_FOOTBALL_KEY: 'k' }, now: () => 1, log: () => {}, sink: makeSink() });
    const snap = football.normalizeFixture({
        fixture: { id: 1, timestamp: 1, status: { short: 'NS' } },
        teams: { home: {}, away: {} },
        goals: { home: null, away: null },
    });
    assert.equal(snap.home.score, 0);
    assert.equal(snap.away.score, 0);
    assert.equal(snap.home.name, 'Heim');
});

// ── error classification ──────────────────────────────────────────

test('classifyError maps timeout / network / http status', () => {
    assert.equal(football.classifyError({ name: 'TimeoutError' }), 'timeout');
    assert.equal(football.classifyError({ name: 'AbortError' }), 'timeout');
    assert.equal(football.classifyError({ code: 'ENOTFOUND' }), 'network');
    assert.equal(football.classifyError(null, 401), 'auth');
    assert.equal(football.classifyError(null, 429), 'rate-limit');
    assert.equal(football.classifyError(null, 500), 'http-500');
    assert.equal(football.classifyError({ message: 'x' }), 'network');
    assert.equal(football.classifyError(), null);
});

// ── refresh gating ────────────────────────────────────────────────

test('shouldFetchStats permits only explicit or activation refreshes', () => {
    football.configure({ env: { API_FOOTBALL_KEY: 'k' }, log: () => {}, sink: makeSink() });
    football.resetForTest();
    assert.equal(football.shouldFetchStats(true), true);
    assert.equal(football.shouldFetchStats(false), false);
});

test('validFixtureId and validDate guard inputs', () => {
    assert.equal(football.validFixtureId(9001), true);
    assert.equal(football.validFixtureId(0), false);
    assert.equal(football.validFixtureId(-5), false);
    assert.equal(football.validFixtureId('9001'), true);
    assert.equal(football.validFixtureId('abc'), false);
    assert.equal(football.validFixtureId(2147483648), false);   // > int31
    assert.equal(football.validDate('2026-06-12'), true);
    assert.equal(football.validDate('2026-6-12'), false);
    assert.equal(football.validDate('2026-02-31'), false);
    assert.equal(football.validDate('not-a-date'), false);
    assert.equal(football.validDate(123), false);
});

// ── disabled / missing-key / no-fixture guards make zero calls ────

test('sync does nothing when disabled', async () => {
    let called = false;
    const { sink } = setup({
        env: { API_FOOTBALL_KEY: 'k', API_FOOTBALL_ENABLED: 'false' },
        fetchImpl: async () => { called = true; },
    });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync();
    assert.equal(called, false);
    assert.equal(status.lastError, 'disabled');
    assert.equal(status.available, false);
});

test('sync and fixture discovery do nothing when runtime-disabled', async () => {
    let called = false;
    const { sink } = setup({ fetchImpl: async () => { called = true; } });
    sink.setLiveMatch({ selectedFixtureId: 9001, enabled: false });
    const status = await football.sync();
    assert.equal(called, false);
    assert.equal(status.lastError, 'disabled');
    await assert.rejects(football.listFixtures('2026-06-12'), e => e.reason === 'disabled');
    assert.equal(called, false);
});

test('sync does nothing without a key', async () => {
    let called = false;
    const { sink } = setup({
        env: { API_FOOTBALL_ENABLED: 'true' },
        fetchImpl: async () => { called = true; },
    });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync();
    assert.equal(called, false);
    assert.equal(status.lastError, 'no-key');
    assert.equal(status.hasKey, false);
});

test('sync does nothing with no selected fixture', async () => {
    let called = false;
    setup({ fetchImpl: async () => { called = true; } });
    const status = await football.sync();
    assert.equal(called, false);
    assert.equal(status.lastError, 'no-fixture');
});

// ── successful sync ───────────────────────────────────────────────

test('sync publishes snapshot and applies score when not overridden', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody() },
        { match: '/fixtures/statistics?fixture=9001', body: statisticsBody() },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });

    const status = await football.sync({ force: true });
    assert.equal(fetchImpl.calls.length, 2);          // fixture + statistics
    assert.equal(status.lastError, null);
    assert.equal(status.source, 'fixture+statistics');
    const lm = sink.getLiveMatch();
    assert.equal(lm.snapshot.home.score, 2);
    assert.equal(lm.snapshot.away.score, 1);
    assert.equal(lm.snapshot.stats.possession.home, 56);
    // Applied to the displayed score (no override)
    assert.equal(sink._s.home.score, 2);
    assert.equal(sink._s.away.score, 1);
    assert.equal(sink._s.home.name, 'Germany');
    assert.equal(sink._s.matchClock.label, '2H');
});

test('sync with force=false uses fixture payload without statistics fallback', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody() },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    await football.sync({ force: false });
    assert.equal(fetchImpl.calls.length, 1);
});

// ── stale-data + partial-failure behaviour ────────────────────────

test('fixture fetch failure keeps last snapshot and records error', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', status: 500, ok: false, body: {} },
    ]);
    // Pre-seed a good snapshot + displayed score so we can prove it survives.
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({
        selectedFixtureId: 9001,
        snapshot: { home: { name: 'Germany', score: 2 }, away: { name: 'Brazil', score: 1 }, clock: { label: '2H', display: "10'" }, stats: {} },
    });
    sink._s.home.score = 2;
    const status = await football.sync({ force: true });
    assert.equal(status.lastError, 'http-500');
    // The valid manual/previously-synced score must survive untouched
    assert.equal(sink._s.home.score, 2);
    assert.equal(sink.getLiveMatch().snapshot.home.score, 2);
});

test('statistics failure keeps the fixture data (stats are nice-to-have)', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody() },
        { match: '/fixtures/statistics', status: 500, ok: false, body: {} },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync({ force: true });
    assert.equal(status.lastError, null);              // overall sync succeeded
    assert.equal(status.source, 'fixture');
    assert.equal(sink.getLiveMatch().snapshot.home.score, 2);
    assert.equal(sink._s.home.name, 'Germany');
});

test('provider plan restriction is classified without exposing raw errors', async () => {
    const fetchImpl = mockFetch([
        { match: 'date=2026-06-12', body: { errors: { plan: 'Free plans do not have access to this season' }, response: [] } },
    ]);
    setup({ fetchImpl });
    await assert.rejects(football.listFixtures('2026-06-12'), e => {
        assert.equal(e.reason, 'plan-access');
        assert.equal(e.message, 'plan-access');
        return true;
    });
});

test('timeout is classified and never crashes the show', async () => {
    const fetchImpl = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync({ force: true });
    assert.equal(status.lastError, 'timeout');
});

// ── manual override precedence ────────────────────────────────────

test('manual override blocks live score from overwriting displayed values', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody({ homeScore: 2, awayScore: 1 }) },
        { match: '/fixtures/statistics', body: statisticsBody() },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001, manualOverride: true });
    sink._s.home.score = 9;   // operator's hand-typed value
    sink._s.home.name = 'MY TEAM';
    await football.sync({ force: true });
    assert.equal(sink._s.home.score, 9);              // untouched
    assert.equal(sink._s.home.name, 'MY TEAM');
    // ...but the snapshot still landed for the stats slide
    assert.equal(sink.getLiveMatch().snapshot.home.score, 2);
});

// ── quota surfacing ───────────────────────────────────────────────

test('remaining quota is surfaced from the account body when present', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: Object.assign({ account: { remaining_requests: 42 } }, fixtureDetailBody()) },
        { match: '/fixtures/statistics', body: statisticsBody() },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync({ force: true });
    assert.equal(status.remaining, 42);
});

test('remaining quota is surfaced from documented rate-limit headers', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody(), headers: { 'x-ratelimit-requests-remaining': '7' } },
        { match: '/fixtures/statistics', body: statisticsBody() },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync({ force: true });
    assert.equal(status.remaining, 7);
});

test('remaining quota is null when no metadata is exposed', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody() },
        { match: '/fixtures/statistics', body: statisticsBody() },
    ]);
    const { sink } = setup({ fetchImpl });
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    const status = await football.sync({ force: true });
    assert.equal(status.remaining, null);
});

// ── caching / dedup ───────────────────────────────────────────────

test('listFixtures caches by date and dedupes concurrent calls', async () => {
    let n = 0;
    const fetchImpl = mockFetch([
        { match: 'date=2026-06-12', body: () => { n++; return { response: [{ fixture: { id: 1, timestamp: 1, status: { short: 'NS' } }, teams: { home: { name: 'A' }, away: { name: 'B' } }, goals: {} }] }; } },
    ]);
    setup({ fetchImpl });
    const [a, b] = await Promise.all([football.listFixtures('2026-06-12'), football.listFixtures('2026-06-12')]);
    assert.equal(n, 1);                                 // one network call for both
    assert.equal(a.fixtures.length, 1);
    assert.deepEqual(a.date, b.date);
    // A third call within the TTL hits the cache, no extra call
    await football.listFixtures('2026-06-12');
    assert.equal(n, 1);
});

test('listFixtures falls back to date-only feed on plan restriction and filters league/season', async () => {
    const fetchImpl = mockFetch([
        { match: 'league=1&season=2026&date=2026-07-18', body: { errors: { plan: 'Free plan season access restriction' }, response: [] } },
        { match: '/fixtures?date=2026-07-18', body: { errors: [], response: [
            { fixture: { id: 1591865, timestamp: 1784408400, status: { short: 'NS' } }, league: { id: 1, season: 2026 }, teams: { home: { name: 'France' }, away: { name: 'England' } }, goals: {} },
            { fixture: { id: 2, timestamp: 1784408400, status: { short: 'NS' } }, league: { id: 10, season: 2026 }, teams: { home: { name: 'Other' }, away: { name: 'Match' } }, goals: {} },
            { fixture: { id: 3, timestamp: 1784408400, status: { short: 'NS' } }, league: { id: 1, season: 2022 }, teams: { home: { name: 'Old' }, away: { name: 'World Cup' } }, goals: {} },
        ] } },
    ]);
    setup({ fetchImpl, env: { API_FOOTBALL_KEY: 'k', API_FOOTBALL_ENABLED: 'true', API_FOOTBALL_LEAGUE: '1', API_FOOTBALL_SEASON: '2026' } });
    const result = await football.listFixtures('2026-07-18');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(result.fallback, true);
    assert.deepEqual(result.fixtures.map(f => f.fixtureId), [1591865]);
});

test('listFixtures defaults an omitted date but rejects malformed input', async () => {
    const fetchImpl = mockFetch([
        { match: 'date=2026-06-12', body: { response: [] } },
    ]);
    setup({ fetchImpl, now: () => Date.UTC(2026, 5, 12) });
    const res = await football.listFixtures();
    assert.equal(res.date, '2026-06-12');
    assert.equal(fetchImpl.calls.length, 1);
    await assert.rejects(football.listFixtures('garbage'), e => e.reason === 'invalid-date');
    assert.equal(fetchImpl.calls.length, 1);
});

// ── break-lifecycle gating ────────────────────────────────────────

test('break activation performs one sync and starts no recurring timer', async () => {
    const fetchImpl = mockFetch([
        { match: '/fixtures?id=9001', body: fixtureDetailBody() },
        { match: '/fixtures/statistics', body: statisticsBody() },
    ]);
    const { sink } = setup({ fetchImpl, env: { API_FOOTBALL_KEY: 'k', API_FOOTBALL_REFRESH_MS: '30000' } });
    assert.equal(football.getRefreshMs(), 60000);
    sink.setLiveMatch({ selectedFixtureId: 9001 });
    football.startBreakPolling();
    assert.equal(football.isInBreak(), true);
    // Give the immediate sync a tick to resolve
    await new Promise(r => setTimeout(r, 20));
    assert.equal(fetchImpl.calls.length, 2); // fixture + stats fallback, once
    const afterStop = football.getStatus();
    assert.equal(afterStop.polling, false);
    football.stopBreakPolling();
    assert.equal(football.isInBreak(), false);
    assert.equal(afterStop.inBreak, true);
});

test('stopBreakPolling without a start is a safe no-op', () => {
    setup({});
    football.stopBreakPolling();
    assert.equal(football.isInBreak(), false);
});

// restore process.env-based defaults after the suite so other modules
// loaded later (if any) aren't surprised by the injected test env.
test('teardown: reconfigure from process.env', () => {
    football.configure({ env: process.env, log: () => {} });
    football.resetForTest();
    assert.ok(true);
});
