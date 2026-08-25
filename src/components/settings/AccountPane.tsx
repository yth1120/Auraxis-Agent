import { useEffect, useRef, useState } from 'react';
import { App, Button, Input, message } from 'antd';
import { Key, ShieldCheck } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAuthStore } from '../../stores/useAuthStore';
import SettingItem from './SettingItem';
import Avatar from '../auth/Avatar';

const AVATAR_SIZE = 160;

function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // CSP 只允许 data:/https:/http: 图片源（不允许 blob:），所以用 FileReader
    // 先转成 data URL 再交给 Image 解码，避免 createObjectURL 被安全策略拦截。
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        reject(new Error('read failed'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          if (!img.width || !img.height) {
            reject(new Error('empty image'));
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = AVATAR_SIZE;
          canvas.height = AVATAR_SIZE;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas unavailable'));
            return;
          }
          // 中心裁剪（cover）：按源图取一个居中的正方形区域，再等比缩放到
          // AVATAR_SIZE，避免整图被拉伸变形。
          const scale = Math.max(AVATAR_SIZE / img.width, AVATAR_SIZE / img.height);
          const sw = AVATAR_SIZE / scale;
          const sh = AVATAR_SIZE / scale;
          const sx = (img.width - sw) / 2;
          const sy = (img.height - sh) / 2;
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('decode failed'));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export default function AccountPane() {
  const t = useT();
  const { modal } = App.useApp();
  const email = useAuthStore((s) => s.email);
  const name = useAuthStore((s) => s.name);
  const avatar = useAuthStore((s) => s.avatar);
  const changePassword = useAuthStore((s) => s.changePassword);
  const setAvatar = useAuthStore((s) => s.setAvatar);
  const changeName = useAuthStore((s) => s.changeName);
  const logout = useAuthStore((s) => s.logout);
  const fileRef = useRef<HTMLInputElement>(null);

  const [nameDraft, setNameDraft] = useState(name);
  const [savingName, setSavingName] = useState(false);
  const [currentPwd, setCurrentPwd] = useState('');
  const [nextPwd, setNextPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNameDraft(name);
  }, [name]);

  const submitName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      message.warning(t('auth.nameInvalid'));
      return;
    }
    setSavingName(true);
    const res = await changeName(trimmed);
    setSavingName(false);
    if (res.ok) message.success(t('auth.nameChanged'));
    else message.error(res.error || t('auth.failed'));
  };

  const submitChange = async () => {
    if (!currentPwd || !nextPwd) {
      message.warning(t('auth.required'));
      return;
    }
    if (nextPwd.length < 6) {
      message.warning(t('auth.passwordTooShort'));
      return;
    }
    if (nextPwd !== confirmPwd) {
      message.warning(t('auth.passwordMismatch'));
      return;
    }
    setSaving(true);
    const res = await changePassword({ currentPassword: currentPwd, newPassword: nextPwd });
    setSaving(false);
    if (res.ok) {
      setCurrentPwd('');
      setNextPwd('');
      setConfirmPwd('');
      message.success(t('auth.passwordChanged'));
    } else {
      message.error(res.error || t('auth.failed'));
    }
  };

  const confirmLogout = () => {
    modal.confirm({
      title: t('auth.logoutConfirmTitle'),
      content: t('auth.logoutConfirmBody'),
      okText: t('auth.logout'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => void logout(),
    });
  };

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    // Windows 经常不填 MIME（file.type === ''），所以扩展名也作为有效依据。
    const looksLikeImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
    if (!looksLikeImage) {
      message.error(t('auth.avatarInvalid'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error(t('auth.avatarTooLarge'));
      return;
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      const res = await setAvatar(dataUrl);
      if (res.ok) message.success(t('auth.avatarChanged'));
      else message.error(res.error || t('auth.failed'));
    } catch {
      message.error(t('auth.avatarReadFailed'));
    }
  };

  return (
    <div className="mb-6 flex flex-col gap-3">
      <SettingItem title={t('auth.account')} description={t('auth.accountDesc')}>
        <div className="flex flex-col gap-3 w-full">
          <div className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
            <Avatar name={name || email} src={avatar} size={44} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary truncate">{name || email}</div>
              <div className="text-2xs text-text-muted truncate">{email}</div>
            </div>
            <span className="ml-auto inline-flex items-center gap-1 h-5 px-2 rounded-full bg-border-dim text-2xs font-medium text-text-secondary">
              <ShieldCheck size={12} />
              {t('auth.localAccount')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="small" onClick={() => fileRef.current?.click()}>
              {t('auth.changeAvatar')}
            </Button>
            {avatar && (
              <Button
                size="small"
                onClick={() => {
                  void setAvatar('').then((res) => {
                    if (res.ok) message.success(t('auth.avatarRemoved'));
                    else message.error(res.error || t('auth.failed'));
                  });
                }}
              >
                {t('auth.removeAvatar')}
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleAvatarFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </SettingItem>

      <SettingItem title={t('auth.changeName')} description={t('auth.changeNameDesc')}>
        <div className="flex items-center gap-2 w-full">
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={40}
            placeholder={t('auth.namePlaceholder')}
          />
          <Button loading={savingName} onClick={() => void submitName()}>
            {t('auth.saveName')}
          </Button>
        </div>
      </SettingItem>

      <div className="mt-1">
        <SettingItem title={t('auth.changePassword')} description={t('auth.changePasswordDesc')}>
          <div className="flex flex-col gap-2 w-full">
            <Input.Password
              value={currentPwd}
              onChange={(e) => setCurrentPwd(e.target.value)}
              placeholder={t('auth.currentPassword')}
              autoComplete="current-password"
            />
            <div className="flex gap-2">
              <Input.Password
                value={nextPwd}
                onChange={(e) => setNextPwd(e.target.value)}
                placeholder={t('auth.newPassword')}
                autoComplete="new-password"
              />
              <Input.Password
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                placeholder={t('auth.confirmPassword')}
                autoComplete="new-password"
              />
            </div>
            <Button
              icon={<Key size={14} />}
              onClick={() => void submitChange()}
              loading={saving}
              className="self-start"
            >
              {t('auth.updatePassword')}
            </Button>
          </div>
        </SettingItem>
      </div>

      <SettingItem title={t('auth.session')} description={t('auth.sessionDesc')}>
        <Button danger onClick={confirmLogout} className="self-start">
          {t('auth.logout')}
        </Button>
      </SettingItem>
    </div>
  );
}
