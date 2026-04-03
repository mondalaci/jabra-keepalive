# jabra-keepalive — tuning notes

Carry these forward when changing behavior or debugging “too loud”, “still sleeps”, or “hear it at X%”.

## Goal

Keep enough **real PCM** hitting the Bluetooth path so Jabra (e.g. Evolve2 85) does not enter power-saving (~10 s idle → 1–2 s missing audio on the next event). Background: [Working around Jabra’s power-saving](https://monda.hu/working-around-jabras-power-saving/).

## Approaches tried (what we learned)

| Approach | Outcome |
|----------|---------|
| Two `.wav` files + `aplay`, switch at 25% “Master” | **Engineering:** “inelegant” meant shipping binary assets, two frequencies, and restarting `aplay` on every cross—not that they were only “a bit loud.” **Perception:** often **audible or janky around ~25%** (hard switch + level). |
| Continuous raw PCM sine, inverse vs mixer % | Better; ~40% still often too loud because ALSA **% ≠ linear gain**. |
| 96 kHz + ~27 kHz “ultrasonic” | Often **inaudible** but headset **still slept**: A2DP/resample/headset chain frequently **does not deliver** that energy → looks like silence to the radio. |
| **48 kHz + ~19 kHz** + inverse + mild notch + **wake bump** | In-band for typical stacks; **barely audible** when always-on, **keeps link** at most volumes. |
| **Pulsed bursts** + idle trickle | Helped some edge cases, but **bursts were distracting** and **hard to debug**, so **removed**. Low-master boost that used to live in pulse mode is **folded into `peakForMasterPercent`** (see below). |

**Takeaway:** Prefer defaults that survive the real BT pipeline. Ultrasonic is only worth experiments on paths you know preserve it.

## Current knobs (`index.js`)

### Rate / frequency

- **`SAMPLE_RATE`** (default `48000`): Env `JABRA_KEEPALIVE_RATE`.
- **`FREQUENCY`** (default `19000`): Env `JABRA_KEEPALIVE_FREQ`. Capped below Nyquist automatically.

### `peakForMasterPercent(percent)` — always-on stream

Mixer value comes from native `getVolume()` (ALSA `Master`, 0–100).

1. **`linear`** = `max(1, percent) / 100`.
2. **Comfort curve:** `baseline = 0.00125 / linear`, Gaussian **notch** at **0.4** linear (`z = (linear - 0.4) / 0.13`, depth **0.38**).
3. **Wake bump:** `wake = 0.003 * exp(-((linear - 0.39) / 0.17)²)` then `peak = max(comfort, wake)`.
4. **First clamp:** `min(preLiftCap, max(0.0004, peak))` with **`preLiftCap = 0.017`** when `linear < 0.22` else **`0.012`**.
5. **Low-master lift:** if `linear < 0.15`, `peak *= 1 + (0.15 - linear) * 3.1`, then `min(0.028, max(0.0005, peak))`.
6. **wakeLowMid:** `peak = max(peak, 0.012 * exp(-((linear - 0.11) / 0.22)²))` — broad assist; not sufficient alone for BT.
7. **High-master squash:** if `linear > 0.72`, `peak *= 1 - 0.6 * t²` with `t = min(1, (linear - 0.72) / 0.28)`.
8. **Effective-output floor** (if `linear < 0.48`): `peak = max(peak, E_MIN / max(linear, E_LINEAR_FLOOR))`, then cap **`E_PEAK_CAP`**. Heuristic: BT needs enough **peak × linear**; a **fixed digital floor** (old `SUB22_PEAK_MIN`) was still ×linear **too quiet** at the output.
9. **`percent < 0`:** ALSA read failed — return **`~0.032`** (capped). **Previously `percent < 0` was treated as 50%,** which skipped all low-volume logic.
10. Return `max(0.00035, peak)`.

### Other (top of `index.js`)

- **`E_MIN`** (`JABRA_KEEPALIVE_EFFECTIVE_MIN`, default **`0.0028`):** target **~peak×linear**; raise if still suspends at low Master.
- **`E_LINEAR_FLOOR`** (`JABRA_KEEPALIVE_EFFECTIVE_LINEAR_FLOOR`, default **`0.034`):** min divisor so 1–4% doesn’t demand absurd PCM; lower = more aggressive at the bottom.
- **`E_PEAK_CAP`** (`JABRA_KEEPALIVE_EFFECTIVE_PEAK_CAP`, default **`0.06`**).
- **`CHUNK_SAMPLES`**: ~50 ms at current sample rate (balances latency vs write syscalls).
- **`VOLUME_POLL_MS`** (250): How often ALSA volume is re-read.

## If you need to retune

| Symptom | Direction |
|--------|-----------|
| Headset sleeps (especially ~40% mixer) | Raise **`wake`** amplitude (`0.003`) slightly, or widen the Gaussian (`0.17` → `0.2`). |
| Still **sleeps** (esp. low Master) | Raise **`E_MIN`** (`0.0028` → **`0.0035`**). If stderr warns **Master unavailable**, fix ALSA elem / card or expect wrong curve. |
| Sleeps but **only** at 1–4% | Lower **`E_LINEAR_FLOOR`** slightly (more PCM) or raise **`E_MIN`**. |
| Too **loud** / distorted low % | Lower **`E_MIN`** or raise **`E_LINEAR_FLOOR`**; lower **`E_PEAK_CAP`**. |
| Too audible ~40% | Lower **`wake`** max or narrow the bump (`0.17` smaller); optionally deepen or widen **notch** (`0.38` or `0.13`). |
| Too loud at very low % | Lower **`baseline`** numerator (`0.00125`) or soften low-% branch. |
| Too loud at **100%** | Deepen high squelch: raise **`0.72`** toward **`0.65`** or **`0.6`** in `t`, or increase **`0.6`** toward **`0.7`**. |
| Too loud at high % (in general) | Lower **`baseline`** or tighten **`max`** clamp (`0.012`). |

Always verify on **the real BT device**; laptop speakers or wired DAC are not enough to validate “sleep” behavior.

## Debug: key beeps (minimal)

`./debug-beep-keys.mjs` — keys **1…0** map to **10%…100%** Master, immediate beep; **10 s** after each beep it prints a line so you can watch clock vs BT idle (timer resets on the next beep). Same `JABRA_DEBUG_AMIXER_*` / `JABRA_DEBUG_BEEP_HZ` / `JABRA_DEBUG_BEEP_MS` as the sweep.

## Debug: volume sweep CLI

`./debug-volume-sweep.mjs` — **bisection** from **50%**; **first “n” stops** the main pass; if that **n** is @ **50%**, it **also** tries **75%** and **100%** (so “not heard at 50%” alone does not hide a working higher Master). **10 s** idle + beep + **y/n**. **`debug-volume-sweep-last.txt`** in the repo holds the **full run log** (overwritten each time). Optional: `JABRA_DEBUG_AMIXER_CONTROL`, `JABRA_DEBUG_AMIXER_CARD`, `JABRA_DEBUG_BEEP_HZ`, `JABRA_DEBUG_BEEP_MS` (default **80** — short beep so Jabra wake-up is less likely to make only the **end** of the tone audible), `JABRA_DEBUG_SESSION` (label for logs, e.g. `with-keepalive`). Diagnostic beep **digital peak** tapers as Master → **100%**: ~**0.88** at **0%**, ~**0.022** at **100%**, with exponent **1.55** on `(1 − t)` so **70–100%** is much quieter than a linear taper.

If **summary** says not heard at **50%** (or 50/75/100): often **`Master` is not the Bluetooth PCM control** — check `amixer`, Pulse/PipeWire volume, or the BT sink’s own level. Confirm with `aplay` to the device you expect.

### Why the same sweep looks inconsistent between runs

The probe is **10 s quiet → one beep → y/n**. That quiet window is **not the same** if **`node index.js`** is running in another terminal:

| During sweep | What those 10 s mean |
|--------------|----------------------|
| **Keepalive on** | The link still gets continuous (very quiet) PCM — BT often **stays awake**. Beep arrival is more reliable; **50% heard / 25% not** is normal (level). |
| **Keepalive off** | **True silence** — headset can enter **power-save**. The first sound after idle may be **cropped, delayed, or “missing”** depending on level and timing. **n @ 50% / 75% but y @ 100%** is consistent with “only a loud enough burst reliably wakes the path.” |

So two runs can disagree if one was **with** keepalive and one **without**, or if headset state / seating / RF differed. **Only compare runs with the same deliberate setup.** Tag runs with `JABRA_DEBUG_SESSION=with-keepalive` or `without-keepalive` so logs stay interpretable.

## Env quick reference

```bash
# Rate / frequency (defaults 48000 / 19000)
JABRA_KEEPALIVE_RATE=96000 JABRA_KEEPALIVE_FREQ=27000 node index.js

# Effective output floor (see “Other” above)
JABRA_KEEPALIVE_EFFECTIVE_MIN=0.0032 JABRA_KEEPALIVE_EFFECTIVE_LINEAR_FLOOR=0.03 node index.js
```

Last change: **effective-output floor** (`E_MIN` / linear) + **`percent < 0`** uses fixed peak (not 50%).
