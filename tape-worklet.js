// Tape noise & wear: pink tape hiss (fades in only while audio is playing),
// occasional dropouts (brief level dips from worn oxide), faint static ticks (side B),
// and reports the input level so the popup can spin the reels.

class Tape extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hiss = 0.4; this.drop = 0.15; this.crackle = 0;
    this.hissGain = 0;
    this.pink = [new Float32Array(7), new Float32Array(7)];
    this.hp = [0, 0]; this.hpx = [0, 0]; this.lp = [0, 0];
    this.dropGain = 1; this.dropTarget = 1; this.dropLeft = 0;
    this.untilDrop = this.nextDropIn();
    this.tick = 0; this.tickLp = [0, 0];
    this.sumSq = 0; this.count = 0; this.reportEvery = Math.round(sampleRate / 20);
    // one-pole coefficients
    this.aHp = Math.exp((-2 * Math.PI * 700) / sampleRate);
    this.aLp = Math.exp((-2 * Math.PI * 9000) / sampleRate);
    this.aTick = Math.exp((-2 * Math.PI * 2500) / sampleRate);
    this.hold = 0; this.holdLen = Math.round(0.5 * sampleRate);
    this.hissUp = 1 - Math.exp(-1 / (0.25 * sampleRate));
    this.hissDown = 1 - Math.exp(-1 / (0.35 * sampleRate));
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }

  nextDropIn() { return Math.round(sampleRate * (6 + Math.random() * 14)); }

  pinkSample(c) { // Paul Kellet's refined pink noise
    const b = this.pink[c], w = Math.random() * 2 - 1;
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.96900 * b[2] + w * 0.1538520; b[3] = 0.86650 * b[3] + w * 0.3104856;
    b[4] = 0.55000 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.0168980;
    const p = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362; b[6] = w * 0.115926;
    return p * 0.11;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length, chs = out.length;
    const hissLevel = 0.02 * this.hiss * this.hiss + 0.004 * this.hiss; // ~ -44 dBFS at 0.4

    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < chs; c++) {
        const x = inp && inp[c] ? inp[c][i] : (inp && inp[0] ? inp[0][i] : 0);
        const a = x < 0 ? -x : x; if (a > peak) peak = a;
        this.sumSq += x * x;
      }
      this.count++;
      if (peak > 3e-4) this.hold = this.holdLen; else if (this.hold > 0) this.hold--;
      const playing = this.hold > 0 ? 1 : 0;
      this.hissGain += (playing - this.hissGain) * (playing > this.hissGain ? this.hissUp : this.hissDown);

      // dropouts
      if (playing && this.drop > 0 && --this.untilDrop <= 0) {
        this.dropTarget = 1 - this.drop * (0.25 + Math.random() * 0.35);
        this.dropLeft = Math.round(sampleRate * (0.05 + Math.random() * 0.15));
        this.untilDrop = this.nextDropIn();
      }
      if (this.dropLeft > 0 && --this.dropLeft === 0) this.dropTarget = 1;
      this.dropGain += (this.dropTarget - this.dropGain) * 0.002;

      // static ticks
      if (playing && this.crackle > 0 && Math.random() < this.crackle * 0.00012) this.tick = (Math.random() * 2 - 1) * 0.05 * this.crackle;

      for (let c = 0; c < chs; c++) {
        const x = inp && inp[c] ? inp[c][i] : (inp && inp[0] ? inp[0][i] : 0);
        const k = c & 1;
        // band-limit the pink noise like real tape hiss (~700 Hz – 9 kHz)
        const p = this.pinkSample(k);
        const h = this.aHp * (this.hp[k] + p - this.hpx[k]); this.hpx[k] = p; this.hp[k] = h;
        this.lp[k] = (1 - this.aLp) * h + this.aLp * this.lp[k];
        this.tickLp[k] = (1 - this.aTick) * this.tick + this.aTick * this.tickLp[k];
        out[c][i] = x * this.dropGain + this.lp[k] * hissLevel * this.hissGain * 4 + this.tickLp[k];
      }
      this.tick *= 0.6;
    }

    if (this.count >= this.reportEvery) {
      this.port.postMessage({ rms: Math.sqrt(this.sumSq / (this.count * chs)) });
      this.sumSq = 0; this.count = 0;
    }
    return true;
  }
}

registerProcessor('cassette-tape', Tape);
