/** preload-api.ts — composition of renderer IPC bridges. */
import { createAiApi, createTokenizerApi } from './preload-ai';
import { createCoreApi } from './preload-core';
import { createPlatformApi } from './preload-platform';
import { createRestApi } from './preload-rest';

export function createElectronAPI() {
  return {
    ...createPlatformApi(),
    ...createCoreApi(),
    ...createRestApi(),
    ai: createAiApi(),
    tokenizer: createTokenizerApi(),
  };
}
