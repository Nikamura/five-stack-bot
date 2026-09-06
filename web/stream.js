/** Incremental SSE decoder; handles UTF-8/chunk boundaries, CRLF, comments and multiline data. */
export class EventDecoder {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.name = '';
    this.data = [];
  }

  push(text) {
    this.buffer += text;
    if (this.buffer.length > 1_000_000) throw new Error('Live update is too large.');
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!line) {
        if (this.data.length) this.onEvent(this.name || 'message', this.data.join('\n'));
        this.name = '';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') this.name = value;
        if (field === 'data') this.data.push(value);
      }
    }
  }
}
