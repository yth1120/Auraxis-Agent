/* Fake TCP JSON-RPC server for @auraxis/sdk client tests.
 * Prints AURAXIS_SDK_PORT=<port> on stdout (same contract as the runtime). */
const net = require('net');

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
        );
        continue;
      }
      const reply = (result) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
      const fail = (code, message) =>
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } })}\n`);
      switch (req.method) {
        case 'ping':
          reply({ pong: true, time: 1 });
          break;
        case 'agent.run':
          if (!req.params || typeof req.params.prompt !== 'string' || !req.params.prompt.trim()) {
            fail(-32602, 'prompt 必填');
          } else {
            reply({ ran: req.params.prompt, description: req.params.description || null });
          }
          break;
        case 'session.search':
          reply({ query: req.params.query, count: 0, results: [] });
          break;
        case 'hang':
          break; // deliberately never reply — exercises the client timeout
        default:
          fail(-32601, `未知方法: ${req.method}`);
      }
    }
  });
  socket.on('error', () => {});
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`AURAXIS_SDK_PORT=${server.address().port}\n`);
});
