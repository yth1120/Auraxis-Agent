import { Component, type ReactNode } from 'react';
import { t } from '../../i18n';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error.message, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null, hasError: false });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex items-center justify-center h-screen bg-primary p-6">
          <div className="bg-secondary border border-dim rounded-md shadow-lg overflow-hidden max-w-[420px] w-full">
            <div className="h-[3px] bg-[var(--color-primary)]" />
            <div className="p-8 text-center">
              <h2 className="font-heading text-xl font-semibold text-text-primary m-0 mb-2">{t('error.title')}</h2>
              <p className="text-xs text-muted m-0 mb-1 px-3 py-2 bg-danger-soft rounded-md font-mono break-all">
                {this.state.error?.message || t('error.unknown')}
              </p>
              <p className="text-xs text-faint mt-3 mb-6">{t('error.hint')}</p>
              <button
                className="inline-flex items-center gap-2 bg-accent text-on-accent border-none rounded-md px-5 py-2 font-body text-sm font-medium cursor-pointer transition-colors duration-normal ease-out hover:bg-accent-hover"
                onClick={this.handleReset}
              >
                {t('error.recover')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
