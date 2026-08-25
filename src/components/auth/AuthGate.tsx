import { errorText } from '../../../electron/errors';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Checkbox, Input } from 'antd';
import { CircleNotch } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAuthStore } from '../../stores/useAuthStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import logoPng from '../../assets/auraxis-logo.png';
import Avatar from './Avatar';

function AuthShell({ children, avatar, name }: { children: ReactNode; avatar?: string; name?: string }) {
  const t = useT();
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[var(--color-bg-primary)] px-6">
      <div className="w-[380px] max-w-full rounded-2xl border border-[var(--color-border-dim)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)] px-7 py-8 flex flex-col gap-5">
        <div className="flex flex-col items-center gap-2.5 text-center">
          {avatar || name ? (
            <Avatar name={name} src={avatar} size={56} />
          ) : (
            <img src={logoPng} alt="Auraxis" className="h-11 w-11 object-contain" />
          )}
          <div>
            {avatar || name ? (
              <>
                <div className="text-base font-semibold text-text-primary">{name || t('auth.welcomeBack')}</div>
                <div className="mt-1 text-xs leading-[18px] text-text-muted">{t('auth.loginSubtitle')}</div>
              </>
            ) : (
              <>
                <div
                  className="text-lg font-bold text-text-primary tracking-[0.02em]"
                  style={{ fontFamily: 'var(--font-heading)' }}
                >
                  Auraxis
                </div>
                <div className="mt-1 text-xs leading-[18px] text-text-muted">{t('auth.subtitle')}</div>
              </>
            )}
          </div>
        </div>
        {children}
      </div>
    </div>
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

function SetupScreen() {
  const t = useT();
  const setup = useAuthStore((s) => s.setup);
  const switchToLogin = useAuthStore((s) => s.switchToLogin);
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
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
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
          <span className="text-2xs leading-[18px] text-text-faint">{t('auth.apiKeySkipHint')}</span>
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
          {t('auth.createAccount')}
        </Button>
        <button
          type="button"
          className="self-center border-none bg-transparent text-2xs text-text-faint cursor-pointer hover:text-text-secondary"
          onClick={() => {
            setError('');
            switchToLogin();
          }}
        >
          {t('auth.haveAccount')}
        </button>
        <div className="text-center text-2xs leading-[18px] text-text-faint">{t('auth.localOnly')}</div>
      </form>
    </AuthShell>
  );
}

function LoginScreen() {
  const t = useT();
  const login = useAuthStore((s) => s.login);
  const notice = useAuthStore((s) => s.notice);
  const switchToSetup = useAuthStore((s) => s.switchToSetup);
  const avatar = useAuthStore((s) => s.avatar);
  const name = useAuthStore((s) => s.name);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      if (res.error?.includes('尚未创建账户')) {
        switchToSetup();
        return;
      }
      setError(res.error || t('auth.failed'));
    }
  };

  return (
    <AuthShell avatar={avatar} name={name}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {notice === 'created' && <div className="text-xs leading-[18px] text-success">{t('auth.createdNotice')}</div>}
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
        <button
          type="button"
          className="self-center border-none bg-transparent text-2xs text-text-faint cursor-pointer hover:text-text-secondary"
          onClick={() => {
            setError('');
            switchToSetup();
          }}
        >
          {t('auth.noAccount')}
        </button>
      </form>
    </AuthShell>
  );
}

function Splash() {
  const t = useT();
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center gap-3 bg-[var(--color-bg-primary)]">
      <img src={logoPng} alt="Auraxis" className="h-12 w-12 object-contain" />
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <CircleNotch size={14} className="animate-spin" />
        {t('auth.loading')}
      </div>
    </div>
  );
}

/**
 * Local account gate: first launch creates an account, later launches ask for
 * the password unless "remember me" is enabled. The whole workbench stays
 * behind this screen until the main process reports phase === 'unlocked'.
 */
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
