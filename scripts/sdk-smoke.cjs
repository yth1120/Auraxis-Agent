'use strict';

const path = require('path');

let stderrLines = [];

async function main() {
  const sdk = require(path.join(__dirname, '..', 'packages', 'auraxis-sdk', 'dist', 'index.js'));
  let client;
  stderrLines = [];

  try {
    client = await sdk.createAuraxis({
      spawnTimeoutMs: 30_000,
      requestTimeoutMs: 5_000,
      onStderr: (line) => {
        stderrLines.push(line);
        if (process.env.AURAXIS_SDK_SMOKE_DEBUG === '1') {
          process.stderr.write(`[sdk-runtime] ${line}\n`);
        }
      },
    });

    const pong = await client.ping();
    if (!pong || pong.pong !== true) {
      throw new Error(`unexpected ping result: ${JSON.stringify(pong)}`);
    }
    console.log(`SDK live smoke OK: ${JSON.stringify(pong)}`);
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  const detail = error && typeof error.stack === 'string' ? error.stack : String(error);
  const stderrDetail = stderrLines.length > 0 ? `\nRuntime stderr:\n${stderrLines.join('')}` : '';
  console.error(`SDK live smoke failed: ${detail}${stderrDetail}`);
  process.exitCode = 1;
});
