/** G.711 mu-law at the carrier edge; speech processors use little-endian PCM. */
export function decodeMuLaw(byte: number): number {
  const value = ~byte & 255;
  const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
  return value & 128 ? 132 - magnitude : magnitude - 132;
}

export function encodeMuLaw(sample: number): number {
  const sign = sample < 0 ? 128 : 0;
  const magnitude = Math.min(32635, Math.abs(Math.trunc(sample))) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1)
    exponent--;
  return ~(sign | (exponent << 4) | ((magnitude >> (exponent + 3)) & 15)) & 255;
}

export function pcm24FromMuLaw(bytes: Uint8Array): Uint8Array {
  const pcm = new Uint8Array(bytes.length * 6);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < bytes.length; index++) {
    const sample = decodeMuLaw(bytes[index]!);
    for (let repeat = 0; repeat < 3; repeat++)
      view.setInt16(index * 6 + repeat * 2, sample, true);
  }
  return pcm;
}

/** Downsampling retains partial sample groups across arbitrary HTTP chunks. */
export class MuLawFromPcm24 {
  private pending = new Uint8Array(0);
  append(bytes: Uint8Array): Uint8Array {
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending);
    joined.set(bytes, this.pending.length);
    const count = Math.floor(joined.length / 6);
    const view = new DataView(joined.buffer);
    const result = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      const offset = index * 6;
      result[index] = encodeMuLaw(
        (view.getInt16(offset, true) +
          view.getInt16(offset + 2, true) +
          view.getInt16(offset + 4, true)) /
          3,
      );
    }
    this.pending = joined.slice(count * 6);
    return result;
  }
  finish(): Uint8Array {
    if (this.pending.length % 2)
      throw new Error("Speech PCM ended between samples");
    if (!this.pending.length) return new Uint8Array(0);
    const view = new DataView(this.pending.buffer);
    let total = 0;
    for (let offset = 0; offset < this.pending.length; offset += 2)
      total += view.getInt16(offset, true);
    const result = new Uint8Array([
      encodeMuLaw(total / (this.pending.length / 2)),
    ]);
    this.pending = new Uint8Array(0);
    return result;
  }
}

/** A bounded endpoint detector. It controls turn boundaries only, never
 * identity or agreement. Thresholds must be qualified on the actual line. */
export class VoiceActivity {
  private preRoll: Uint8Array[] = [];
  private voiced = 0;
  private silence = 0;
  private activeSamples = 0;

  constructor(private readonly threshold = 600) {}

  append(frame: Uint8Array): {
    audio: Uint8Array[];
    isStarted: boolean;
    isEnded: boolean;
  } {
    if (frame.length !== 160)
      throw new Error("VAD requires 20 ms carrier frames");
    let energy = 0;
    for (const byte of frame) energy += decodeMuLaw(byte) ** 2;
    const isVoiced = Math.sqrt(energy / frame.length) >= this.threshold;
    if (!this.activeSamples) {
      this.preRoll.push(frame.slice());
      if (this.preRoll.length > 10) this.preRoll.shift();
      this.voiced = isVoiced ? this.voiced + 1 : 0;
      if (this.voiced < 3)
        return { audio: [], isStarted: false, isEnded: false };
      const audio = this.preRoll;
      this.preRoll = [];
      this.activeSamples = audio.length * 160;
      this.silence = 0;
      return { audio, isStarted: true, isEnded: false };
    }
    this.activeSamples += frame.length;
    this.silence = isVoiced ? 0 : this.silence + frame.length;
    const isEnded = this.silence >= 4800 || this.activeSamples >= 160_000;
    if (isEnded) {
      this.activeSamples = 0;
      this.voiced = 0;
      this.silence = 0;
    }
    return { audio: [frame], isStarted: false, isEnded };
  }
}
