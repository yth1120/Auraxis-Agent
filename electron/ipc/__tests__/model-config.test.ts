import { describe, it, expect, afterEach, vi } from 'vitest';

// model-config 使用模块级 _cachedEnvModels 缓存，每个测试需要 resetModules
const OLD_ENV = { ...process.env };

afterEach(() => {
  // 恢复环境变量
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, OLD_ENV);
});

function importFresh() {
  return import('../model-config');
}

describe('getProvider', () => {
  it('任意模型 ID 返回 deepseek', async () => {
    vi.resetModules();
    const { getProvider } = await importFresh();
    expect(getProvider('any-model')).toBe('deepseek');
    expect(getProvider('deepseek-v4-flash')).toBe('deepseek');
    expect(getProvider('')).toBe('deepseek');
  });
});

describe('getDefaultApiBase', () => {
  it('默认返回 DeepSeek beta 端点', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    vi.resetModules();
    const { getDefaultApiBase } = await importFresh();
    expect(getDefaultApiBase()).toBe('https://api.deepseek.com/beta/chat/completions');
  });

  it('DEEPSEEK_BASE_URL 环境变量覆盖', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    process.env.DEEPSEEK_BASE_URL = 'https://custom.deepseek.com/v1/chat';
    vi.resetModules();
    const { getDefaultApiBase } = await importFresh();
    expect(getDefaultApiBase()).toBe('https://custom.deepseek.com/v1/chat');
  });
});

describe('resolveApiBase — 自定义模型路由', () => {
  it('无 AURAXIS_MODELS 时使用默认端点', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.AURAXIS_MODELS;
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(resolveApiBase('deepseek-v4-flash')).toBe('https://api.deepseek.com/beta/chat/completions');
  });

  it('AURAXIS_MODELS 中匹配的自定义模型使用自定义 apiBase', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.AURAXIS_MODELS;
    process.env.AURAXIS_MODELS = JSON.stringify([
      { id: 'custom-model', name: 'Custom', apiBase: 'https://custom.api.com/v1' },
    ]);
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(resolveApiBase('custom-model')).toBe('https://custom.api.com/v1');
  });

  it('AURAXIS_MODELS 中的自定义模型正确解析', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.AURAXIS_MODELS;
    process.env.AURAXIS_MODELS = JSON.stringify([
      { id: 'custom-v2', name: 'Custom V2', apiBase: 'https://custom2.api.com' },
    ]);
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(resolveApiBase('custom-v2')).toBe('https://custom2.api.com');
  });

  it('无匹配自定义模型时回落默认端点', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.AURAXIS_MODELS;
    process.env.AURAXIS_MODELS = JSON.stringify([
      { id: 'other-model', name: 'Other', apiBase: 'https://other.api.com' },
    ]);
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(resolveApiBase('deepseek-v4-flash')).toBe('https://api.deepseek.com/beta/chat/completions');
  });

  it('无效 JSON 不抛错 — 回退默认', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    process.env.AURAXIS_MODELS = 'not valid json{{';
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(() => resolveApiBase('any-model')).not.toThrow();
    expect(resolveApiBase('any-model')).toBe('https://api.deepseek.com/beta/chat/completions');
  });

  it('非数组 JSON 不抛错', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    process.env.AURAXIS_MODELS = '"just a string"';
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(() => resolveApiBase('any-model')).not.toThrow();
  });

  it('过滤掉缺少 id 或 name 的条目', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.AURAXIS_MODELS;
    process.env.AURAXIS_MODELS = JSON.stringify([
      { name: 'NoId' },
      { id: 'has-id', name: 'HasName', apiBase: 'https://good.api.com' },
      { id: 'no-name' },
    ]);
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(resolveApiBase('has-id')).toBe('https://good.api.com');
  });

  it('支持 snake_case 别名 api_base / api_key', async () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.AURAXIS_MODELS;
    process.env.AURAXIS_MODELS = JSON.stringify([
      { id: 'snake', name: 'Snake', api_base: 'https://snake.api.com', api_key: 'sk-test' },
    ]);
    vi.resetModules();
    const { resolveApiBase } = await importFresh();
    expect(resolveApiBase('snake')).toBe('https://snake.api.com');
  });
});

describe('getAllModels', () => {
  it('返回内置模型（无 env 和 settings 自定义时）', async () => {
    delete process.env.AURAXIS_MODELS;
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: () => '/fake/userData' },
      safeStorage: { isEncryptionAvailable: () => false },
    }));
    vi.doMock('../settings-store', () => ({
      readSettings: vi.fn().mockResolvedValue({}),
    }));
    const { getAllModels } = await importFresh();
    const models = await getAllModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.find((m: { id: string }) => m.id === 'deepseek-v4-flash')).toBeTruthy();
    expect(models.find((m: { id: string }) => m.id === 'deepseek-v4-pro')).toBeTruthy();
    const vision = models.find((m: any) => m.id === 'deepseek-v4-flash-vision-exp');
    expect(vision).toBeTruthy();
    expect(vision?.supportsImages).toBe(true);
    expect(vision?.experimental).toBe(true);
  });

  it('合并 env 自定义模型（去重）', async () => {
    delete process.env.AURAXIS_MODELS;
    process.env.AURAXIS_MODELS = JSON.stringify([{ id: 'env-only', name: 'Env Only' }]);
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: () => '/fake/userData' },
      safeStorage: { isEncryptionAvailable: () => false },
    }));
    vi.doMock('../settings-store', () => ({
      readSettings: vi.fn().mockResolvedValue({}),
    }));
    const { getAllModels } = await importFresh();
    const models = await getAllModels();
    const envModel = models.find((m: { id: string }) => m.id === 'env-only');
    expect(envModel).toBeTruthy();
    // 内置模型仍存在
    expect(models.find((m: { id: string }) => m.id === 'deepseek-v4-flash')).toBeTruthy();
  });

  it('合并 settings 自定义模型（去重）', async () => {
    delete process.env.AURAXIS_MODELS;
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: () => '/fake/userData' },
      safeStorage: { isEncryptionAvailable: () => false },
    }));
    vi.doMock('../settings-store', () => ({
      readSettings: vi.fn().mockResolvedValue({
        customModels: [{ id: 'settings-only', name: 'Settings Only' }],
      }),
    }));
    const { getAllModels } = await importFresh();
    const models = await getAllModels();
    expect(models.find((m: { id: string }) => m.id === 'settings-only')).toBeTruthy();
  });

  it('settings 不存在 customModels 时不报错', async () => {
    delete process.env.AURAXIS_MODELS;
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: () => '/fake/userData' },
      safeStorage: { isEncryptionAvailable: () => false },
    }));
    vi.doMock('../settings-store', () => ({
      readSettings: vi.fn().mockResolvedValue({}),
    }));
    const { getAllModels } = await importFresh();
    await expect(getAllModels()).resolves.toBeDefined();
  });

  it('settings readSettings 抛出异常时传播错误', async () => {
    delete process.env.AURAXIS_MODELS;
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: () => '/fake/userData' },
      safeStorage: { isEncryptionAvailable: () => false },
    }));
    vi.doMock('../settings-store', () => ({
      readSettings: vi.fn().mockRejectedValue(new Error('File not found')),
    }));
    const { getAllModels } = await importFresh();
    await expect(getAllModels()).rejects.toThrow('File not found');
  });
});
