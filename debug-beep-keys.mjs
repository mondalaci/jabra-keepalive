#!/usr/bin/env node
/**
 * Primitive beep tester: **1 … 9** → **10% … 90%** Master, **0** → **100%**. Each press sets
 * `amixer`, prints the level, plays one square-wave beep (same logic as the sweep; digital peak tapers at high Master%).
 * **10 s** after each beep, a line is printed (`10 s elapsed since beep.`); a new beep resets that timer.
 * **q** or **Ctrl+C** quits and restores initial Master when `volume.node` read worked.
 *
 * Env: `JABRA_DEBUG_AMIXER_CONTROL` (default `Master`), `JABRA_DEBUG_AMIXER_CARD`, `JABRA_DEBUG_BEEP_HZ`, `JABRA_DEBUG_BEEP_MS` (default **80**).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { exit, stdin as input, stdout as output } from 'node:process';

const require = createRequire(import.meta.url);

const AMIXER_CONTROL = process.env.JABRA_DEBUG_AMIXER_CONTROL || 'Master';
const AMIXER_CARD = process.env.JABRA_DEBUG_AMIXER_CARD;
let BEEP_HZ = Number(process.env.JABRA_DEBUG_BEEP_HZ);
if (!Number.isFinite(BEEP_HZ) || BEEP_HZ <= 0) BEEP_HZ = 2000;
if (BEEP_HZ >= 24000) BEEP_HZ = 2000;
let BEEP_MS = Number(process.env.JABRA_DEBUG_BEEP_MS);
if (!Number.isFinite(BEEP_MS) || BEEP_MS <= 0) BEEP_MS = 80;
BEEP_MS = Math.min(3000, Math.max(20, BEEP_MS));

/** Milliseconds after each beep before printing the elapsed notice (fixed **10 s**). */
const POST_BEEP_ELAPSED_MS = 10000;

function amixerArgs(pct) {
  const args = ['-q', 'sset', AMIXER_CONTROL, `${pct}%`, 'unmute'];
  if (AMIXER_CARD) args.unshift('-c', AMIXER_CARD);
  return args;
}

function setMasterPercent(p) {
  execFileSync('amixer', amixerArgs(p), {stdio: 'ignore'});
}

/** `1`…`9` → 10…90, `0` → 100; else `null`. */
function keyToPercent(ch) {
  if (ch >= '1' && ch <= '9') return (ch.charCodeAt(0) - 48) * 10;
  if (ch === '0') return 100;
  return null;
}

/** Digital full-scale 0…1: strong at low Master%, much softer toward **100%** (power curve + low floor). */
function digitalPeakForBeepMasterPercent(percent) {
  const t = Math.min(100, Math.max(0, percent)) / 100;
  const at100 = 0.022;
  const at0 = 0.88;
  const k = 1.55;
  return at100 + (1 - t) ** k * (at0 - at100);
}

function playBeep(masterPercent) {
  const sampleRate = 48000;
  const dur = BEEP_MS / 1000;
  const freq = BEEP_HZ;
  const peak = digitalPeakForBeepMasterPercent(masterPercent);
  const n = Math.floor(sampleRate * dur);
  const fadeLen = Math.min(Math.floor(sampleRate * 0.004), Math.floor(n / 4));
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (fadeLen > 0) {
      if (i < fadeLen) env = i / fadeLen;
      else if (i >= n - fadeLen) env = (n - i) / fadeLen;
    }
    const ph = (2 * Math.PI * freq * i) / sampleRate;
    const sq = Math.sin(ph) >= 0 ? 1 : -1;
    const s = sq * peak * env;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return new Promise((resolve, reject) => {
    const aplay = spawn('aplay', [
      '-q', '-f', 'S16_LE', '-c', '1', '-r', String(sampleRate), '-t', 'raw', '-',
    ], {stdio: ['pipe', 'inherit', 'inherit']});
    aplay.stdin.write(buf);
    aplay.stdin.end();
    aplay.on('error', reject);
    aplay.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`aplay exit ${code}`))));
  });
}

function readInitialVolume() {
  try {
    return require('./build/Release/volume.node').getVolume();
  } catch {
    return -1;
  }
}

function main() {
  const initialVol = readInitialVolume();

  if (!input.isTTY) {
    output.write('stdin must be a TTY\n');
    exit(1);
  }

  const restore = () => {
    if (initialVol >= 0) {
      try {
        setMasterPercent(initialVol);
        output.write(`\nRestored ${AMIXER_CONTROL} to ~${initialVol}%.\n`);
      } catch {
        output.write(`\nCould not restore ${AMIXER_CONTROL}; set manually (was ~${initialVol}%).\n`);
      }
    }
  };

  const cleanup = () => {
    input.setRawMode(false);
    input.pause();
    input.removeAllListeners('data');
  };

  let postBeepElapsedTimer = null;
  const clearPostBeepTimer = () => {
    if (postBeepElapsedTimer) {
      clearTimeout(postBeepElapsedTimer);
      postBeepElapsedTimer = null;
    }
  };

  const quit = (code) => {
    clearPostBeepTimer();
    cleanup();
    restore();
    exit(code);
  };

  process.once('SIGINT', () => quit(130));

  output.write(
    'Keys 1–9 → 10%–90% Master, 0 → 100%.  q = quit.  Ctrl+C = quit.\n' +
      `Each press: set volume, print line, beep (~${BEEP_HZ} Hz, ${BEEP_MS} ms); ${POST_BEEP_ELAPSED_MS / 1000} s later prints: 10 s elapsed since beep. (resets on next beep)\n` +
      `amixer ${AMIXER_CARD ? `-c ${AMIXER_CARD} ` : ''}sset ${AMIXER_CONTROL} <n>% unmute\n` +
      `Initial ${AMIXER_CONTROL} (volume.node): ${initialVol >= 0 ? `${initialVol}%` : 'unavailable (no restore)'}\n\n`,
  );

  let busy = false;
  input.setRawMode(true);
  input.resume();

  input.on('data', (buf) => {
    if (busy) return;
    const code = buf[0];
    if (code === 3) {
      quit(130);
      return;
    }
    const ch = buf.toString('utf8')[0];
    if (ch === 'q' || ch === 'Q') {
      quit(0);
      return;
    }
    const pct = keyToPercent(ch);
    if (pct === null) return;

    busy = true;
    void (async () => {
      try {
        setMasterPercent(pct);
        output.write(`Playing beep at ${pct}% (key ${ch})\n`);
        await playBeep(pct);
        clearPostBeepTimer();
        postBeepElapsedTimer = setTimeout(() => {
          postBeepElapsedTimer = null;
          output.write('10 s elapsed since beep.\n');
        }, POST_BEEP_ELAPSED_MS);
      } catch (e) {
        output.write(`Error: ${e.message}\n`);
      } finally {
        busy = false;
      }
    })();
  });
}

main();
