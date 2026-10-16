/** Splits a byte stream (ffmpeg MJPEG, a multipart HTTP body) into complete JPEG images. */

/** A stream that never closes a frame within this much data is not JPEG: start over. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class JpegSplitter {
  private chunks: Buffer[] = [];
  private length = 0;
  /** where the current frame starts in the joined buffer, -1 = not found yet */
  private start = -1;
  /** how far the joined buffer has been searched for the end marker */
  private scanned = 0;

  constructor(private readonly onFrame: (jpeg: Buffer) => void) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    let buf = this.joined();
    for (;;) {
      if (this.start < 0) {
        const s = indexOfPair(buf, 0xff, 0xd8, this.scanned);
        if (s < 0) {
          // keep a trailing 0xFF: it may be the first half of a start marker split across chunks
          this.reset(buf[buf.length - 1] === 0xff ? buf.subarray(buf.length - 1) : null);
          return;
        }
        this.start = s;
        this.scanned = s + 2;
      }
      const e = indexOfPair(buf, 0xff, 0xd9, Math.max(this.scanned, this.start + 2));
      if (e < 0) {
        // the last byte may be half of the end marker: rescan it next time
        this.scanned = Math.max(this.start + 2, buf.length - 1);
        if (buf.length - this.start > MAX_FRAME_BYTES) this.reset(null);
        else if (this.start > 0) this.keepFrom(buf, this.start);
        return;
      }
      this.onFrame(Buffer.from(buf.subarray(this.start, e + 2)));
      const rest = buf.subarray(e + 2);
      this.start = -1;
      this.scanned = 0;
      if (!rest.length) {
        this.reset(null);
        return;
      }
      this.chunks = [rest];
      this.length = rest.length;
      buf = rest;
    }
  }

  private joined(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0];
  }

  private keepFrom(buf: Buffer, at: number): void {
    const rest = buf.subarray(at);
    this.chunks = [rest];
    this.length = rest.length;
    this.scanned -= at;
    this.start = 0;
  }

  private reset(keep: Buffer | null): void {
    this.chunks = keep ? [Buffer.from(keep)] : [];
    this.length = keep?.length ?? 0;
    this.start = -1;
    this.scanned = 0;
  }
}

function indexOfPair(buf: Buffer, a: number, b: number, from: number): number {
  for (let i = buf.indexOf(a, from); i >= 0 && i < buf.length - 1; i = buf.indexOf(a, i + 1)) {
    if (buf[i + 1] === b) return i;
  }
  return -1;
}
