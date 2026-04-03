#!/usr/bin/env node
/**
 * Interactive sweep: Master **5%…100%** in **5%** steps. Each step: **10 s** wait, square
 * beep, **y/n** (single key).
 *
 * **Bisection order** (first probe **50%**, BFS over index ranges). **First “n” ends the main pass**
 * — *unless* that first “n” is at **50%**, in which case we **also** try **75%** then **100%** so a
 * “deaf at 50% only” path still shows up in the summary (wrong control / need higher Master).
 *
 * Procedure — **with keepalive** (testing that you still hear the diagnostic beep on top of it):
 *   1. Terminal A: `node index.js` (leave running).
 *   2. Terminal B: `./debug-volume-sweep.mjs`
 *   Answer y/n for the **diagnostic beep** (~2 kHz default), not the quiet keepalive tone.
 *
 * Procedure — **without keepalive** (baseline: idle ~10s before each beep):
 *   Stop index.js, then run this script alone.
 *
 * Requires: amixer, aplay, built volume.node (optional, for restore read).
 * Env: JABRA_DEBUG_AMIXER_CONTROL (default Master), JABRA_DEBUG_AMIXER_CARD (default omit = default),
 *   JABRA_DEBUG_BEEP_HZ (default 2000), JABRA_DEBUG_BEEP_MS (default **80** — short so BT wake-up does not dominate the tail).
 *   Beep is a **square wave** (not sine); **digital level** tapers down as Master → **100%** so high % is not deafening.
 *   JABRA_DEBUG_SESSION — optional freeform label (e.g. `with-keepalive`) logged in the header so runs are comparable.
 *
 * **Log:** each run overwrites `debug-volume-sweep-last.txt` next to this script (full transcript + summary).
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), 'debug-volume-sweep-last.txt');

const N_LEVELS = 20;
const LEVELS = Array.from({length: N_LEVELS}, (_, i) => (i + 1) * 5);

/** BFS bisection visit order on indices [0 .. n-1]; first is **50%** (`LEVELS[9]`). */
function bisectionIndices(n) {
  const out = [];
  const seen = new Set();
  const q = [[0, n - 1]];
  while (q.length > 0) {
    const [lo, hi] = q.shift();
    if (lo > hi) continue;
    const mid = Math.floor((lo + hi) / 2);
    if (!seen.has(mid)) {
      seen.add(mid);
      out.push(mid);
    }
    q.push([lo, mid - 1], [mid + 1, hi]);
  }
  return out;
}
const AMIXER_CONTROL = process.env.JABRA_DEBUG_AMIXER_CONTROL || 'Master';
const AMIXER_CARD = process.env.JABRA_DEBUG_AMIXER_CARD;
const DEBUG_SESSION = (process.env.JABRA_DEBUG_SESSION || '').trim();
let BEEP_HZ = Number(process.env.JABRA_DEBUG_BEEP_HZ);
if (!Number.isFinite(BEEP_HZ) || BEEP_HZ <= 0) BEEP_HZ = 2000;
if (BEEP_HZ >= 24000) BEEP_HZ = 2000;
let BEEP_MS = Number(process.env.JABRA_DEBUG_BEEP_MS);
if (!Number.isFinite(BEEP_MS) || BEEP_MS <= 0) BEEP_MS = 80;
BEEP_MS = Math.min(3000, Math.max(20, BEEP_MS));

const IDLE_MS = 10000;

function amixerArgs(pct) {
  const args = ['-q', 'sset', AMIXER_CONTROL, `${pct}%`, 'unmute'];
  if (AMIXER_CARD) args.unshift('-c', AMIXER_CARD);
  return args;
}

