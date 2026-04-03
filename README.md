# jabra-keepalive

Small utility that keeps the wireless audio path to a Jabra headset active so short sounds are not delayed or dropped.

**Background:** On headsets such as the Jabra Evolve2 85, about ten seconds without audio triggers a power-saving mode. When that happens, the first second or two of the next sound can be missing—easy to miss a short chat notification or the opening of a video. Jabra Sound+ does not expose a way to turn this off. For the full story and rationale, see [Working around Jabra's power-saving](https://monda.hu/working-around-jabras-power-saving/).

This repository streams one **~19 kHz** sine through `aplay` as raw PCM at **48 kHz** (in-band for typical A2DP/resampling). The level is **steady** (no bursts): easier to reason about and less distracting. It tracks ALSA `Master` with a mid-range notch, a wake bump around ~40%, and extra gain below ~15% so very low volumes still move the link.

Env: `JABRA_KEEPALIVE_RATE`, `JABRA_KEEPALIVE_FREQ`, `JABRA_KEEPALIVE_EFFECTIVE_MIN`, `JABRA_KEEPALIVE_EFFECTIVE_LINEAR_FLOOR`, `JABRA_KEEPALIVE_EFFECTIVE_PEAK_CAP`. If startup warns that **Master** is unavailable, the keepalive level won’t track your real BT volume until mixer names/cards match—see [TUNING.md](TUNING.md).

## Requirements

- Linux with ALSA (`libasound`), Node.js, and `aplay`

## Build

```bash
node-gyp configure build
```

## Run

```bash
node index.js
```

## PM2

If PM2 shows **errored** and the log has **`ERR_DLOPEN_FAILED`** on `volume.node`, the addon was built for a **different Node** than the one PM2 uses (common with **nvm**: login shell has nvm’s `node`, PM2 often does not).

1. Pick one Node and use it everywhere, e.g. `node -p process.execPath`.
2. Rebuild: `npm run build` (or `node-gyp rebuild`) **with that same `node`** on your `PATH`.
3. Start PM2 with that interpreter, e.g.  
   `JABRA_PM2_INTERPRETER="$(which node)" pm2 start ecosystem.config.js`  
   (`ecosystem.config.js` reads **`JABRA_PM2_INTERPRETER`**; default is `node` from PM2’s environment).

After OS login, ensure the same interpreter is set for **`pm2 resurrect`** (export in the shell/profile that runs PM2, or use an absolute path to your nvm Node in **`JABRA_PM2_INTERPRETER`**).

## Debug: volume sweep

Interactive check: **bisection from 50%** across **5…100%** (5% steps); **first “n” ends the session** (no more probes). All **y** completes all 20 levels in bisection order. **10 s** wait + **square-wave** beep + **y/n** per step. Restores volume when possible.

**With keepalive during the test:** start `node index.js` in one terminal, run `./debug-volume-sweep.mjs` in another — the 10 s window still has keepalive playing; answer for whether you hear the **loud diagnostic beep**, not the quiet tone.

**Without keepalive:** stop `index.js`, run the sweep alone to baseline “idle → beep” behavior.

```bash
./debug-volume-sweep.mjs
# or: JABRA_DEBUG_AMIXER_CONTROL=PCM JABRA_DEBUG_AMIXER_CARD=0 JABRA_DEBUG_BEEP_HZ=2500 JABRA_DEBUG_BEEP_MS=80 ./debug-volume-sweep.mjs
```

Full transcript + summary are also written to **`debug-volume-sweep-last.txt`** in the repo (overwritten each run; gitignored). Paste that file or the terminal summary when reporting issues.

### Debug: key beeps (simple)

`./debug-beep-keys.mjs` — press **1…0** for **10%…100%** Master; it prints `Playing beep at N% (key …)` and plays the same square beep as the sweep. **10 s** after each beep it prints `10 s elapsed since beep.` (timer resets if you beep again). **q** or **Ctrl+C** quits and restores Master when the addon read works. Same `JABRA_DEBUG_AMIXER_*` / `JABRA_DEBUG_BEEP_HZ` / `JABRA_DEBUG_BEEP_MS` env vars as the sweep.

See [TUNING.md](TUNING.md) for what we tried, what each constant does, and how to adjust if sleep vs. audibility drifts. Short version: tune `peakForMasterPercent` in `index.js` (`wake` = minimum energy in the ~40% problem band).
