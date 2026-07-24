import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import './index.css';
import './product-pages.css';
import './workspace-pages.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
