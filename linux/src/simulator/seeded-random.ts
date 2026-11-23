export class SeededRandom {
  private state: number;
  private spareGaussian: number | null = null;

  constructor(seed: string | number) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  next(): number {
    let value = this.state += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.state = value >>> 0;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  gaussian(): number {
    if (this.spareGaussian !== null) {
      const spare = this.spareGaussian;
      this.spareGaussian = null;
      return spare;
    }
    const first = Math.max(this.next(), Number.EPSILON);
    const second = this.next();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    this.spareGaussian = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError('length must be a nonnegative safe integer');
    }
    return Uint8Array.from({ length }, () => Math.floor(this.next() * 256));
  }
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
