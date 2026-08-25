import { useState, useEffect } from 'react';
import { fetchModels, BUILT_IN_MODELS, type AIModel } from '../types/chat';

let cached: AIModel[] | null = null;

export function useModels(): AIModel[] {
  const [models, setModels] = useState<AIModel[]>(cached ?? BUILT_IN_MODELS);

  useEffect(() => {
    let cancelled = false;
    fetchModels().then((list) => {
      if (cancelled) return;
      cached = list;
      setModels(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return models;
}
