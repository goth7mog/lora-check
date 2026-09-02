#!/usr/bin/env node

const { spawn } = require('node:child_process');

const defaults = {
    frequency: 868.1e6,
    sampleRate: 2e6,
    lnaGain: 16,
    vgaGain: 20,
    calibrationSeconds: 2,
    durationSeconds: 30,
    thresholdDb: 8,
    windowMs: 100,
};

function usage() {
    console.log(`Usage: node lora-check.js [options]

Options:
  --frequency <Hz>       LoRa center frequency (default: ${defaults.frequency})
  --sample-rate <Hz>     HackRF sample rate (default: ${defaults.sampleRate})
  --lna-gain <dB>        LNA gain, 0-40 in 8 dB steps (default: ${defaults.lnaGain})
  --vga-gain <dB>        VGA gain, 0-62 in 2 dB steps (default: ${defaults.vgaGain})
  --calibration <sec>    Noise calibration time (default: ${defaults.calibrationSeconds})
    --duration <sec>       Capture time after calibration (default: ${defaults.durationSeconds})
    --threshold <dB>       Activity threshold above noise floor (default: ${defaults.thresholdDb})
    --hackrf <path>        Path to hackrf_transfer (default: hackrf_transfer)
  --help                 Show this help

Example:
  node lora-check.js --frequency 915000000 --duration 60
`);
}

function parseArgs(argv) {
    const options = { ...defaults };
    const names = {
        '--frequency': 'frequency',
        '--sample-rate': 'sampleRate',
        '--lna-gain': 'lnaGain',
        '--vga-gain': 'vgaGain',
        '--calibration': 'calibrationSeconds',
        '--duration': 'durationSeconds',
        '--threshold': 'thresholdDb',
        '--hackrf': 'hackrfPath',
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help') {
            usage();
            process.exit(0);
        }
        const name = names[argument];
        if (!name || index + 1 >= argv.length) {
            throw new Error(`Unknown or incomplete option: ${argument}`);
        }
        const value = argv[++index];
        if (name === 'hackrfPath') {
            if (!value) throw new Error(`Invalid value for ${argument}`);
            options[name] = value;
            continue;
        }
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            throw new Error(`Invalid value for ${argument}`);
        }
        options[name] = numericValue;
    }
    return options;
}

function formatFrequency(hz) {
    return hz >= 1e9 ? `${(hz / 1e9).toFixed(3)} GHz` : `${(hz / 1e6).toFixed(3)} MHz`;
}

function startCapture(options) {
    const totalSeconds = options.calibrationSeconds + options.durationSeconds;
    const args = [
        '-r', '-',
        '-f', String(Math.round(options.frequency)),
        '-s', String(Math.round(options.sampleRate)),
        '-l', String(Math.round(options.lnaGain)),
        '-g', String(Math.round(options.vgaGain)),
        '-n', String(Math.round(options.sampleRate * totalSeconds)),
    ];
    return spawn(options.hackrfPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`Error: ${error.message}`);
        usage();
        process.exitCode = 2;
        return;
    }

    options.hackrfPath = options.hackrfPath || 'hackrf_transfer';

    const capture = startCapture(options);
    let startupFailed = false;
    const samplesPerWindow = Math.max(2, Math.floor(options.sampleRate * options.windowMs / 1000));
    const bytesPerWindow = samplesPerWindow * 2;
    const calibrationWindows = Math.max(1, Math.ceil(options.calibrationSeconds * 1000 / options.windowMs));
    let pending = Buffer.alloc(0);
    let windowNumber = 0;
    let noiseDb = null;
    let activityStartedAt = null;

    console.log(`Listening at ${formatFrequency(options.frequency)} for ${options.durationSeconds}s...`);
    console.log('Calibrating noise floor...');

    function stop(exitCode = 0) {
        if (!capture.killed) capture.kill('SIGTERM');
        process.exitCode = exitCode;
    }

    process.once('SIGINT', () => stop());
    capture.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message && !message.includes('samples transferred')) console.error(message);
    });
    capture.on('error', (error) => {
        startupFailed = true;
        console.error(`Unable to start hackrf_transfer: ${error.message}`);
        process.exitCode = 1;
    });
    capture.on('close', (code, signal) => {
        if (!startupFailed && code !== 0 && signal !== 'SIGTERM') {
            console.error(`hackrf_transfer stopped (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`);
            process.exitCode = 1;
        }
    });

    capture.stdout.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= bytesPerWindow) {
            const window = pending.subarray(0, bytesPerWindow);
            pending = pending.subarray(bytesPerWindow);
            let power = 0;
            for (let index = 0; index < window.length; index += 2) {
                const inPhase = window.readInt8(index);
                const quadrature = window.readInt8(index + 1);
                power += inPhase * inPhase + quadrature * quadrature;
            }
            const powerDb = 10 * Math.log10(power / samplesPerWindow + Number.EPSILON);
            windowNumber += 1;

            if (windowNumber <= calibrationWindows) {
                noiseDb = noiseDb === null ? powerDb : noiseDb * 0.9 + powerDb * 0.1;
                if (windowNumber === calibrationWindows) {
                    console.log(`Noise floor: ${noiseDb.toFixed(1)} dB. Watching for LoRa activity...`);
                }
                continue;
            }

            const active = powerDb >= noiseDb + options.thresholdDb;
            if (active && activityStartedAt === null) {
                activityStartedAt = Date.now();
                console.log(`[${new Date().toISOString()}] TRANSMISSION CANDIDATE: ${powerDb.toFixed(1)} dB`);
            } else if (!active && activityStartedAt !== null) {
                const elapsed = ((Date.now() - activityStartedAt) / 1000).toFixed(1);
                console.log(`Activity ended after ${elapsed}s.`);
                activityStartedAt = null;
            }

        }
    });
}

main();