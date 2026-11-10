/** Keep UTF-16 pairs intact even when a provider splits one emoji between JSON deltas. */
export class StreamTextBuffer {
  private pending = '';
  private carry = '';
  get length() { return this.pending.length; }
  append(text: string) {
    let value = this.carry + text; this.carry = '';
    if (/[\uD800-\uDBFF]$/.test(value)) { this.carry = value.slice(-1); value = value.slice(0, -1); }
    for (let index = 0; index < value.length; index++) {
      const c = value.charCodeAt(index);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) throw new Error('Invalid Unicode in model stream');
      } else if (c >= 0xDC00 && c <= 0xDFFF) throw new Error('Invalid Unicode in model stream');
    }
    this.pending += value;
  }
  drain() {
    const chunks: string[] = [];
    while (this.pending) {
      let end = Math.min(2048, this.pending.length);
      if (/[\uD800-\uDBFF]$/.test(this.pending.slice(0, end))) end--;
      chunks.push(this.pending.slice(0, end)); this.pending = this.pending.slice(end);
    }
    return chunks;
  }
  assertComplete() { if (this.carry) throw new Error('Incomplete Unicode in model stream'); }
}
