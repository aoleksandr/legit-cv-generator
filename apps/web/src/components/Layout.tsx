import { Link, Outlet, useNavigate } from 'react-router';
import { api } from '../api';
import { useMe, useSetUser } from '../auth';

export function Layout() {
  const { data: user } = useMe();
  const setUser = useSetUser();
  const navigate = useNavigate();

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Link to="/" className="font-semibold text-slate-900">
            CV Builder
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden truncate text-sm text-slate-500 sm:inline">{user?.email}</span>
            <button className="btn-ghost" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
