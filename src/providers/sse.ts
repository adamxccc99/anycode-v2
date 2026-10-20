// Minimal server-sent-event parser over a fetch body stream.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0 && eventName === undefined) return null;
    const ev: SseEvent = { event: eventName, data: dataLines.join('\n') };
    eventName = undefined;
    dataLines = [];
    if (ev.data === '') return null; // keep-alive / comment only
    return ev;
  };

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      // Process complete lines in the buffer.
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
        } else if (line.startsWith(':')) {
          // comment
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    const ev = flush();
    if (ev) yield ev;
  } finally {
    reader.releaseLock();
  }
}
