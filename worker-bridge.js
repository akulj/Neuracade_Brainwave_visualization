// ==================================================================
// Neuracade EEG Dashboard — main thread logic
//
// PERFORMANCE DESIGN (this is the part that fixes the original hang):
//   1. Serial read loop ONLY writes numbers into typed-array ring
//      buffers. It never touches the DOM or a chart.
//   2. A single requestAnimationFrame loop, throttled to ~30fps,
//      pulls a chronological snapshot out of the ring buffers and
//      calls uPlot.setData(). It only updates the plots belonging
//      to the TAB THAT IS CURRENTLY VISIBLE — hidden tabs don't cost
//      anything.
//   3. FFT / Welch PSD / SFDR / band power are computed in worker.js
//      (a real Web Worker thread), on a plain timer (not every
//      frame). Results come back as small JSON payloads and are
//      applied directly — this is cheap even though the FFT itself
//      is not.
//   4. uPlot (canvas, no virtual DOM) is used everywhere instead of
//      Chart.js, which was the main source of the slowdown when
//      multiple charts + heavy math shared the main thread.
// ==================================================================

const CHANNELS = 8;
const HISTORY_SECONDS = 10;
const DRAW_FPS = 30;
const FRAME_TIME = 1000 / DRAW_FPS;

const COLORS = ['#e15b5b','#5eead4','#59c98b','#c084fc','#f0a868','#60a5fa','#f472b6','#a3e635'];

let FS = parseInt(document.getElementById('fsInput').value, 10) || 250;
let BUFFER_SIZE = FS * HISTORY_SECONDS;

// ---------------- channel naming (persisted) ----------------
const defaultNames = Array.from({length: CHANNELS}, (_, i) => `CH${i+1}`);
let channelNames = JSON.parse(localStorage.getItem('eeg_channel_names') || 'null') || defaultNames.slice();
function saveChannelNames(){ localStorage.setItem('eeg_channel_names', JSON.stringify(channelNames)); }

// ---------------- ring buffers ----------------
let ringBuffers = [];
let xData = new Float32Array(BUFFER_SIZE);
function initBuffers(){
  ringBuffers = [];
  BUFFER_SIZE = FS * HISTORY_SECONDS;
  xData = new Float32Array(BUFFER_SIZE);
  for(let i=0;i<BUFFER_SIZE;i++) xData[i] = i / FS;
  for(let c=0;c<CHANNELS;c++){
    ringBuffers.push({ data: new Float32Array(BUFFER_SIZE), writeIndex: 0, filled:false });
  }
}
initBuffers();

function pushSample(ch, value){
  const rb = ringBuffers[ch];
  rb.data[rb.writeIndex] = value;
  rb.writeIndex++;
  if(rb.writeIndex >= BUFFER_SIZE){ rb.writeIndex = 0; rb.filled = true; }
}

// chronological snapshot of the full ring buffer
function snapshotFull(ch, out){
  const rb = ringBuffers[ch];
  const idx = rb.writeIndex;
  out.set(rb.data.subarray(idx), 0);
  out.set(rb.data.subarray(0, idx), BUFFER_SIZE - idx);
  return out;
}

// chronological snapshot of the last nSamples (<=BUFFER_SIZE)
function snapshotLast(ch, nSamples){
  const rb = ringBuffers[ch];
  nSamples = Math.min(nSamples, BUFFER_SIZE);
  const out = new Float32Array(nSamples);
  // absolute index of the most recently written sample is writeIndex-1
  let start = rb.writeIndex - nSamples;
  if(start >= 0){
    out.set(rb.data.subarray(start, rb.writeIndex));
  } else {
    const wrap = BUFFER_SIZE + start;
    out.set(rb.data.subarray(wrap), 0);
    out.set(rb.data.subarray(0, rb.writeIndex), BUFFER_SIZE - wrap);
  }
  return out;
}

