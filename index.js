#!/usr/bin/env node
const volume = require('./build/Release/volume.node');
const {spawn} = require('child_process');

let SAMPLE_RATE = Number(process.env.JABRA_KEEPALIVE_RATE);
let FREQUENCY = Number(process.env.JABRA_KEEPALIVE_FREQ);
/** 48 kHz + ~19 kHz survives typical A2DP/resampling; ultrasonic defaults were often inaudible *and* stripped so the headset slept. */
if (!Number.isFinite(SAMPLE_RATE) || SAMPLE_RATE <= 0) SAMPLE_RATE = 48000;
if (!Number.isFinite(FREQUENCY) || FREQUENCY <= 0) FREQUENCY = 19000;
if (FREQUENCY >= SAMPLE_RATE / 2) FREQUENCY = SAMPLE_RATE / 2 - 600;
/** ~50 ms of audio per write. */
const CHUNK_SAMPLES = Math.round(SAMPLE_RATE * 0.05);
const VOLUME_POLL_MS = 250;

/**
 * Aim for rough minimum (digital_peak × mixer_linear) so BT still sees activity at low Master.
 * Fixed SUB22 digital floors were still ~linear times too weak at the output. Env-tunable.
 */
let E_MIN = Number(process.env.JABRA_KEEPALIVE_EFFECTIVE_MIN);
if (!Number.isFinite(E_MIN) || E_MIN <= 0) E_MIN = 0.0028;
let E_LINEAR_FLOOR = Number(process.env.JABRA_KEEPALIVE_EFFECTIVE_LINEAR_FLOOR);
if (!Number.isFinite(E_LINEAR_FLOOR) || E_LINEAR_FLOOR <= 0) E_LINEAR_FLOOR = 0.034;
let E_PEAK_CAP = Number(process.env.JABRA_KEEPALIVE_EFFECTIVE_PEAK_CAP);
if (!Number.isFinite(E_PEAK_CAP) || E_PEAK_CAP <= 0) E_PEAK_CAP = 0.06;

/**
 * Mixer % is not linear gain: inverse scaling + mild mid notch + wake bump (~38–45%).
 * Below ~15% linear, extra lift. **Effective-output floor** when linear < ~48%.
 * If ALSA **Master** read fails (`percent < 0`), use a fixed BT-safe peak (was incorrectly 50%).
 * Above ~72% squash for full master.
 */
function peakForMasterPercent(percent) {
  if (percent < 0) {
    return Math.min(E_PEAK_CAP, 0.032);
  }
  const linear = Math.max(1, percent) / 100;
  const baseline = 0.00125 / linear;
  // Mid-volume tends to be the most audible; notch it a bit harder.
  const z = (linear - 0.4) / 0.12;
  const notch = 1 - 0.46 * Math.exp(-z * z);
  let peak = baseline * notch;
  // Keep a small wake bump, but avoid audible “hiss” around ~45%.
  const wake = 0.00235 * Math.exp(-Math.pow((linear - 0.39) / 0.15, 2));
  peak = Math.max(peak, wake);
  const preLiftCap = linear < 0.22 ? 0.017 : 0.012;
  peak = Math.min(preLiftCap, Math.max(0.0004, peak));
  if (linear < 0.15) {
    peak *= 1 + (0.15 - linear) * 3.1;
    peak = Math.min(0.028, Math.max(0.0005, peak));
  }
  const wakeLowMid = 0.012 * Math.exp(-Math.pow((linear - 0.11) / 0.22, 2));
  peak = Math.max(peak, wakeLowMid);
  if (linear > 0.72) {
    const t = Math.min(1, (linear - 0.72) / 0.28);
    peak *= 1 - 0.6 * t * t;
  }
  if (linear < 0.48) {
    const need = E_MIN / Math.max(linear, E_LINEAR_FLOOR);
    peak = Math.min(E_PEAK_CAP, Math.max(peak, need));
  }
  // Extra safety cap around the “most audible” mid band.
  // (Keeps the effective floor from making ~40–50% Master annoyingly loud.)
  if (linear >= 0.38 && linear <= 0.52) {
    peak = Math.min(peak, 0.0055);
  }
  return Math.max(0.00035, peak);
}

function writeChunk(stdin, buf) {
  if (stdin.destroyed) return Promise.reject(new Error('aplay stdin closed'));
  return new Promise((resolve, reject) => {
    stdin.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const aplay = spawn('aplay', [
    '-q',
    '-f', 'S16_LE',
    '-c', '1',
    '-r', String(SAMPLE_RATE),
    '-t', 'raw',
    '-',
  ], {stdio: ['pipe', 'inherit', 'inherit']});

  let masterPercent = volume.getVolume();
  let warnedBadVol = false;
  if (masterPercent < 0 && !warnedBadVol) {
    warnedBadVol = true;
    console.warn(
      'jabra-keepalive: ALSA Master unavailable (wrong card/elem?). Using fixed peak; see README / TUNING.md.',
    );
  }
  const iv = setInterval(() => {
    const v = volume.getVolume();
    if (v < 0 && !warnedBadVol) {
      warnedBadVol = true;
      console.warn(
        'jabra-keepalive: ALSA Master unavailable (wrong card/elem?). Using fixed peak; see README / TUNING.md.',
      );
    }
    masterPercent = v;
  }, VOLUME_POLL_MS);

  const deltaPhase = (2 * Math.PI * FREQUENCY) / SAMPLE_RATE;
  let phase = 0;
  const buf = Buffer.alloc(CHUNK_SAMPLES * 2);

  const shutdown = () => {
    clearInterval(iv);
    aplay.stdin.end();
    aplay.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  aplay.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });

  try {
    while (true) {
      const peak = peakForMasterPercent(masterPercent);
      for (let i = 0; i < CHUNK_SAMPLES; i++) {
        const s = Math.sin(phase) * peak * 32767;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
        phase += deltaPhase;
        if (phase >= Math.PI * 2) phase -= Math.PI * 2;
      }
      await writeChunk(aplay.stdin, buf);
    }
  } catch (err) {
    clearInterval(iv);
    console.error(err);
    process.exit(1);
  }
}

main();
