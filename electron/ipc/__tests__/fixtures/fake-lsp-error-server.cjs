let buffer = Buffer.alloc(0);

function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
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
    const msg = JSON.parse(body);
    if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    if (msg.id === 2) {
      send({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad request' } });
      setTimeout(() => process.exit(0), 30);
    }
  }
});
