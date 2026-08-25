/* 钩子协议 fixture: reads payload from stdin and
 * answers with the official JSON decision envelope. */
let input = '';
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    /* ignore */
  }
  process.stdout.write(
    `${JSON.stringify({
      decision: 'allow',
      continue: false,
      stopReason: '用户取消',
      additionalContext: `来自 hook: ${String(payload.prompt || '')}`,
    })}\n`,
  );
});
