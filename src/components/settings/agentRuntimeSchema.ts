import type { SchemaField } from './SchemaPanel';
import type { I18nKey } from '../../i18n';

export interface ModelOption {
  id: string;
  name: string;
}

/**
 * Agent runtime preferences — rendered generically by SchemaPanel.
 * Model selects are built from the live model list so a new model only needs
 * to be registered in model-config to show up here.
 */
export function buildAgentRuntimeFields(models: ModelOption[], t: (key: I18nKey) => string): SchemaField[] {
  const modelOptions = models.map((m) => ({ value: m.id, label: m.name }));
  const fallbackPlan = { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' };
  const fallbackExecute = { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' };
  return [
    {
      key: 'clarifyBeforeWork',
      label: t('settings.runtime.clarifyBeforeWork'),
      description: t('settings.runtime.clarifyBeforeWork.desc'),
      type: 'boolean',
      default: true,
    },
    {
      key: 'agentMaxIterations',
      label: t('settings.runtime.maxIterations'),
      description: t('settings.runtime.maxIterations.desc'),
      type: 'number',
      min: 10,
      max: 1000,
      step: 10,
      default: 200,
    },
    {
      key: 'timeContext',
      label: t('settings.runtime.timeContext'),
      description: t('settings.runtime.timeContext.desc'),
      type: 'boolean',
      default: true,
    },
    {
      key: 'planModel',
      label: t('settings.runtime.planModel'),
      description: t('settings.runtime.planModel.desc'),
      type: 'select',
      options: modelOptions,
      default: modelOptions[0]?.value ?? fallbackPlan.value,
    },
    {
      key: 'executeModel',
      label: t('settings.runtime.executeModel'),
      description: t('settings.runtime.executeModel.desc'),
      type: 'select',
      options: modelOptions,
      default: modelOptions[1]?.value ?? fallbackExecute.value,
    },
  ];
}
