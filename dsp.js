// Cassette tape effect chain:
// narrow stereo -> tape saturation -> head bump / HF roll-off -> wow & flutter -> hiss, dropouts, static -> glue compression -> volume

export async function buildCassette(ctx, source, workletUrl, params = {}) {
  await ctx.audioWorklet.addModule(workletUrl);
  const sr = ctx.sampleRate;
  const bq = (type, f, Q, g) => {
    const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f;
    if (Q !== undefined) n.Q.value = Q; if (g !== undefined) n.gain.value = g; return n;
  };
  const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };

  // 1. Narrow the stereo image (cassettes sound smaller / more "distant")
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const ll = gain(0.72), lr = gain(0.28), rl = gain(0.28), rr = gain(0.72);
  source.connect(split);
  split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
  ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);

  // 2. Tape saturation
  const drive = gain(1), shaper = ctx.createWaveShaper(), makeup = gain(1);
  shaper.oversample = '2x';
  const setDrive = (d) => {
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      // slightly asymmetric soft clip = even harmonics, like tape
      curve[i] = Math.tanh(d * (x + 0.08 * x * x)) / Math.tanh(d);
    }
    shaper.curve = curve;
  };

  // 3. Tone: low cut, head bump, gentle mid scoop, high roll-off
  const hp = bq('highpass', 55, 0.7);
  const bump = bq('peaking', 105, 1.1, 3);
  const scoop = bq('peaking', 2500, 0.8, -1.5);
  const lp1 = bq('lowpass', 8000, 0.6), lp2 = bq('lowpass', 8000, 0.7);

  // 4. Wow & flutter: modulated delay
  const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.008;
  const wowSrc = ctx.createBufferSource(), wowDepth = gain(0);
  { // smooth, irregular wow: sum of slow sines with random rates/phases
    const len = Math.round(sr * 37), b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    const parts = [0.31, 0.53, 0.87, 1.4].map((f) => [f * (0.9 + Math.random() * 0.2), Math.random() * 6.28, 1 / f]);
    const norm = parts.reduce((a, p) => a + p[2], 0);
    for (let i = 0; i < len; i++) {
      let v = 0; for (const [f, ph, a] of parts) v += a * Math.sin(2 * Math.PI * f * (i / sr) + ph);
      d[i] = v / norm;
    }
    wowSrc.buffer = b; wowSrc.loop = true;
  }
  const flutter = ctx.createOscillator(); flutter.frequency.value = 6.8;
  const flutterDepth = gain(0);
  wowSrc.connect(wowDepth).connect(delay.delayTime);
  flutter.connect(flutterDepth).connect(delay.delayTime);
  wowSrc.start(); flutter.start();

  // 5. Hiss, dropouts, static (worklet)
  const tape = new AudioWorkletNode(ctx, 'cassette-tape', { outputChannelCount: [2] });
  let level = 0;
  tape.port.onmessage = (e) => { level = e.data.rms; };

  // 6. Glue + volume
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.ratio.value = 2.5; comp.knee.value = 10; comp.attack.value = 0.02; comp.release.value = 0.3;
  const volume = gain(1);

  merge.connect(drive).connect(shaper).connect(makeup).connect(hp).connect(bump).connect(scoop)
    .connect(lp1).connect(lp2).connect(delay).connect(tape).connect(comp).connect(volume);
  const output = volume;

  let enabled = true, dest = null;
  const route = () => {
    if (!dest) return;
    try { output.disconnect(); } catch (e) {}
    try { source.disconnect(dest); } catch (e) {}
    (enabled ? output : source).connect(dest);
  };

  const state = { hiss: 40, wobble: 35, warmth: 50, volume: 70, side: 'A' };
  const set = (p) => {
    Object.assign(state, p);
    const w = state.warmth / 100, wob = state.wobble / 100, side = state.side;
    const fc = 15000 * Math.pow(0.27, w);           // 15 kHz (fresh) -> ~4 kHz (very worn)
    lp1.frequency.value = fc; lp2.frequency.value = fc;
    const d = 1 + w * 2.2; setDrive(d); drive.gain.value = 1; makeup.gain.value = 0.9;
    wowDepth.gain.value = 0.0022 * wob;              // up to ~±0.6% pitch wobble
    flutterDepth.gain.value = 0.00009 * wob * (side === 'B' ? 1.6 : 1);
    tape.port.postMessage({
      hiss: state.hiss / 100,
      drop: side === 'B' ? 0.55 : 0.12 * wob,
      crackle: side === 'B' ? 0.6 : 0,
    });
    volume.gain.value = Math.pow(10, ((state.volume - 70) / 30) * 12 / 20); // 70 = unity, 0..100 = -28..+12 dB
  };
  set(params);

  return {
    connect(d) { dest = d; route(); return this; },
    set,
    setEnabled(on) { enabled = on; route(); },
    get level() { return enabled ? level : level; },
    stop() { try { wowSrc.stop(); flutter.stop(); } catch (e) {} },
  };
}
