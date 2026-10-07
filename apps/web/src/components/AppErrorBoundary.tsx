import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshIcon } from './Icons'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  failed: boolean
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Teknik hata ayrıntıları kullanıcı arayüzüne veya üretim konsoluna taşınmaz.
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="app-fatal-error" role="alert">
        <div className="app-fatal-error__mark" aria-hidden="true">ER</div>
        <h1>Uygulama arayüzü yeniden başlatılmalı</h1>
        <p>
          Güvenli erişim durduruldu. Arayüzü yenileyerek temiz bir bağlantı
          başlatabilirsiniz.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          <RefreshIcon />
          Arayüzü yeniden başlat
        </button>
      </main>
    )
  }
}
