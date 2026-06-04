// Wrapper that auto-restarts the server on crash and logs exit codes
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const crashLog = path.join(LOG_DIR, 'crash-monitor.log');

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(crashLog, line);
    process.stdout.write(line);
}

let restartCount = 0;
const MAX_RESTARTS = 20; // prevent infinite restart loops

function startServer() {
    if (restartCount >= MAX_RESTARTS) {
        log(`FATAL: Exceeded ${MAX_RESTARTS} restarts. Stopping.`);
        process.exit(1);
    }

    restartCount++;
    log(`Starting server (attempt ${restartCount})...`);

    const runtime = process.argv[2] || 'node';
    const child = spawn(runtime, [path.join(__dirname, 'server.js')], {
        stdio: 'inherit',
        env: process.env
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            log(`Server killed by signal: ${signal} (exit code null)`);
        } else {
            log(`Server exited with code: ${code}`);
        }

        if (code === 0) {
            log('Clean exit — not restarting.');
            process.exit(0);
        }

        // Non-zero exit: wait 3 seconds then restart
        log('Restarting in 3 seconds...');
        setTimeout(startServer, 3000);
    });

    child.on('error', err => {
        log(`Failed to start server: ${err.message}`);
        process.exit(1);
    });
}

startServer();
