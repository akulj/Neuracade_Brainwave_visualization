# Neuracade EEG Dashboard

A local Web Serial dashboard for your 8-channel ADS1299/ESP32 stream, built to fix the
hang/slowdown you were hitting when combining multiple live plots with signal analysis.

## Files
- `index.html` — page shell, tabs, layout
- `worker-bridge.js` — all main-thread logic: serial I/O, ring buffers, uPlot rendering, CSV export, gesture-control wiring
- `worker.js` — a real Web Worker: FFT (radix-2 Cooley-Tukey), Welch PSD, SFDR, band power
- `gesture-detector.js` — real-time, drift-robust burst/gesture classifier (see below)

## Why it was hanging before (and what changed)

Your `index.html` used Chart.js and called `chart.update()` synchronously inside the serial
read loop, once per incoming line. That's fine with one chart. With 8 small charts + a
combined chart + FFT math in the same place, each incoming sample was forcing multiple
re-renders and Chart.js re-layouts per line at 250–500 Hz — the main thread never catches up
and the tab appears to freeze.

This version (closer to your `index2.html` approach, extended) fixes that with three
separations:

1. **Read ≠ Draw.** The serial read loop only writes floats into `Float32Array` ring
   buffers. It never calls into a chart.
2. **Draw loop is throttled and tab-aware.** A single `requestAnimationFrame` loop, capped
   at 30fps, redraws only the plots on the *currently visible* tab. Switching to the
   Combined tab doesn't cost anything on the Individual tab, and vice versa.
3. **DSP runs in a Web Worker, on a timer — not per sample.** FFT / Welch PSD / SFDR / band
   power run on a background thread every N ms (configurable, default 1000ms) over a
   configurable window (default 5s), for only the channels you select. Results come back as
   small JSON and get applied directly (no heavy work on the UI thread ever).
4. **uPlot instead of Chart.js.** uPlot is a canvas-only, near-zero-overhead plotting
   library — this is what your `index2.html` already discovered works well, and it's used
   everywhere here (individual, combined, and spectrum plots) for consistency.

## Running it

Web Serial requires a "secure context." `file://` pages are treated as opaque origins and
`navigator.serial` will be undefined or blocked, so serve the folder over localhost:

```bash
cd eeg-dashboard
python3 -m http.server 8000
```

Then open **http://localhost:8000** in Chrome or Edge (Web Serial isn't supported in
Firefox/Safari). Click **Connect Serial**, pick COM10, and the same permission dialog you
already see in the Arduino IDE / your existing `index.html` will appear.

## Using it

- **Individual Channels tab** — 8 small live plots, one per channel. Rename a channel
  (e.g. to `C3`) in its title bar; the name is saved in `localStorage` and reused across
  the Combined, Spectrum, and Motor Imagery tabs. Double-click a plot to export that
  channel's current 10s window as CSV (opens cleanly in Excel).
- **Combined tab** — all 8 channels overlaid on one uPlot chart, with a click-to-toggle
  legend per channel and a CSV export button (or double-click the chart) for the whole
  visible window.
- **Spectrum & SFDR tab** — pick which channels to analyze (keep this to a handful of
  channels; each one adds a full Welch PSD computation per cycle). Configure the FFT
  window length and update interval. Below the per-channel PSD plots there's an SFDR table:
  fundamental frequency, dominant spur frequency, and SFDR in dB, computed the standard way
  (ratio of the largest spectral peak to the largest non-adjacent spurious peak).
- **Motor Imagery tab** — mu (8–13Hz) and beta (13–30Hz) band power per selected channel,
  plus a left/right mu-power asymmetry readout `(left − right)/(left + right)` once you
  assign two channels (e.g. rename two channels to `C3`/`C4` and pick them in the
  dropdowns). This is a bare starting point for ERD/ERS-style motor imagery features, not a
  validated classifier — you'll likely want to add baseline normalization and trial epoching
  once you get to real motor-imagery experiments.

## Gesture Control tab (toe / ankle / leg → robotic arm commands)

This solves the specific problem of classifying movement bursts (toe wiggle, ankle wiggle,
leg movement) in real time when the raw baseline itself keeps drifting up and down by tens
of thousands of µV — a fixed amplitude threshold cannot work against that, because any
number you pick will eventually sit on the wrong side of the drift.

