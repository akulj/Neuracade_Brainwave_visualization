# Neuracade EEG Dashboard

A local Web Serial dashboard for the 8-channel ADS1299/ESP32 stream, built to fix the
hang/slowdown we were hitting when combining multiple live plots with signal analysis.

## Files
- `index.html` — page shell, tabs, layout
- `worker-bridge.js` — all main-thread logic: serial I/O, ring buffers, uPlot rendering, CSV export
- `worker.js` — a real Web Worker: FFT (radix-2 Cooley-Tukey), Welch PSD, SFDR, band power


This version (closer to your `index2.html` approach, extended) fixes that with three
separations:

1. **Read aint Draw.** The serial read loop only writes floats into `Float32Array` ring
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

## Tuning for hardware

- Set **Sample rate (Hz)** to match your ADS1299 config (your `fft_check.py` uses 250) before
  connecting — it sizes the ring buffers (10s of history) and the frequency axis.
- If channels still feel laggy with many selected for analysis, either reduce the number of
  selected channels on the Spectrum tab, shorten the FFT window, or raise the update
  interval — the per-sample plotting path is unaffected by any of this since it's fully
  decoupled from the worker.
- The parser accepts space- or comma-separated values, strips Arduino `HH:MM:SS.mmm ->`
  timestamp prefixes (same as `fft_check.py`), and also tolerates `name:value` tokens from
  the Arduino IDE 2.x plotter format.

## Next steps

- **Excel export** is done via CSV (double-click any plot, or the header button) — CSV opens
  directly in Excel with no extra tooling required.
- **Real-time FFT**: rather than the single end-of-recording FFT in `fft_check.py`, the
  Spectrum tab now recomputes a Welch PSD on a rolling window continuously while connected.
- **Motor imagery**: the band-power + asymmetry view is the first building block; a natural
  next step is adding a cue/trial marker (e.g. a keypress or serial marker byte) so you can
  epoch trials and compute ERD% relative to a pre-cue baseline.