function setMasterPercent(p) {
  execFileSync('amixer', amixerArgs(p), {stdio: 'ignore'});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Single-key y/n — no Enter (raw TTY). `writeOut` receives echoed prompt and answer. */
function readYnKey(prompt, writeOut = output.write.bind(output)) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new Error('stdin is not a TTY; cannot read single-key y/n'));
      return;
    }
    writeOut(prompt);
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (buf) => {
      const code = buf[0];
      if (code === 3) {
        cleanup();
        process.kill(process.pid, 'SIGINT');
        return;
      }
      const ch = buf.toString('utf8').toLowerCase()[0];
      if (ch === 'y' || ch === 'n') {
        cleanup();
        writeOut(`${ch}\n`);
        resolve(ch === 'y');
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

/** Digital full-scale 0…1 for beep PCM: strong at low Master%, much softer toward **100%** (power curve + low floor). */
function digitalPeakForBeepMasterPercent(percent) {
  const t = Math.min(100, Math.max(0, percent)) / 100;
  const at100 = 0.022;
  const at0 = 0.88;
  const k = 1.55;
  return at100 + (1 - t) ** k * (at0 - at100);
}

/** ~50% duty square wave: buzzy / “monotone” vs pure sine; short fades reduce edge clicks. */
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
    const ph = ((2 * Math.PI * freq * i) / sampleRate);
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

function formatSummary(results, initialVol, err, meta) {
  const lines = [];
  lines.push('### Volume sweep');
  lines.push(`- Control: \`${AMIXER_CONTROL}\`${AMIXER_CARD ? ` card ${AMIXER_CARD}` : ''}`);
  lines.push(`- Initial read (volume.node): ${initialVol >= 0 ? `${initialVol}%` : 'unavailable'}`);
  lines.push(
    '- Strategy: **bisection from 50%**; **stop on first “n”** (after main pass); **extra 75% / 100%** if the only failure so far is **n @ 50%**.',
  );
  if (meta?.followupHeardAt != null) {
    lines.push(
      `- **Louder follow-up:** after **n @ 50%**, heard beep at **${meta.followupHeardAt}%** — Master may need to stay above ~50% for this sink, or the first probe was a fluke (retry).`,
    );
  }
  if (meta?.stoppedOnN != null) {
    lines.push(`- **Stopped early:** first “n” at **${meta.stoppedOnN}%** (later bisection levels not tested).`);
  } else if (results.length > 0) {
    lines.push(`- **Completed:** ${results.length} level(s) tested.`);
  }
  if (err) lines.push(`- **Aborted:** ${err.message}`);
  lines.push('- Per level (10s idle → beep):');
  const byPct = [...results].sort((a, b) => a.p - b.p);
  for (const {p, heard} of byPct) {
    lines.push(`  - ${p}%: ${heard ? 'heard' : 'not heard'}`);
  }
  const notHeard = results.filter((r) => !r.heard).map((r) => r.p);
  lines.push(`- **Summary:** not heard at: ${notHeard.length ? notHeard.join(', ') + '%' : '—'}`);
  return lines.join('\n');
}

async function main() {
  const initialVol = readInitialVolume();
  const results = [];
  const meta = {stoppedOnN: null, followupHeardAt: null};
  let fatal = null;

  function tee(s) {
    appendFileSync(LOG_FILE, s, 'utf8');
    output.write(s);
  }

  writeFileSync(
    LOG_FILE,
    `# jabra-keepalive volume sweep\n` +
      `# started: ${new Date().toISOString()}\n` +
      `# log file: ${LOG_FILE}\n` +
      `# beep_hz: ${BEEP_HZ}  beep_ms: ${BEEP_MS}  amixer: ${AMIXER_CONTROL}${AMIXER_CARD ? `  card: ${AMIXER_CARD}` : ''}\n` +
      `# initial_volume.node: ${initialVol >= 0 ? `${initialVol}%` : 'unavailable'}\n` +
      (DEBUG_SESSION ? `# JABRA_DEBUG_SESSION: ${DEBUG_SESSION}\n` : '') +
      `#\n` +
      `# Repeatability: compare runs only with the SAME setup. If node index.js runs during the sweep,\n` +
      `#   the 10s "idle" still has keepalive PCM — BT often stays awake; beeps usually arrive.\n` +
      `#   Without keepalive, 10s is true silence; Jabra-style power-save can swallow or clip the first\n` +
      `#   sound, so "heard?" can change between runs and by Master% (quiet easier to "miss"; 100% can still wake).\n` +
      `#   Optional: export JABRA_DEBUG_SESSION=with-keepalive or without-keepalive for your notes.\n` +
      `#\n\n`,
    'utf8',
  );
  tee(`Log: ${LOG_FILE}\n`);
  tee(
    `\n**Repeatability:** use the **same** keepalive on/off setup every run (see log header). ` +
      `Mixing \`node index.js\` running vs stopped makes results look inconsistent — that is expected.\n` +
      (DEBUG_SESSION ? `**Session label:** \`${DEBUG_SESSION}\`\n` : `*(Set \`JABRA_DEBUG_SESSION\` to tag this run in the log.)*\n`),
  );

  const restore = () => {
    if (initialVol >= 0) {
      try {
        setMasterPercent(initialVol);
        tee(`\nRestored ${AMIXER_CONTROL} to ~${initialVol}%.\n`);
      } catch {
        tee(`\nCould not restore ${AMIXER_CONTROL}; set it manually (was ~${initialVol}%).\n`);
      }
    }
  };

  process.once('SIGINT', () => {
    tee('\n\nInterrupted (SIGINT).\n');
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    restore();
    const footer = '\n--- copy from below ---\n\n' + formatSummary(results, initialVol, new Error('SIGINT'), meta) + '\n';
    appendFileSync(LOG_FILE, footer, 'utf8');
    output.write(footer);
    process.exit(130);
  });

  tee(
    `\n**Bisection from 50%** — first **n** ends the **main** pass (if that **n** is @ **50%**, we then try **75%** and **100%**). Each step: **10 s** idle, square beep (~${BEEP_HZ} Hz), **y** / **n** (one key).\n` +
      `Command: \`amixer ${AMIXER_CARD ? `-c ${AMIXER_CARD} ` : ''}sset ${AMIXER_CONTROL} <n>% unmute\`\n\n`,
  );

  async function probeLevel(p) {
    setMasterPercent(p);
    tee(`\n[${p}%] wait 10 seconds…\n`);
    await sleep(IDLE_MS);
    tee('Playing beep…\n');
    await playBeep(p);
    const heard = await readYnKey('Heard the beep? (y/n) ', tee);
    results.push({p, heard});
    return heard;
  }

  try {
    main: for (const idx of bisectionIndices(N_LEVELS)) {
      const p = LEVELS[idx];
      const heard = await probeLevel(p);
      if (!heard) {
        meta.stoppedOnN = p;
        tee(`\n**Stopped main pass — first “n” at ${p}%.**\n`);
        if (results.length === 1 && p === 50) {
          tee(
            'First failure was at **50%** — trying **75%** and **100%** so we know if louder Master fixes it.\n',
          );
          for (const up of [75, 100]) {
            if (results.some((r) => r.p === up)) continue;
            const ok = await probeLevel(up);
            if (ok) {
              meta.followupHeardAt = up;
              tee(`\n**Heard at ${up}%** — note for your summary above.\n`);
            }
          }
        } else {
          tee('No more bisection levels.\n');
        }
        break main;
      }
    }
  } catch (e) {
    fatal = e;
  } finally {
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    restore();
  }

  const footer = '\n--- copy from below ---\n\n' + formatSummary(results, initialVol, fatal || undefined, meta) + '\n';
  if (fatal) appendFileSync(LOG_FILE, `# error: ${fatal.message}\n`, 'utf8');
  appendFileSync(LOG_FILE, footer, 'utf8');
  output.write(footer);
  process.exit(fatal ? 1 : 0);
}

main();
