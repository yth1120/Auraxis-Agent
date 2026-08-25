import { memo } from 'react';
import { Info as InfoCircleOutlined, Warning as WarningOutlined } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { Message } from '../../types/chat';
import { getContentText } from '../../types/chat';

interface SystemMessageProps {
  message: Message;
}

export default memo(function SystemMessage({ message }: SystemMessageProps) {
  const t = useT();
  const contentText = getContentText(message.content);
  const isWarning = message.tags?.includes('warning');
  const isInjected = message.tags?.includes('injected');

  return (
    <div
      className={clsx(
        'flex items-start gap-2 px-6 py-2 text-xs max-w-[600px] mx-auto',
        isWarning ? 'text-accent' : 'text-muted',
        isInjected && 'opacity-80 italic',
      )}
    >
      <span className="shrink-0 text-sm mt-px opacity-80">
        {isWarning ? <WarningOutlined /> : <InfoCircleOutlined />}
      </span>
      <span className="flex-1 leading-normal">{contentText}</span>
      {isWarning && (
        <span className="shrink-0 text-2xs px-[6px] py-px bg-accent-soft text-accent rounded-full font-medium">
          {t('msg.system')}
        </span>
      )}
    </div>
  );
});
