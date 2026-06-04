const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, `server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Synchronous crash write — ensures log is flushed even if process is dying
function writeSync(line) {
    try { fs.appendFileSync(LOG_FILE, line); } catch {}
    try { process.stderr.write(line); } catch {}
}

function timestamp() {
    return new Date().toISOString();
}

function write(level, ...args) {
    const msg = args.map(a => {
        if (a instanceof Error) {
            return a.stack || a.message;
        }
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
    }).join(' ');

    const line = `[${timestamp()}] [${level}] ${msg}\n`;

    // Always write to file
    logStream.write(line);

    // Also write to console (ignore EPIPE if stdout/stderr is closed)
    try {
        if (level === 'ERROR') {
            process.stderr.write(line);
        } else {
            process.stdout.write(line);
        }
    } catch (e) {
        // EPIPE — stdout/stderr closed (e.g. parent process killed), don't crash
    }
}

function info(...args)  { write('INFO', ...args); }
function warn(...args)  { write('WARN', ...args); }
function error(...args) { write('ERROR', ...args); }
function debug(...args) { write('DEBUG', ...args); }

// Log uncaught exceptions to file before crashing
function setupCrashHandlers() {
    process.on('uncaughtException', err => {
        writeSync(`[${timestamp()}] [FATAL] Uncaught exception: ${err.stack || err}\n`);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        writeSync(`[${timestamp()}] [FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}\nPromise: ${promise}\n`);
        process.exit(1);
    });

    // Track clean exits — helps distinguish "crashed" from "just stopped"
    process.on('exit', code => {
        writeSync(`[${timestamp()}] [INFO] Process exiting with code ${code}\n`);
    });

    // Track signals (Ctrl+C, task kill, etc.)
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            writeSync(`[${timestamp()}] [INFO] Received ${sig}\n`);
            process.exit(0);
        });
    }
}

module.exports = { info, warn, error, debug, setupCrashHandlers, LOG_FILE };