// ---------------- display buffers (reused, chronological) ----------------
const displayBuffers = Array.from({length: CHANNELS}, () => new Float32Array(BUFFER_SIZE));
function updateDisplayBuffer(ch){ snapshotFull(ch, displayBuffers[ch]); }

// ==================================================================
// Serial connection
// ==================================================================
let port, reader, keepReading = false, isPaused = false;

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const pauseBtn = document.getElementById('pauseBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

function setStatus(connected){
  statusDot.classList.toggle('on', connected);
  statusText.textContent = connected ? 'Connected' : 'Disconnected';
}

connectBtn.addEventListener('click', async () => {
  if(!('serial' in navigator)){
    alert('Web Serial API not available. Use Chrome/Edge over http://localhost or https://, not file://.');
    return;
  }
  try{
    FS = parseInt(document.getElementById('fsInput').value, 10) || 250;
    initBuffers();
    rebuildAllCharts();

    port = await navigator.serial.requestPort();
    const baud = parseInt(document.getElementById('baudInput').value, 10) || 115200;
    await port.open({ baudRate: baud });

    try{ writer = port.writable.getWriter(); }catch(e){ writer = null; }
    controlSampleIdx = 0;
    gestureDetector = new GestureDetector({ fs: FS });
    refreshTierTable();

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    pauseBtn.disabled = false;
    keepReading = true;
    setStatus(true);
    readSerialData();
    startAnalysisTimer();
  }catch(err){
    console.error('Serial connect error:', err);
    alert('Could not open serial port: ' + err.message);
  }
});

disconnectBtn.addEventListener('click', async () => {
  keepReading = false;
  stopAnalysisTimer();
  try{ if(writer){ writer.releaseLock(); } }catch(e){}
  writer = null;
  try{ if(reader){ await reader.cancel(); } }catch(e){}
  try{ if(port){ await port.close(); } }catch(e){}
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  pauseBtn.disabled = true;
  setStatus(false);
});

pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
});

async function readSerialData(){
  const textDecoder = new TextDecoderStream();
  port.readable.pipeTo(textDecoder.writable).catch(()=>{});
  reader = textDecoder.readable.getReader();
  let buffer = '';
  try{
    while(keepReading){
      const { value, done } = await reader.read();
      if(done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for(const line of lines){
        parseLine(line);
      }
    }
  }catch(err){
    console.error('Serial read error:', err);
  }finally{
    try{ reader.releaseLock(); }catch(e){}
  }
}

// Accepts "ch1 ch2 ... ch8", comma separated, or "1.2,3.4 ...".
// Also strips Arduino "12:34:56.789 -> " style timestamp prefixes,
// and tolerates "name:value" tokens from the Arduino IDE 2.x plotter.
function parseLine(rawLine){
  let line = rawLine.trim();
  if(!line) return;
  if(line.includes('->')) line = line.split('->').pop().trim();

  const parts = line.split(/[\s,]+/).filter(Boolean);
  if(parts.length < CHANNELS) return;

  const values = new Array(CHANNELS);
  for(let i=0;i<CHANNELS;i++){
    let tok = parts[i];
    if(tok.includes(':')) tok = tok.split(':').pop();
    const v = parseFloat(tok);
    if(Number.isNaN(v)) return; // drop malformed line entirely
    values[i] = v;
  }
  for(let i=0;i<CHANNELS;i++) pushSample(i, values[i]);

  // gesture detector runs per-sample here too — it's O(1) work (a few
  // multiplies), so it costs nothing extra on top of the ring-buffer
  // writes above, unlike FFT/PSD which is batched in the worker instead.
  controlSampleIdx++;
  const controlCh = parseInt(document.getElementById('controlChannelSel').value, 10) || 0;
  const gResult = gestureDetector.processSample(values[controlCh], (controlSampleIdx / FS) * 1000);
  pushRatioHistory(gResult.ratio);
  if(gResult.event) handleGestureEvent(gResult.event);
}

// ==================================================================
// Tabs
// ==================================================================
let activeTab = 'individual';
document.querySelectorAll('nav.tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs .tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    document.getElementById('panel-' + activeTab).classList.add('active');
    requestAnimationFrame(() => resizeChartsForActiveTab());
  });
});

