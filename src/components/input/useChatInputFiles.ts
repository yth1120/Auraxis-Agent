import { useCallback, useMemo } from 'react';
import { message } from 'antd';
import type { I18nKey } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { parsePendingImages } from './ChatInputUtils';
import { speechRecognitionConstructor } from './SpeechRecognition';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function useChatInputFiles({ inputValue, t }: { inputValue: string; t: Translate }) {
  const pendingImages = useMemo(() => parsePendingImages(inputValue), [inputValue]);
  const setInputValue = useChatStore((s) => s.setInputValue);

  const removePendingImage = useCallback(
    (index: number) => {
      const target = pendingImages[index];
      if (!target) return;
      const next = (inputValue.slice(0, target.start) + inputValue.slice(target.end)).replace(/^\n+/, '');
      setInputValue(next);
    },
    [pendingImages, inputValue, setInputValue],
  );

  const appendFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const parts: string[] = [];
      for (const file of files) {
        const isImage = file.type.startsWith('image/');
        if (isImage) {
          if (file.size > 5 * 1024 * 1024) {
            parts.push(t('composer.imageTooLarge', { name: file.name }));
            continue;
          }
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            });
            parts.push(`【图片: ${file.name}】\n${dataUrl}`);
          } catch {
            parts.push(t('composer.imageReadFailed', { name: file.name }));
          }
        } else {
          if (file.size > 100 * 1024) {
            parts.push(t('composer.attachmentTooLarge', { name: file.name }));
            continue;
          }
          try {
            const text = await file.text();
            const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
            parts.push(`【附件: ${file.name}】\n\`\`\`${ext || ''}\n${text}\n\`\`\``);
          } catch {
            parts.push(t('composer.attachmentReadFailed', { name: file.name }));
          }
        }
      }
      if (parts.length > 0) {
        const { inputValue: current, setInputValue: update } = useChatStore.getState();
        update(current + (current.trim() ? '\n\n' : '') + parts.join('\n\n'));
      }
    },
    [t],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      void appendFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [appendFiles],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const pickFiles = useCallback(
    (accept: string) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = accept;
      input.onchange = () => void appendFiles(Array.from(input.files || []));
      input.click();
    },
    [appendFiles],
  );

  const handleMicClick = useCallback(() => {
    const Constructor = speechRecognitionConstructor();
    if (!Constructor) {
      message.info(t('composer.micUnavailable'));
      return;
    }
    try {
      const recognition = new Constructor();
      recognition.lang = 'zh-CN';
      recognition.interimResults = false;
      recognition.onerror = () => message.error(t('composer.micPermission'));
      recognition.onresult = (event) => {
        const text = event.results[0][0].transcript?.trim();
        if (text) {
          const { inputValue: current, setInputValue: update } = useChatStore.getState();
          update(current + (current.trim() ? ' ' : '') + text);
        }
      };
      recognition.start();
      message.success(t('composer.listening'));
    } catch {
      message.error(t('composer.micFailed'));
    }
  }, [t]);

  const pickProjectDirectory = useCallback(async () => {
    const result = await window.electronAPI?.project.selectDirectory();
    if (result?.ok && result.data) {
      useSettingsStore.getState().setProjectPath(result.data);
      useChatStore.getState().setCurrentProjectPath(result.data);
      message.success(t('composer.projectDirSet', { path: result.data }));
    }
  }, [t]);

  return {
    pendingImages,
    removePendingImage,
    appendFiles,
    handleDrop,
    handleDragOver,
    pickFiles,
    handleMicClick,
    pickProjectDirectory,
  };
}
