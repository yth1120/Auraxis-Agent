import { errorText } from '../../../electron/errors';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Button, Checkbox, ConfigProvider, Input, Modal } from 'antd';
import { CircleNotch, Lock } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAuthStore } from '../../stores/useAuthStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { darkTheme } from '../../styles/theme';
import logoPng from '../../assets/auraxis-logo.png';
import authBg from '../../assets/auraxis-auth-bg.jpg';
import Avatar from './Avatar';

/**
 * 本地账户闸门：首次启动创建账户，之后要求密码（除非勾了「记住我」）。
 * 主进程报告 `phase === 'unlocked'` 之前，整个工作台都停在这道门后面。
 *
 * ── 视觉 ──────────────────────────────────────────────────────────────
 * 品牌底图 + 玻璃表单卡。三条约束：
 *  1. **底图靠左对齐**（`background-position: left center`）：图左侧是品牌标记与
 *     字标，居中裁切会把标记切掉一半；
 *  2. **这一层固定深色**：底图是暗的，所以用 `.dark` 作用域复用深色调色板，
 *     再把 antd 换成 `darkTheme` —— 否则浅色输入框会落在深色玻璃卡上。
 *     **不新增任何色值**，全部来自 tokens.css；
 *  3. 左侧品牌文案放在画面下缘的留白带里，不压住底图自带的标记。
 */

