import { useEffect, useState } from 'react';
import { Input, Modal } from 'antd';
import clsx from 'clsx';
import type { AskRequest } from '../../types/electron-api';
import { useT } from '../../i18n';

/**
 * Renders model-driven AskUser questions （用户提问）.
 * One modal at a time; further questions queue behind the current one.
 */
export default function AskUserHost() {
  const t = useT();
  const [queue, setQueue] = useState<AskRequest[]>([]);
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.ask) return;
    return window.electronAPI.ask.onRequest((request) => {
      setQueue((q) => [...q, request]);
    });
  }, []);

  const current = queue[0] ?? null;

  const respond = (value: string) => {
    if (!current) return;
    setSubmitting(true);
    window.electronAPI?.ask
      ?.respond(current.askId, value)
      .catch(() => {
        /* backend timeout/cleanup already resolves */
      })
      .finally(() => {
        setSubmitting(false);
        setQueue((q) => q.slice(1));
        setAnswer('');
        setSelected(null);
      });
  };

  const finalAnswer = selected ?? answer;

  return (
    <Modal
      open={!!current}
      title={t('ask.title')}
      okText={t('ask.answer')}
      cancelText={t('ask.skip')}
      width={480}
      transitionName=""
      maskTransitionName=""
      okButtonProps={{ disabled: submitting || !finalAnswer.trim() }}
      confirmLoading={submitting}
      onOk={() => respond(finalAnswer)}
      onCancel={() => respond('')}
    >
      {current && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-text-primary leading-[1.6] whitespace-pre-wrap">{current.question}</p>
          {current.options.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {current.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={clsx(
                    'text-left px-3 py-2 rounded-lg border text-sm leading-[1.5] cursor-pointer transition-colors duration-150',
                    selected === opt
                      ? 'border-[var(--color-primary)] bg-primary-soft text-text-primary'
                      : 'border-[var(--color-border-default)] bg-transparent text-text-secondary hover:bg-[var(--color-hover)]',
                  )}
                  onClick={() => {
                    setSelected(opt);
                    setAnswer('');
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          <Input.TextArea
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              setSelected(null);
            }}
            placeholder={current.options.length > 0 ? t('ask.optionsHint') : t('ask.inputHint')}
            autoSize={{ minRows: 2, maxRows: 5 }}
            onPressEnter={(e) => {
              if (!e.shiftKey && finalAnswer.trim()) {
                e.preventDefault();
                respond(finalAnswer);
              }
            }}
          />
          <p className="m-0 text-2xs text-text-muted">{t('ask.skipHint')}</p>
        </div>
      )}
    </Modal>
  );
}