// ==================================================================
// uPlot chart builders
// ==================================================================
const individualCharts = [];
let combinedChart = null;
const spectrumCharts = {}; // keyed by channel index, created on demand

function baseOpts(width, height, extra){
  return Object.assign({
    width, height,
    scales: { x: { time:false } },
    cursor: { drag: { x:true, y:false } },
    legend: { show: false },
    axes: [
      { stroke:'#7c8aa5', grid:{stroke:'#232937'} },
      { stroke:'#7c8aa5', grid:{stroke:'#232937'} },
    ],
  }, extra);
}

function buildIndividualGrid(){
  const grid = document.getElementById('individualGrid');
  grid.innerHTML = '';
  individualCharts.length = 0;

  for(let c=0;c<CHANNELS;c++){
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3>
        <input class="chname" data-ch="${c}" value="${channelNames[c]}">
        <span class="val" id="liveval-${c}">—</span>
      </h3>
      <div id="indiv-plot-${c}"></div>
    `;
    grid.appendChild(card);

    const holder = card.querySelector(`#indiv-plot-${c}`);
    const width = holder.clientWidth > 0 ? holder.clientWidth : 320;
    
    const chart = new uPlot(baseOpts(width, 140, {
      series: [ {}, { stroke: COLORS[c], width:1.5, points:{show:false} } ],
    }), [xData, displayBuffers[c]], holder);
    individualCharts.push(chart);

    holder.addEventListener('dblclick', () => exportChannelCSV(c));
  }

  grid.querySelectorAll('input.chname').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = parseInt(inp.dataset.ch, 10);
      channelNames[idx] = inp.value || defaultNames[idx];
      saveChannelNames();
      refreshChannelSelectors();
    });
  });
}

function buildCombinedChart(){
  const holder = document.getElementById('combinedPlot');
  holder.innerHTML = '';
  const width = Math.max(600, holder.clientWidth || 1100);
  const series = [{}];
  for(let c=0;c<CHANNELS;c++){
    series.push({ stroke: COLORS[c], width:1.3, points:{show:false}, label: channelNames[c] });
  }
  combinedChart = new uPlot(baseOpts(width, 420, {
    series,
    legend: { show:true },
  }), [xData, ...displayBuffers], holder);

  holder.addEventListener('dblclick', () => exportCombinedCSV());

  const toggle = document.getElementById('combinedToggle');
  toggle.innerHTML = '';
  for(let c=0;c<CHANNELS;c++){
    const lbl = document.createElement('label');
    lbl.className = 'on';
    lbl.innerHTML = `<span class="swatch" style="background:${COLORS[c]}"></span><span class="cname">${channelNames[c]}</span>`;
    lbl.addEventListener('click', () => {
      const on = lbl.classList.toggle('on');
      combinedChart.setSeries(c+1, { show: on });
    });
    toggle.appendChild(lbl);
  }
}

function rebuildAllCharts(){
  buildIndividualGrid();
  buildCombinedChart();
  clearSpectrumCharts();
  refreshChannelSelectors();
}

function resizeChartsForActiveTab(){
  if(activeTab === 'individual'){
    individualCharts.forEach((ch,c) => {
      const holder = document.getElementById(`indiv-plot-${c}`);
      if(holder) ch.setSize({ width: holder.clientWidth, height: 140 });
    });
  } else if(activeTab === 'combined' && combinedChart){
    const holder = document.getElementById('combinedPlot');
    combinedChart.setSize({ width: holder.clientWidth, height: 420 });
  } else if(activeTab === 'control' && ratioChart){
    const holder = document.getElementById('ratioPlot');
    ratioChart.setSize({ width: holder.clientWidth, height: 160 });
  }
}
window.addEventListener('resize', () => resizeChartsForActiveTab());

// ==================================================================
// Draw loop — decoupled from serial reads, throttled, tab-aware
// ==================================================================
  
 let lastDraw = 0;
