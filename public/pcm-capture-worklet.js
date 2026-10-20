// AudioWorklet for AuraNoteTaker: microphone audio to 16 kHz 16-bit mono, in 100 ms chunks with a level.
// Served from the app's own origin so the Content Security Policy needs no blob: or inline scripts.
// Averages input samples into 16 kHz output (a simple low-pass and resample).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.acc = 0;
    this.accN = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let v = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.sumSq += v * v;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.out.length) {
          const level = Math.min(1, Math.sqrt(this.sumSq / this.n) * 4);
          this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
          this.out = new Int16Array(1600);
          this.n = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
