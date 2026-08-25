import { _electron as electron, test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

async function launch(dataDir: string) {
  return electron.launch({
    args: [path.join(process.cwd(), 'dist-electron', 'main.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AURAXIS_FORCE_PRODUCTION: '1',
      AURAXIS_USER_DATA_DIR: dataDir,
      AURAXIS_CHAT_LOG_DIR: path.join(dataDir, 'chat-logs'),
      AURAXIS_SESSION_LOG_DIR: path.join(dataDir, 'session-logs'),
      AURAXIS_SESSION_CACHE_DIR: path.join(dataDir, 'session-cache'),
      AURAXIS_FTS_DIR: path.join(dataDir, 'fts'),
      AURAXIS_FEEDBACK_DIR: path.join(dataDir, 'feedback'),
      AURAXIS_SNAPSHOT_DIR: path.join(dataDir, 'agent-snapshots'),
      AURAXIS_HOOKS_DIR: path.join(dataDir, 'hooks'),
    },
  });
}

test('auth flow: register, login, and remember-me persistence', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-auth-e2e-'));
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(dataDir);
    let page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: '创建账户' }).waitFor({ state: 'visible', timeout: 30_000 });

    await page.getByPlaceholder('怎么称呼你').fill('测试用户');
    await page.locator('input[type="email"]').fill('user@example.com');
    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill('secret1');
    await passwords.nth(1).fill('secret1');
    await page.getByRole('button', { name: '创建账户' }).click();

    const loginButton = page.locator('button').filter({ hasText: '登' }).first();
    await expect(loginButton).toBeVisible({ timeout: 10_000 });
    await page.locator('input[type="email"]').fill('user@example.com');
    await page.locator('input[type="password"]').fill('secret1');
    await page.locator('input[type="checkbox"]').check();
    await loginButton.click();
    await page.locator('.ax-composer-textarea').waitFor({ state: 'visible', timeout: 10_000 });

    await app.close();
    app = await launch(dataDir);
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.ax-composer-textarea').waitFor({ state: 'visible', timeout: 10_000 });
  } finally {
    await app?.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});
