import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { AudioLines, Settings } from 'lucide-react';
import './AppShell.css';

const navClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' active' : ''}`;

export function AppShell() {
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="shell-header">
        <div className="shell-header-inner">
          <NavLink to="/" className="brand" aria-label="MultiConnect Audio home">
            <AudioLines size={22} aria-hidden />
            <span>MultiConnect Audio</span>
          </NavLink>
          <nav aria-label="Main" className="nav">
            <NavLink to="/" end className={navClass}>
              Rooms
            </NavLink>
            <NavLink to="/direct" className={navClass}>
              Multi-output
            </NavLink>
            <NavLink to="/settings" className={navClass} aria-label="Settings">
              <Settings size={18} aria-hidden />
              <span className="nav-label">Settings</span>
            </NavLink>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Suspense
          fallback={
            <div className="page muted" role="status">
              Loading…
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