/** 左栏品牌陈述：底图已有标记与字标，这里只补定位与三条**事实**。 */
function BrandStatement() {
  const t = useT();
  const points = ['auth.brandPoint1', 'auth.brandPoint2', 'auth.brandPoint3'] as const;
  return (
    <div className="ax-auth-brand max-w-[420px]">
      <div className="font-mono text-3xs uppercase tracking-[0.3em] text-text-faint">Local-first agent workbench</div>
      <h1 className="mt-3 text-lg font-semibold leading-[26px] text-text-primary">{t('auth.brandHeadline')}</h1>
      <ul className="mt-4 flex list-none flex-col gap-2.5 p-0">
        {points.map((key) => (
          <li key={key} className="flex items-center gap-2.5 text-xs leading-[18px] text-text-secondary">
            <span className="ax-auth-dot shrink-0" aria-hidden="true" />
            {t(key)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 登录 / 注册两态切换（替代原先藏在卡片底部的文字链）。
 *
 * 用应用既有的 **radiogroup + 滑动滑块**：选中态由可移动的滑块承载，按钮自身
 * 保持透明。这不是审美选择 —— 全局规则会给 `[aria-selected='true']` 的按钮强加
 * `primary-soft` 底色（`!important`），只有 `[role='radiogroup'] button[role='radio']`
 * 有豁免，所以滑块是这里唯一能做实的选中态。
 */
function AuthTabs() {
  const t = useT();
  const phase = useAuthStore((s) => s.phase);
  const switchToLogin = useAuthStore((s) => s.switchToLogin);
  const switchToSetup = useAuthStore((s) => s.switchToSetup);
  const tabs = [
    { key: 'locked' as const, label: t('auth.tabLogin'), go: switchToLogin },
    { key: 'setup' as const, label: t('auth.tabRegister'), go: switchToSetup },
  ];
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === phase),
  );
  return (
    <div className="ax-auth-tabs" role="radiogroup" aria-label={t('auth.subtitle')}>
      <span className="ax-auth-thumb" data-pos={activeIndex} aria-hidden="true" />
      {tabs.map((tab) => {
        const active = phase === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            role="radio"
            aria-checked={active}
            className={clsx('ax-auth-tab', active && 'ax-auth-tab-active')}
            onClick={() => {
              if (!active) tab.go();
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={darkTheme}>
      <div className="dark relative min-h-screen w-full overflow-hidden bg-[var(--color-bg-primary)]">
        <div className="ax-auth-bg" style={{ backgroundImage: `url(${authBg})` }} aria-hidden="true" />
        <div className="ax-auth-scrim" aria-hidden="true" />
        <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1320px] items-center gap-12 px-8 lg:px-16">
          {/* 品牌文案压到下缘的留白带：底图的标记在中部偏左，文字放这里才不打架。 */}
          <div className="hidden min-w-0 flex-1 self-stretch lg:flex lg:flex-col lg:justify-end lg:pb-16">
            <BrandStatement />
          </div>
          <div className="mx-auto w-full max-w-[404px] shrink-0 lg:mx-0">
            <div className="ax-auth-card relative rounded-2xl px-6 py-6">
              <AuthTabs />
              {children}
            </div>
          </div>
        </div>
      </div>
    </ConfigProvider>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium leading-[18px] text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

/** 表单分段：标题 + 可选说明 + 一组字段，用 hairline 与前一段分开。 */
function FormSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5 border-t border-[var(--color-border-dim)] pt-4 first:border-t-0 first:pt-0">
      <header className="flex items-baseline justify-between gap-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-text-muted">{title}</span>
        {hint && <span className="min-w-0 truncate text-2xs text-text-faint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function SetupScreen() {
  const t = useT();
  const setup = useAuthStore((s) => s.setup);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [connectState, setConnectState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [connectMsg, setConnectMsg] = useState('');

  const testConnection = async (): Promise<{ ok: boolean; msg: string }> => {
    const key = apiKey.trim();
    if (!key) {
      setConnectState('fail');
      const msg = t('auth.apiKeyRequiredForTest');
      setConnectMsg(msg);
      return { ok: false, msg };
    }
    setConnectState('testing');
    setConnectMsg('');
    try {
      const res = await window.electronAPI?.ai?.testConnection(key);
      if (res?.ok) {
        setConnectState('ok');
        const msg = res.data?.message || t('auth.connected');
        setConnectMsg(msg);
        return { ok: true, msg };
      }
      setConnectState('fail');
      const msg = res?.error || t('auth.connectFailed');
      setConnectMsg(msg);
      return { ok: false, msg };
    } catch (err: unknown) {
      setConnectState('fail');
      const msg = errorText(err) || t('auth.connectFailed');
      setConnectMsg(msg);
      return { ok: false, msg };
    }
  };

  const submit = async () => {
    setError('');
    if (!name.trim() || !email.trim()) {
      setError(t('auth.required'));
      return;
    }
    if (password.length < 6) {
      setError(t('auth.passwordTooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    const key = apiKey.trim();
    if (key && connectState !== 'ok') {
      const result = await testConnection();
      if (!result.ok) {
        setError(result.msg);
        return;
      }
    }
    setSubmitting(true);
    const res = await setup({ name, email, password, rememberMe });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error || t('auth.failed'));
      return;
    }
    if (key) {
      useSettingsStore.getState().setApiKey(key);
    }
  };

  return (
    <AuthShell>
      <form
        className="mt-5 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FormSection title={t('auth.sectionAccount')}>
          <Field label={t('auth.name')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('auth.namePlaceholder')}
              autoFocus
            />
          </Field>
          <Field label={t('auth.email')}>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              type="email"
            />
          </Field>
          <Field label={t('auth.password')}>
            <Input.Password
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
            />
          </Field>
          <Field label={t('auth.confirmPassword')}>
            <Input.Password
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t('auth.confirmPasswordPlaceholder')}
            />
          </Field>
        </FormSection>

        <FormSection title={t('auth.sectionModel')} hint={t('auth.apiKeySkipHint')}>
          <Field label={t('auth.apiKey')}>
            <div className="flex gap-2">
              <Input.Password
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (connectState === 'ok' || connectState === 'fail') {
                    setConnectState('idle');
                    setConnectMsg('');
                  }
                }}
                placeholder={t('auth.apiKeyPlaceholder')}
                autoComplete="off"
                className="flex-1"
              />
              <Button
                onClick={() => void testConnection()}
                loading={connectState === 'testing'}
                disabled={!apiKey.trim()}
                className="shrink-0"
              >
                {t('auth.testConnection')}
              </Button>
            </div>
            {connectMsg && <span className={connectState === 'ok' ? 'text-success' : 'text-danger'}>{connectMsg}</span>}
          </Field>
        </FormSection>

        <div className="flex flex-col gap-3.5 border-t border-[var(--color-border-dim)] pt-4">
          <Checkbox
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="text-xs text-text-secondary"
          >
            {t('auth.rememberMe')}
          </Checkbox>
          {error && <div className="text-xs leading-[18px] text-danger">{error}</div>}
          <Button type="primary" htmlType="submit" block loading={submitting}>
            {t('auth.createAccount')}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

function LoginScreen() {
  const t = useT();
  const login = useAuthStore((s) => s.login);
  const notice = useAuthStore((s) => s.notice);
  const avatar = useAuthStore((s) => s.avatar);
  const name = useAuthStore((s) => s.name);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetAccount = useAuthStore((s) => s.resetAccount);
  const switchToSetup = useAuthStore((s) => s.switchToSetup);
  // 预加载脚本没加载（构建不完整）时，所有 IPC 都会失败：
  // 明确告诉用户原因，而不是让人以为是密码错误。
  const bridgeMissing = typeof window !== 'undefined' && !window.electronAPI;

  const confirmReset = () => {
    Modal.confirm({
      title: t('auth.resetTitle'),
      content: t('auth.resetBody'),
      okText: t('auth.resetConfirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        try {
          const res = await resetAccount();
          if (!res.ok) setError(res.error || t('auth.failed'));
        } finally {
          setResetting(false);
        }
      },
    });
  };

  const submit = async () => {
    setError('');
    if (!email.trim() || !password) {
      setError(t('auth.required'));
      return;
    }
    setSubmitting(true);
    const res = await login({ email, password, rememberMe });
    setSubmitting(false);
    if (!res.ok) {
      if (res.code === 'no_account' || res.error?.includes('尚未创建账户')) {
        switchToSetup();
        return;
      }
      setError(res.error || t('auth.failed'));
    }
  };

  return (
    <AuthShell>
      <form
        className="mt-5 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {(avatar || name) && (
          <div className="flex items-center gap-3 rounded-xl bg-[var(--color-bg-inset)] px-3 py-2.5">
            <Avatar name={name} src={avatar} size={36} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-text-primary">{name || t('auth.welcomeBack')}</div>
              <div className="truncate text-2xs text-text-muted">{t('auth.loginSubtitle')}</div>
            </div>
          </div>
        )}
        {notice === 'created' && <div className="text-xs leading-[18px] text-success">{t('auth.createdNotice')}</div>}
        {bridgeMissing && <div className="text-xs leading-[18px] text-danger">{t('auth.bridgeMissing')}</div>}
        <Field label={t('auth.email')}>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            type="email"
            autoFocus
          />
        </Field>
        <Field label={t('auth.password')}>
          <Input.Password
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('auth.passwordPlaceholder')}
          />
        </Field>
        <Checkbox
          checked={rememberMe}
          onChange={(e) => setRememberMe(e.target.checked)}
          className="text-xs text-text-secondary"
        >
          {t('auth.rememberMe')}
        </Checkbox>
        {error && <div className="text-xs leading-[18px] text-danger">{error}</div>}
        <Button type="primary" htmlType="submit" block loading={submitting}>
          {t('auth.login')}
        </Button>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border-dim)] pt-3.5">
          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-text-faint">
            <Lock size={12} className="shrink-0" />
            <span className="truncate">{t('auth.localOnly')}</span>
          </span>
          <button
            type="button"
            className="shrink-0 cursor-pointer border-none bg-transparent text-2xs text-text-faint transition-colors duration-150 hover:text-text-secondary disabled:opacity-40"
            disabled={resetting}
            onClick={confirmReset}
          >
            {t('auth.forgotPassword')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

/** 启动画面与认证页共用同一张底图，避免"闪一下白再变暗"。 */
function Splash() {
  const t = useT();
  return (
    <div className="dark relative flex min-h-screen w-full flex-col items-center justify-center gap-3 overflow-hidden bg-[var(--color-bg-primary)]">
      <div className="ax-auth-bg" style={{ backgroundImage: `url(${authBg})` }} aria-hidden="true" />
      <div className="ax-auth-scrim" aria-hidden="true" />
      <img src={logoPng} alt="Auraxis" className="relative z-10 h-12 w-12 object-contain" />
      <div className="relative z-10 flex items-center gap-2 text-xs text-text-muted">
        <CircleNotch size={14} className="animate-spin" />
        {t('auth.loading')}
      </div>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const ready = useAuthStore((s) => s.ready);
  const phase = useAuthStore((s) => s.phase);
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!ready) return <Splash />;
  if (phase === 'setup') return <SetupScreen />;
  if (phase === 'locked') return <LoginScreen />;
  return <>{children}</>;
}