let liveValIdx = 0;
function drawLoop(ts){
  if(ts - lastDraw >= FRAME_TIME){
    lastDraw = ts;

    if(activeTab === 'individual'){
      for(let c=0;c<CHANNELS;c++){
        updateDisplayBuffer(c);
        if(individualCharts[c]){
          individualCharts[c].setData(displayBuffers[c], false); // Pass just y-data array since xData is shared or bound
          individualCharts[c].redraw();
        }
      }
      const rb = ringBuffers[liveValIdx % CHANNELS];
      const lastIdx = (rb.writeIndex - 1 + BUFFER_SIZE) % BUFFER_SIZE;
      const el = document.getElementById(`liveval-${liveValIdx % CHANNELS}`);
      if(el) el.textContent = rb.data[lastIdx].toFixed(2);
      liveValIdx++;
    } else if(activeTab === 'combined' && combinedChart){
      for(let c=0;c<CHANNELS;c++) updateDisplayBuffer(c);
      // Pass the full multi-series array and force a redraw so it updates without needing a button toggle
      combinedChart.setData([xData, ...displayBuffers], false);
      combinedChart.redraw();
    }
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);
    // spectrum & motor tabs are updated only when worker results arrive —
    // no per-frame cost there at all.
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);

// ==================================================================
// Channel selection (used by Spectrum + Motor tabs)
// ==================================================================
let selectedForAnalysis = new Set([0,1,2,3]); // default first 4 to keep worker load light

function refreshChannelSelectors(){
  const toggle = document.getElementById('spectrumToggle');
  toggle.innerHTML = '';
  for(let c=0;c<CHANNELS;c++){
    const lbl = document.createElement('label');
    if(selectedForAnalysis.has(c)) lbl.classList.add('on');
    lbl.innerHTML = `<span class="swatch" style="background:${COLORS[c]}"></span><span>${channelNames[c]}</span>`;
    lbl.addEventListener('click', () => {
      if(selectedForAnalysis.has(c)){ selectedForAnalysis.delete(c); }
      else { selectedForAnalysis.add(c); }
      lbl.classList.toggle('on');
      clearSpectrumCharts();
    });
    toggle.appendChild(lbl);
  }

  // asymmetry selectors
  const left = document.getElementById('asymLeftSel');
  const right = document.getElementById('asymRightSel');
  const prevLeft = left.value, prevRight = right.value;
  left.innerHTML = ''; right.innerHTML = '';
  for(let c=0;c<CHANNELS;c++){
    const o1 = document.createElement('option'); o1.value=c; o1.textContent=channelNames[c];
    const o2 = o1.cloneNode(true);
    left.appendChild(o1); right.appendChild(o2);
  }
  left.value = prevLeft !== '' ? prevLeft : 0;
  right.value = prevRight !== '' ? prevRight : Math.min(1, CHANNELS-1);
}
refreshChannelSelectors();

function clearSpectrumCharts(){
  const grid = document.getElementById('spectrumGrid');
  grid.innerHTML = '';
  for(const k in spectrumCharts) delete spectrumCharts[k];
}

function ensureSpectrumChart(c){
  if(spectrumCharts[c]) return spectrumCharts[c];
  const grid = document.getElementById('spectrumGrid');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h3>${channelNames[c]} — PSD</h3><div id="spec-plot-${c}"></div>`;
  grid.appendChild(card);
  const holder = card.querySelector(`#spec-plot-${c}`);
  const width = Math.max(280, holder.clientWidth || 320);
  const chart = new uPlot(baseOpts(width, 160, {
    scales: { x:{ time:false, range:[0,60] } },
    series: [ {}, { stroke: COLORS[c], width:1.5, points:{show:false} } ],
  }), [[0,1],[0,0]], holder);
  spectrumCharts[c] = chart;
  return chart;
}

// ==================================================================
// Web Worker — FFT / Welch PSD / SFDR / band power
// ==================================================================
const analysisWorker = new Worker('worker.js');
let analysisTimer = null;
let requestId = 0;

