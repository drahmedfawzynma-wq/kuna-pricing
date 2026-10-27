import React, { useEffect, useState } from 'react';
import { AuthCtx, type Me } from './auth';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { api } from './api';
import { ConfirmProvider, Field, ToastProvider, Alert } from './ui';
import { can, ROLE_LABELS, type Permission } from '../../shared/permissions';
import Overview from './pages/Overview';
import Materials from './pages/Materials';
import Imports from './pages/Imports';
import Recipes from './pages/Recipes';
import RecipeEditor from './pages/RecipeEditor';
import Calculator from './pages/Calculator';
import Pricing from './pages/Pricing';
import Customers from './pages/Customers';
import Quotations from './pages/Quotations';
import QuotationEditor from './pages/QuotationEditor';
import QuotationPrint from './pages/QuotationPrint';
import Batches from './pages/Batches';
import Settings from './pages/Settings';


function Login({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (needsSetup) await api.post('/api/auth/setup', { email, name, password });
      else await api.post('/api/auth/login', { email, password });
      onDone();
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <div className="card-body stack">
          <div className="row"><div className="brand-mark" style={{ color: '#fff', width: 34, height: 34, borderRadius: 8, display: 'grid', placeItems: 'center' }}>K</div>
            <div><h1 style={{ fontSize: 18 }}>Kuna Production &amp; Pricing</h1><div className="muted small">{needsSetup ? 'First-time setup: create the administrator account' : 'Sign in'}</div></div></div>
          {needsSetup && <Field label="Your name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
          <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password" hint={needsSetup ? 'At least 10 characters.' : undefined}><input className="input" type="password" autoComplete={needsSetup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {err && <Alert tone="error">{err}</Alert>}
          <button className="btn btn-primary" type="submit" disabled={busy}>{needsSetup ? 'Create administrator' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}

function Shell({ user, logout }: { user: Me; logout: () => void }) {
  const c = (p: Permission) => can(user.role, p);
  const loc = useLocation();
  const [reviewCount, setReviewCount] = useState<number>(0);
  useEffect(() => {
    if (!c('recipes.write') && !c('materials.write')) return;
    api.get('/api/dashboard').then((d) => setReviewCount((d.review?.materials.length ?? 0) + (d.review?.recipes.length ?? 0))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);
  if (loc.pathname.endsWith('/print')) {
    return (
      <AuthCtx.Provider value={{ user, can: c, logout }}>
        <Routes><Route path="/quotations/:id/print" element={<QuotationPrint />} /></Routes>
      </AuthCtx.Provider>
    );
  }
  return (
    <AuthCtx.Provider value={{ user, can: c, logout }}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand"><div className="brand-mark">K</div><div><div className="brand-name">Kuna</div><div className="brand-sub">Production &amp; Pricing</div></div></div>
          <nav className="nav">
            <NavLink to="/" end>Overview</NavLink>
            {c('materials.read') && <div className="nav-section">Production</div>}
            {c('materials.read') && <NavLink to="/materials">Materials &amp; packaging</NavLink>}
            {c('recipes.read') && <NavLink to="/recipes">Recipes {reviewCount > 0 && <span className="nav-count" title="Records needing review">{reviewCount}</span>}</NavLink>}
            {c('costs.read') && <NavLink to="/calculator">Batch calculator</NavLink>}
            {c('batches.read') && <NavLink to="/batches">Production batches</NavLink>}
            {(c('pricing.read') || c('prices.read') || c('customers.read')) && <div className="nav-section">Commercial</div>}
            {(c('pricing.read') || c('prices.read')) && <NavLink to="/pricing">Pricing &amp; scenarios</NavLink>}
            {c('customers.read') && <NavLink to="/customers">Customers</NavLink>}
            {c('quotations.read') && <NavLink to="/quotations">Quotations</NavLink>}
            <div className="nav-section">System</div>
            {c('imports.run') && <NavLink to="/imports">Imports</NavLink>}
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="side-foot">
            <div className="who">{user.name}</div>
            <div className="muted small" style={{ color: '#8fa59b' }}>{ROLE_LABELS[user.role]}</div>
            <button onClick={logout}>Sign out</button>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/materials" element={<Materials />} />
            <Route path="/materials/:id" element={<Materials />} />
            <Route path="/imports" element={<Imports />} />
            <Route path="/recipes" element={<Recipes />} />
            <Route path="/recipes/:productId" element={<RecipeEditor />} />
            <Route path="/calculator" element={<Calculator />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/quotations" element={<Quotations />} />
            <Route path="/quotations/new" element={<QuotationEditor />} />
            <Route path="/quotations/:id" element={<QuotationEditor />} />
            <Route path="/batches" element={<Batches />} />
            <Route path="/batches/:id" element={<Batches />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </AuthCtx.Provider>
  );
}

function App() {
  const [state, setState] = useState<{ loading: boolean; user: Me | null; needsSetup: boolean }>({ loading: true, user: null, needsSetup: false });
  const load = () => api.get('/api/auth/me').then((r) => setState({ loading: false, user: r.user, needsSetup: r.needsSetup })).catch(() => setState({ loading: false, user: null, needsSetup: false }));
  useEffect(() => {
    load();
    const h = () => setState((s) => ({ ...s, user: null }));
    window.addEventListener('kuna:unauthorized', h);
    return () => window.removeEventListener('kuna:unauthorized', h);
  }, []);
  if (state.loading) return <div className="loading">Loading…</div>;
  if (!state.user) return <Login needsSetup={state.needsSetup} onDone={load} />;
  const logout = async () => { await api.post('/api/auth/logout'); setState({ loading: false, user: null, needsSetup: false }); };
  return <Shell user={state.user} logout={logout} />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

