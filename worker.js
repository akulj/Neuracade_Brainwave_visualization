// ============================================================
// worker.js — all heavy DSP happens here, off the main thread.
// The main thread only ever sends raw sample windows in and
// receives small JSON summaries back. This is what keeps the
// UI thread free to paint every frame.
// ============================================================

// ---- Radix-2 Cooley-Tukey FFT (in-place, iterative) ----
// re/im are Float64Array of length N (N must be power of 2)
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * curWr - im[i + k + len / 2] * curWi;
        const vi = re[i + k + len / 2] * curWi + im[i + k + len / 2] * curWr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nWr = curWr * wr - curWi * wi;
        const nWi = curWr * wi + curWi * wr;
        curWr = nWr; curWi = nWi;
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function hannWindow(N) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }
  return w;
}

// Simple Welch-style PSD: split into overlapping segments, window,
// FFT each, average the magnitude-squared spectra.
function welchPSD(signal, fs, segLen) {
  segLen = nextPow2(Math.min(segLen, signal.length));
  if (segLen < 8) segLen = 8;
  const step = Math.floor(segLen / 2); // 50% overlap
  const win = hannWindow(segLen);

  // window power correction factor
  let winPower = 0;
  for (let i = 0; i < segLen; i++) winPower += win[i] * win[i];
  winPower /= segLen;

  const nBins = segLen / 2;
  const acc = new Float64Array(nBins);
  let segCount = 0;

  for (let start = 0; start + segLen <= signal.length; start += step) {
    const re = new Float64Array(segLen);
    const im = new Float64Array(segLen);
    for (let i = 0; i < segLen; i++) {
      re[i] = (signal[start + i] - mean(signal, start, segLen)) * win[i];
    }
    fft(re, im);
    for (let k = 0; k < nBins; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      acc[k] += mag2;
    }
    segCount++;
  }

  if (segCount === 0) segCount = 1;

  const freqs = new Float64Array(nBins);
  const psd = new Float64Array(nBins);
  const scale = 1 / (fs * segLen * winPower * segCount);
  for (let k = 0; k < nBins; k++) {
    freqs[k] = (k * fs) / segLen;
    psd[k] = acc[k] * scale * 2; // one-sided
  }
  return { freqs, psd };
}

function mean(arr, start, len) {
  let s = 0;
  for (let i = 0; i < len; i++) s += arr[start + i];
  return s / len;
}

function bandPower(freqs, psd, lo, hi) {
  let p = 0;
  let n = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= lo && freqs[i] <= hi) {
      p += psd[i];
      n++;
    }
  }
  return n > 0 ? p / n : 0; // average power in band
}

// SFDR: ratio (dB) between the fundamental/highest peak and the
// next-largest spurious peak in the spectrum (excluding DC and
// excluding bins immediately adjacent to the fundamental).
function computeSFDR(freqs, psd, minFreq) {
  let maxIdx = -1, maxVal = -Infinity;
  for (let i = 0; i < psd.length; i++) {
    if (freqs[i] < minFreq) continue;
    if (psd[i] > maxVal) { maxVal = psd[i]; maxIdx = i; }
  }
  if (maxIdx === -1) return { sfdrDb: null, fundamentalHz: null, spurHz: null };

  let spurIdx = -1, spurVal = -Infinity;
  const guard = 2; // ignore bins right next to the fundamental
  for (let i = 0; i < psd.length; i++) {
    if (freqs[i] < minFreq) continue;
    if (Math.abs(i - maxIdx) <= guard) continue;
    if (psd[i] > spurVal) { spurVal = psd[i]; spurIdx = i; }
  }

  if (spurIdx === -1 || spurVal <= 0 || maxVal <= 0) {
    return { sfdrDb: null, fundamentalHz: freqs[maxIdx], spurHz: null };
  }

  const sfdrDb = 10 * Math.log10(maxVal / spurVal);
  return { sfdrDb, fundamentalHz: freqs[maxIdx], spurHz: freqs[spurIdx] };
}

const BANDS = {
  delta: [0.5, 4],
  theta: [4, 8],
  alpha: [8, 13],
  mu: [8, 13],      // motor imagery: mu rhythm mirrors alpha range, over sensorimotor cortex
  beta: [13, 30],
  gamma: [30, 45],
};

onmessage = function (e) {
  const { type, payload } = e.data;

  if (type === "analyze") {
    const { channels, fs, segLen, requestId } = payload;
    // channels: { chIndex: Float32Array }
    const results = {};

    for (const chIndexStr of Object.keys(channels)) {
      const signal = channels[chIndexStr];
      if (!signal || signal.length < 16) continue;

      const { freqs, psd } = welchPSD(signal, fs, segLen);
      const bands = {};
      for (const name of Object.keys(BANDS)) {
        const [lo, hi] = BANDS[name];
        bands[name] = bandPower(freqs, psd, lo, hi);
      }
      const sfdr = computeSFDR(freqs, psd, 1); // ignore below 1Hz (DC/drift)

      results[chIndexStr] = {
        freqs: Array.from(freqs),
        psd: Array.from(psd),
        bands,
        sfdr,
      };
    }

    postMessage({ type: "analysisResult", requestId, results });
  }
};