function startAnalysisTimer(){
  stopAnalysisTimer();
  scheduleNextAnalysis();
}
function stopAnalysisTimer(){
  if(analysisTimer) clearTimeout(analysisTimer);
  analysisTimer = null;
}
function scheduleNextAnalysis(){
  const intervalMs = parseInt(document.getElementById('fftIntervalInput').value, 10) || 1000;
  analysisTimer = setTimeout(runAnalysisCycle, intervalMs);
}

function runAnalysisCycle(){
  if(!keepReading){ scheduleNextAnalysis(); return; }
  const windowSec = parseFloat(document.getElementById('fftWindowInput').value) || 5;
  const nSamples = Math.max(16, Math.round(windowSec * FS));

  const channels = {};
  selectedForAnalysis.forEach(c => {
    channels[c] = snapshotLast(c, nSamples);
  });

  if(Object.keys(channels).length === 0){ scheduleNextAnalysis(); return; }

  const id = ++requestId;
  // Float32Array copies are small (a few KB) — fine to structured-clone.
  analysisWorker.postMessage({
    type: 'analyze',
    payload: { channels, fs: FS, segLen: Math.min(1024, nSamples), requestId: id }
  });
}

analysisWorker.onmessage = (e) => {
  const { type, results } = e.data;
  if(type !== 'analysisResult') return;
  applySpectrumResults(results);
  scheduleNextAnalysis();
};

function applySpectrumResults(results){
  // ---- Spectrum tab: PSD plots + SFDR table ----
  const sfdrBody = document.getElementById('sfdrTableBody');
  sfdrBody.innerHTML = '';

  for(const chStr of Object.keys(results)){
    const c = parseInt(chStr, 10);
    const r = results[chStr];
    const chart = ensureSpectrumChart(c);
    chart.setData([r.freqs, r.psd], true);

    const row = document.createElement('tr');
    const fund = r.sfdr.fundamentalHz != null ? r.sfdr.fundamentalHz.toFixed(2) : '—';
    const spur = r.sfdr.spurHz != null ? r.sfdr.spurHz.toFixed(2) : '—';
    const sfdrVal = r.sfdr.sfdrDb != null ? r.sfdr.sfdrDb.toFixed(1) + ' dB' : '—';
    row.innerHTML = `<td>${channelNames[c]}</td><td class="mono">${fund}</td><td class="mono">${spur}</td><td class="mono">${sfdrVal}</td>`;
    sfdrBody.appendChild(row);
  }

  // ---- Motor Imagery tab: band bars + asymmetry ----
  renderMotorBands(results);
}

function renderMotorBands(results){
  const container = document.getElementById('motorBands');
  container.innerHTML = '';
  const chans = Object.keys(results).map(Number).sort((a,b)=>a-b);
  if(chans.length === 0){
    container.innerHTML = '<p class="hint">Select channels on the Spectrum tab to see band power here.</p>';
  }
  let maxMu = 1e-12, maxBeta = 1e-12;
  chans.forEach(c => {
    maxMu = Math.max(maxMu, results[c].bands.mu);
    maxBeta = Math.max(maxBeta, results[c].bands.beta);
  });

  chans.forEach(c => {
    const mu = results[c].bands.mu, beta = results[c].bands.beta;
    const row = document.createElement('div');
    row.innerHTML = `
      <div style="margin:10px 0 2px;font-size:12px;color:var(--dim);">${channelNames[c]}</div>
      <div class="bandbar-row">
        <div class="mono" style="font-size:11px;">mu 8–13Hz</div>
        <div class="bandbar-track"><div class="bandbar-fill" style="width:${(mu/maxMu*100).toFixed(1)}%"></div></div>
        <div class="mono" style="font-size:11px;">${mu.toExponential(1)}</div>
      </div>
      <div class="bandbar-row">
        <div class="mono" style="font-size:11px;">beta 13–30Hz</div>
        <div class="bandbar-track"><div class="bandbar-fill" style="width:${(beta/maxBeta*100).toFixed(1)}%"></div></div>
        <div class="mono" style="font-size:11px;">${beta.toExponential(1)}</div>
      </div>
    `;
    container.appendChild(row);
  });

  // asymmetry readout
  const leftC = parseInt(document.getElementById('asymLeftSel').value, 10);
  const rightC = parseInt(document.getElementById('asymRightSel').value, 10);
  const readout = document.getElementById('asymReadout');
  if(results[leftC] && results[rightC]){
    const l = results[leftC].bands.mu, r = results[rightC].bands.mu;
    const asym = (l - r) / (l + r || 1e-12);
    readout.textContent = asym.toFixed(3);
  } else {
    readout.textContent = 'select both channels on Spectrum tab';
  }
}

