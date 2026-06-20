/**
 * weather-state.js — polls Open-Meteo (no API key, no signup) for the
 * stadium's local weather and pushes a normalised snapshot into
 * break-state via setWeather(). The beamer's "weather" slide renders
 * from that snapshot.
 *
 * Why Open-Meteo: hourly forecast granularity (the forecast strip),
 * standard WMO codes, real numeric values, and a pro-grade uptime
 * that wttr.in's single hobby server can't match. Swapping the source
 * later is a one-file change in parse().
 *
 * Polls every POLL_MS. On failure it logs and keeps the last good
 * snapshot (already persisted inside break-state.json); the slide
 * shows a "vor N min" staleness chip once it's >15 min old, so an
 * outage is graceful, not a blank slide.
 */

const breakState = require('./break-state');

const POLL_MS = 10 * 60 * 1000;     // 10 minutes
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

// ── WMO weather code → scene / icon ──────────────────────────────
// Standard Open-Meteo `weather_code` (WMO). The scene drives the
// slide's atmospheric background; the icon key picks an inline SVG.

function codeToScene(code, isDay) {
    if (code == null) return isDay ? 'clear-day' : 'clear-night';
    if (code <= 1) return isDay ? 'clear-day' : 'clear-night';
    if (code === 2) return isDay ? 'partly-day' : 'partly-night';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 67) return 'rain';        // drizzle + rain + freezing
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'rain';        // rain showers
    if (code >= 85 && code <= 86) return 'snow';        // snow showers
    if (code >= 95) return 'thunder';
    return 'cloudy';
}

const SCENE_LABELS = {
    'clear-day': 'Klar',
    'clear-night': 'Klar',
    'partly-day': 'Teils bewölkt',
    'partly-night': 'Teils bewölkt',
    'cloudy': 'Bewölkt',
    'fog': 'Nebel',
    'rain': 'Regen',
    'snow': 'Schnee',
    'thunder': 'Gewitter',
};

// 16-point compass, German (O = Ost, not E). Open-Meteo gives degrees.
function degToCompass(deg) {
    if (deg == null || !isFinite(deg)) return '';
    const dirs = ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

// ── fetch + parse ────────────────────────────────────────────────

async function fetchWeather(lat, lon) {
    const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,uv_index,is_day',
        hourly: 'temperature_2m,weather_code',
        forecast_hours: '8',
        daily: 'temperature_2m_max,temperature_2m_min',
        forecast_days: '1',
        timezone: 'auto',
    });
    const res = await fetch(ENDPOINT + '?' + params.toString());
    if (!res.ok) throw new Error('Open-Meteo HTTP ' + res.status);
    return res.json();
}

function parse(data, locationLabel) {
    const c = data.current || {};
    const code = c.weather_code;
    const isDay = c.is_day !== 0;
    const scene = codeToScene(code, isDay);

    const hourly = [];
    if (data.hourly && Array.isArray(data.hourly.time)) {
        const n = Math.min(6, data.hourly.time.length);
        for (let i = 0; i < n; i++) {
            hourly.push({
                time: data.hourly.time[i],
                temp: data.hourly.temperature_2m[i],
                code: data.hourly.weather_code[i],
            });
        }
    }

    const daily = data.daily || {};
    const high = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
    const low = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;

    return {
        temp: c.temperature_2m,
        feelsLike: c.apparent_temperature,
        code,
        label: SCENE_LABELS[scene] || '',
        wind: c.wind_speed_10m,
        windDir: degToCompass(c.wind_direction_10m),
        humidity: c.relative_humidity_2m,
        uv: c.uv_index,
        high,
        low,
        hourly,
        scene,
        isDay,
        location: locationLabel || '',
        updatedAt: Date.now(),
    };
}

// ── lifecycle ────────────────────────────────────────────────────

let timer = null;
let warnedNoCoords = false;

function start(opts) {
    opts = opts || {};
    if (timer) return;   // already running; call stop() first to restart
    const lat = parseFloat(opts.lat);
    const lon = parseFloat(opts.lon);
    const logger = opts.logger || (() => {});
    const locationLabel = opts.location || '';

    if (!isFinite(lat) || !isFinite(lon)) {
        if (!warnedNoCoords) {
            warnedNoCoords = true;
            logger('STADIUM_LAT/LON not set — weather slide will show no data (set them in Settings)');
        }
        return;
    }
    warnedNoCoords = false;
    logger('Polling Open-Meteo for ' + (locationLabel || (lat + ',' + lon)) + ' every ' + (POLL_MS / 60000) + ' min');

    const poll = async () => {
        try {
            const data = await fetchWeather(lat, lon);
            const parsed = parse(data, locationLabel);
            breakState.setWeather(parsed);
            logger('Weather: ' + parsed.label + ' ' + (parsed.temp != null ? parsed.temp.toFixed(0) + '°' : '—') + ' (' + parsed.scene + ')');
        } catch (e) {
            logger('Weather fetch failed: ' + (e && e.message ? e.message : e));
        }
    };
    poll();                       // immediate first fetch
    timer = setInterval(poll, POLL_MS);
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

/** Restart with (possibly) new options — used by the config hot-reload. */
function restart(opts) { stop(); start(opts); }

module.exports = { start, stop, restart };
