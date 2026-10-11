import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { StoreProvider } from './hooks.js'
import { AppStore } from './store.js'
import './styles.css'

const store = new AppStore(window.nexgent)
window.addEventListener('unhandledrejection', event => store.notify(event.reason))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider store={store}>
        <App />
      </StoreProvider>
    </ErrorBoundary>
  </StrictMode>,
)

void store.init().then(() => store.openLastProject())
