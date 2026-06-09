/**
 * Shared dB ↔ scalar conversions.
 *
 * The UI and the Voicemeeter contract use dB in the range -60 .. +12.
 * native-sound-mixer (and the Windows Core Audio API in general) use a
 * 0..1 scalar volume.
 *
 * Mapping: -60 dB → 0,  0 dB → 0.833,  +12 dB → 1.0
 * This is a linear mapping across the 72 dB range, so 0 dB is the
 * perceptual midpoint and "+12 dB" stays a true headroom boost.
 */

const DB_MIN = -60;
const DB_MAX = 12;
const DB_RANGE = DB_MAX - DB_MIN; // 72

function dbToScalar(db) {
    if (db <= DB_MIN) return 0;
    if (db >= DB_MAX) return 1;
    return (db - DB_MIN) / DB_RANGE;
}

function scalarToDb(s) {
    if (s <= 0) return DB_MIN;
    if (s >= 1) return DB_MAX;
    return DB_MIN + s * DB_RANGE;
}

module.exports = { DB_MIN, DB_MAX, dbToScalar, scalarToDb };
