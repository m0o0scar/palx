const encoder = new TextEncoder();

export function jsonLine(value: unknown) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export function streamHeaders(contentType = 'application/x-ndjson; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
  };
}

export function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
  };
}

export function sseEvent(name: string, payload: unknown) {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected server error.';
}
