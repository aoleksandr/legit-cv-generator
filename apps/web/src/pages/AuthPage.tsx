import { useMutation } from '@tanstack/react-query';
import { CredentialsSchema } from '@cv/shared';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { api } from '../api';
import { useMe, useSetUser } from '../auth';
import { ErrorBanner } from '../components/ErrorBanner';

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { data: user } = useMe();
  const setUser = useSetUser();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const mutation = useMutation({
    mutationFn: (c: { email: string; password: string }) => (mode === 'login' ? api.login(c) : api.signup(c)),
    onSuccess: (u) => {
      setUser(u);
      navigate(from, { replace: true });
    },
  });

  if (user) return <Navigate to={from} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CredentialsSchema.safeParse({ email, password });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setFormError(issue.path[0] === 'password' ? 'Password must be at least 8 characters.' : 'Enter a valid email address.');
      return;
    }
    setFormError(null);
    mutation.mutate(parsed.data);
  };

  const isLogin = mode === 'login';
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6" noValidate>
        <div>
          <h1 className="text-xl font-semibold">{isLogin ? 'Sign in' : 'Create an account'}</h1>
          <p className="mt-1 text-sm text-slate-500">AI CV Builder</p>
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          {!isLogin && <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>}
        </div>
        {formError ? <ErrorBanner>{formError}</ErrorBanner> : <ErrorBanner error={mutation.error} />}
        <button className="btn-primary w-full" disabled={mutation.isPending}>
          {mutation.isPending ? 'Please wait…' : isLogin ? 'Sign in' : 'Sign up'}
        </button>
        <p className="text-center text-sm text-slate-500">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <Link className="font-medium text-indigo-600 hover:underline" to={isLogin ? '/signup' : '/login'} state={location.state}>
            {isLogin ? 'Sign up' : 'Sign in'}
          </Link>
        </p>
      </form>
    </div>
  );
}