document.getElementById('asymLeftSel').addEventListener('change', () => {});
document.getElementById('asymRightSel').addEventListener('change', () => {});
document.getElementById('fftWindowInput').addEventListener('change', clearSpectrumCharts);

// ==================================================================
// CSV export
// ==================================================================
function downloadCSV(filename, headerCols, rows){
  const lines = [headerCols.join(',')];
  for(const row of rows) lines.push(row.join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportChannelCSV(c){
  updateDisplayBuffer(c);
  const rows = [];
  for(let i=0;i<BUFFER_SIZE;i++) rows.push([xData[i].toFixed(4), displayBuffers[c][i]]);
  downloadCSV(`${channelNames[c]}_window.csv`, ['time_s', channelNames[c]], rows);
}

function exportCombinedCSV(){
  for(let c=0;c<CHANNELS;c++) updateDisplayBuffer(c);
  const rows = [];
  for(let i=0;i<BUFFER_SIZE;i++){
    rows.push([xData[i].toFixed(4), ...displayBuffers.map(buf => buf[i])]);
  }
  downloadCSV('all_channels_window.csv', ['time_s', ...channelNames], rows);
}

document.getElementById('exportAllBtn').addEventListener('click', exportCombinedCSV);
document.getElementById('exportCombinedBtn').addEventListener('click', exportCombinedCSV);

// ==================================================================
// Gesture Control — real-time toe/ankle/leg burst detector
// ==================================================================
let writer = null;
let controlSampleIdx = 0;
let gestureDetector = new GestureDetector({ fs: FS });

// populate the control-channel dropdown (reuses channel names)
function refreshControlChannelSelect(){
  const sel = document.getElementById('controlChannelSel');
  const prev = sel.value;
  sel.innerHTML = '';
  for(let c=0;c<CHANNELS;c++){
    const o = document.createElement('option');
    o.value = c; o.textContent = channelNames[c];
    sel.appendChild(o);
  }
  sel.value = prev !== '' ? prev : 0;
}
refreshControlChannelSelect();
const _origRefreshChannelSelectors = refreshChannelSelectors;
refreshChannelSelectors = function(){ _origRefreshChannelSelectors(); refreshControlChannelSelect(); };

// ---- ratio strip chart (rolling history, downsampled) ----
const RATIO_HIST_LEN = 300; // ~30s at 10Hz push rate
const ratioHistX = new Float32Array(RATIO_HIST_LEN);
const ratioHistY = new Float32Array(RATIO_HIST_LEN);
for(let i=0;i<RATIO_HIST_LEN;i++) ratioHistX[i] = i;
let ratioWriteIdx = 0, ratioPushCounter = 0;
let ratioChart = null;

function buildRatioChart(){
  const holder = document.getElementById('ratioPlot');
  holder.innerHTML = '';
  const width = Math.max(280, holder.clientWidth || 500);
  ratioChart = new uPlot(baseOpts(width, 160, {
    scales: { x:{ time:false } },
    series: [ {}, { stroke: '#5eead4', width:1.5, points:{show:false} } ],
  }), [ratioHistX, ratioHistY], holder);
}

function pushRatioHistory(ratio){
  // downsample to ~10Hz so the chart isn't fed at 250Hz for nothing
  ratioPushCounter++;
  const everyN = Math.max(1, Math.round(FS / 10));
  if(ratioPushCounter % everyN !== 0) return;
  ratioHistY[ratioWriteIdx] = ratio;
  ratioWriteIdx = (ratioWriteIdx + 1) % RATIO_HIST_LEN;
  document.getElementById('liveRatio').textContent = ratio.toFixed(2);
  document.getElementById('liveState').textContent = gestureDetector.state;
}

function chronologicalRatioSnapshot(){
  const out = new Float32Array(RATIO_HIST_LEN);
  out.set(ratioHistY.subarray(ratioWriteIdx), 0);
  out.set(ratioHistY.subarray(0, ratioWriteIdx), RATIO_HIST_LEN - ratioWriteIdx);
  return out;
}

// ---- event log + command dispatch ----
function handleGestureEvent(evt){
  document.getElementById('liveCommand').textContent = evt.command;
  const log = document.getElementById('eventLog');
  const row = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  row.textContent = `[${time}] ${evt.state.toUpperCase()} → ${evt.command}  (ratio ${evt.ratio.toFixed(2)})`;
  log.prepend(row);
  while(log.children.length > 100) log.removeChild(log.lastChild);

  if(document.getElementById('sendCommandsChk').checked && writer){
    writer.write(new TextEncoder().encode(evt.command + '\n')).catch(err => console.error('write error', err));
  }
}

// ---- threshold table ----
function refreshTierTable(){
  const body = document.getElementById('tierTableBody');
  body.innerHTML = '';
  gestureDetector.tiers.forEach(t => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${t.key}</td><td class="mono">${t.enterRatio.toFixed(2)}</td><td class="mono">${t.exitRatio.toFixed(2)}</td><td class="mono">${t.command}</td>`;
    body.appendChild(row);
  });
}
refreshTierTable();

// ---- calibration wizard ----
function setCalibStatus(text){ document.getElementById('calibStatus').textContent = text; }

function runCalibrationStep(tierKey, durationMs, label, nextBtn){
  const btn = { toe: 'calibToeBtn', ankle: 'calibAnkleBtn', leg: 'calibLegBtn', null: 'calibQuietBtn' }[tierKey ?? 'null'];
  document.getElementById(btn).disabled = true;
  let remaining = durationMs;
  setCalibStatus(`${label}: hold for ${(remaining/1000).toFixed(1)}s...`);
  const tick = setInterval(() => {
    remaining -= 100;
    if(remaining > 0) setCalibStatus(`${label}: hold for ${(remaining/1000).toFixed(1)}s...`);
  }, 100);

  gestureDetector.startCalibration(tierKey, durationMs).then(result => {
    clearInterval(tick);
    if(tierKey === null){
      setCalibStatus(`Baseline captured (peak ratio while still: ${result.peakRatio}). Now calibrate each movement.`);
      document.getElementById('calibToeBtn').disabled = false;
    } else {
      const app = result.applied;
      setCalibStatus(`${tierKey} calibrated — peak ratio ${result.peakRatio}, enter=${app.enterRatio}, exit=${app.exitRatio}.`);
      refreshTierTable();
      if(nextBtn) document.getElementById(nextBtn).disabled = false;
    }
  });
}

document.getElementById('calibQuietBtn').addEventListener('click', () => runCalibrationStep(null, 5000, 'Stay still'));
document.getElementById('calibToeBtn').addEventListener('click', () => runCalibrationStep('toe', 4000, 'Wiggle toes', 'calibAnkleBtn'));
document.getElementById('calibAnkleBtn').addEventListener('click', () => runCalibrationStep('ankle', 4000, 'Wiggle ankles', 'calibLegBtn'));
document.getElementById('calibLegBtn').addEventListener('click', () => runCalibrationStep('leg', 4000, 'Move leg', null));

// ==================================================================
// Init
// ==================================================================
rebuildAllCharts();
buildRatioChart();
