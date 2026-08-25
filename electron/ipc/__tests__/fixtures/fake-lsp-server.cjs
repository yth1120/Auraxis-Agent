/**
 * Fake LSP server for lsp-client tests: speaks Content-Length JSON-RPC over
 * stdio and answers initialize + one query per session with canned results.
 */
let buffer = Buffer.alloc(0);

function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(msg) {
  if (msg.id === 1 && msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    return;
  }
  if (msg.method === 'textDocument/didOpen') return;
  if (msg.id === 2) {
    const uri = 'file:///C:/proj/src/app.ts';
    const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } };
    let result;
    if (msg.method === 'textDocument/hover') {
      result = { contents: { kind: 'plaintext', value: 'hover info: App' }, range };
    } else {
      result = [{ uri, range }];
    }
    send({ jsonrpc: '2.0', id: 2, result });
    setTimeout(() => process.exit(0), 30);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const idx = buffer.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const header = buffer.slice(0, idx).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buffer = buffer.slice(idx + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const bodyStart = idx + 4;
    if (buffer.length < bodyStart + len) return;
    const body = buffer.slice(bodyStart, bodyStart + len).toString('utf8');
    buffer = buffer.slice(bodyStart + len);
    try {
      handle(JSON.parse(body));
    } catch {
      /* ignore malformed */
    }
  }
});
