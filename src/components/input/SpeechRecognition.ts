interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript?: string }>>;
}

interface SpeechRecognitionInstanceLike {
  lang: string;
  interimResults: boolean;
  onerror?: () => void;
  onresult?: (event: SpeechRecognitionEventLike) => void;
  start: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstanceLike;

export function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}
