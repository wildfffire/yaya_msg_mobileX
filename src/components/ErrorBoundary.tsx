import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View } from 'react-native';
import { logCrash } from '../utils/runtimeLog';
import { useI18n } from '../i18n';
import { ErrorState } from './StateViews';
import { usePalette } from '../theme';

interface Props {
  children: ReactNode;
  /**
   * 静默模式：捕获到错误后渲染 null，而不是满屏的 ErrorFallback。
   *
   * 用于「常驻但不可见」的组件（签名 WebView、音乐前台保活桥）：
   * 它们和页面是兄弟节点，一旦渲染兜底 UI，会以 flex:1 挤占/遮挡整个页面，
   * 比崩溃本身更难查。静默模式下错误仍然会经 logCrash 写进运行日志面板。
   */
  silent?: boolean;
}
interface State { error: Error | null; }

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.background, padding: 40 }}>
      <ErrorState
        icon="alert-circle-outline"
        title={t('出现错误')}
        hint={error.message}
        actionLabel={t('重试')}
        onAction={onRetry}
      />
    </View>
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('ErrorBoundary caught:', error.message, info.componentStack?.slice(0, 200));
    logCrash(error, `render:${info.componentStack?.split('\n')[1]?.trim().slice(0, 80) || 'unknown'}`);
  }
  render() {
    if (this.state.error) {
      // 静默模式：只为拦住错误不让它冲到根部（整屏白屏），不渲染任何 UI
      if (this.props.silent) return null;
      return <ErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