**How it avoids absolute thresholds entirely** (see `gesture-detector.js`, heavily commented):
1. A cascaded (two-stage) causal high-pass filter removes the slow baseline wander while
   passing the faster (~1-10Hz) burst content through almost untouched. A single-stage
   filter turned out not to be steep enough — a ~0.03Hz baseline wander still leaked several
   percent of its amplitude through, which was enough to look like a real burst.
2. The filtered signal is rectified and smoothed (also cascaded, to flatten out the burst's
   own oscillation ripple) into an amplitude **envelope**.
3. A **noise floor** tracks the envelope, but only while the detector is idle — it is frozen
   the instant a gesture becomes active. (An earlier version let the floor keep creeping
   toward the envelope even during a large burst, which let a big movement and a small one
   converge toward the same ratio — this freeze is what fixes that.)
4. Detection is based on the **ratio** of envelope to floor, not either value alone. At rest
   this ratio sits near 1 regardless of where the raw baseline currently is; during a real
   burst it spikes well above 1, in proportion to how big the movement is.
5. Three tiers (toe/ankle/leg by default) are separated with hysteresis (separate
   enter/exit ratios + a minimum hold time), so the state can't flicker on a single noisy
   sample. Transitions map to commands: `close_index_finger` (toe or ankle by default),
   `close_fist` (leg), `open_hand` (returning to idle) — edit `gesture-detector.js`'s
   `tiers` array to change the mapping or add more tiers.

**Why calibration matters (and is built in):** the actual ratio a toe-wiggle vs. a full-leg
movement produces depends on your electrode placement, impedance, and gain — there's no
universal number. The Gesture Control tab has a 4-step wizard:
1. *Stay still* (5s) — lets the floor settle to your true resting level.
2. *Wiggle toes* (4s) — records the peak ratio, sets the toe tier's thresholds to ~65%/~40%
   of what it saw.
3. *Wiggle ankles* (4s) — same, for the ankle tier.
4. *Move leg* (4s) — same, for the leg tier.

Do each step cleanly (one clear movement, then stay still until the countdown ends) and
leave a couple of quiet seconds between steps so the floor can settle back down before the
next one — otherwise a step can be contaminated by the previous movement's decay tail.
Thresholds and the live enter/exit values are shown in the table below the wizard, and you
can hand-edit `gesture-detector.js`'s defaults if you'd rather not recalibrate each session.

**Wiring to a robotic arm:** check "Write commands to serial port" and the detected command
strings (e.g. `close_fist\n`) are written as plain ASCII lines to the same serial connection
used for reading — have your arm's firmware listen for lines on that same UART. If your arm
needs a different connection, the write-back logic lives in `handleGestureEvent()` in
`worker-bridge.js` and is easy to point at a second port or a different protocol instead.

## Tuning for your hardware

- Set **Sample rate (Hz)** to match your ADS1299 config (your `fft_check.py` uses 250) before
  connecting — it sizes the ring buffers (10s of history) and the frequency axis.
- If channels still feel laggy with many selected for analysis, either reduce the number of
  selected channels on the Spectrum tab, shorten the FFT window, or raise the update
  interval — the per-sample plotting path is unaffected by any of this since it's fully
  decoupled from the worker.
- The parser accepts space- or comma-separated values, strips Arduino `HH:MM:SS.mmm ->`
  timestamp prefixes (same as `fft_check.py`), and also tolerates `name:value` tokens from
  the Arduino IDE 2.x plotter format.

## Known issue (flagged, not yet fixed)

You mentioned the Spectrum tab's FFT doesn't look right — agreed, let's tackle that next.
Likely culprits worth checking first: whether `segLen` (capped at 1024 in `worker.js`) is
too short relative to your chosen FFT window for the frequency resolution you want, and
whether the per-segment mean removal in `welchPSD` is fighting with the channel selection.
Flag specific symptoms (wrong peak frequencies? flat/noisy PSD? wrong power scale?) and
we'll go through it.

## Next steps you mentioned

- **Excel export** is done via CSV (double-click any plot, or the header button) — CSV opens
  directly in Excel with no extra tooling required.
- **Real-time FFT**: rather than the single end-of-recording FFT in `fft_check.py`, the
  Spectrum tab now recomputes a Welch PSD on a rolling window continuously while connected.
- **Motor imagery**: the band-power + asymmetry view is the first building block; a natural
  next step is adding a cue/trial marker (e.g. a keypress or serial marker byte) so you can
  epoch trials and compute ERD% relative to a pre-cue baseline.
