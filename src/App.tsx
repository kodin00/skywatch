import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Cloud,
  Database,
  Globe2,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'

type SetupState = 'token' | 'working' | 'complete'
type AccessType = 'protected' | 'public'
type AppMode = 'loading' | 'setup' | 'unlock' | 'dashboard'

type StatusResponse = {
  configured: boolean
  authenticated: boolean
  account: { id: string; name: string } | null
  database: 'connected'
  encryption: 'pending' | 'finalizing' | 'ready'
}

type Worker = {
  id: string
  name: string
  createdAt: string | null
  modifiedAt: string | null
  accessStatus: AccessType
  accessApplication: { id: string; name: string | null } | null
  emails: string[]
  policyCount: number
  managedBySkywatch: boolean
}

type WorkersResponse = { workers: Worker[]; syncedAt: string }
type ApiError = { error?: string; code?: string }

const setupTasks = [
  { label: 'Prepare encrypted D1 vault', icon: Database },
  { label: 'Connect this Skywatch instance', icon: Cloud },
  { label: 'Create key and encrypt API token', icon: KeyRound },
  { label: 'Sync Workers and Access rules', icon: ShieldCheck },
]

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  const data = await response.json().catch(() => ({})) as T & ApiError
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

function Logo() {
  return (
    <div className="brand" aria-label="Skywatch">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span>skywatch</span>
    </div>
  )
}

function SetupScreen({ mode, onConnected }: { mode: 'setup' | 'unlock'; onConnected: (status: StatusResponse) => void }) {
  const [token, setToken] = useState('')
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<SetupState>('token')
  const [task, setTask] = useState(-1)
  const [error, setError] = useState('')
  const [account, setAccount] = useState<{ id: string; name: string } | null>(null)
  const tokenReady = token.trim().length >= 20
  const isUnlock = mode === 'unlock'

  useEffect(() => {
    if (state !== 'working') return
    const timer = window.setInterval(() => {
      setTask((current) => Math.min(current + 1, setupTasks.length - 1))
    }, 1100)
    return () => window.clearInterval(timer)
  }, [state])

  const connect = async () => {
    if (!tokenReady) return
    setError('')
    setState('working')
    setTask(isUnlock ? 2 : 0)
    try {
      if (isUnlock) {
        await api('/api/unlock', { method: 'POST', body: JSON.stringify({ token: token.trim() }) })
        const status = await api<StatusResponse>('/api/status')
        onConnected(status)
        return
      }
      const result = await api<{ account: { id: string; name: string } }>('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim() }),
      })
      setAccount(result.account)
      setTask(setupTasks.length)
      setState('complete')
      setToken('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Cloudflare could not be connected.')
      setState('token')
      setTask(-1)
    }
  }

  const finish = async () => {
    setError('')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const status = await api<StatusResponse>('/api/status')
      if (status.encryption === 'ready') {
        onConnected(status)
        return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1200))
    }
    setError('Cloudflare is still attaching the encryption key. Wait a few seconds, then try again.')
  }

  return (
    <main className="setup-shell">
      <header className="setup-header">
        <Logo />
        <span className="secure-note"><LockKeyhole size={14} /> Secure setup</span>
      </header>

      <section className="setup-stage">
        <div className="setup-intro">
          <span className="eyebrow"><span /> {isUnlock ? 'Protected workspace' : 'Connect Cloudflare'}</span>
          <h1>Your Workers,<br /><em>under watch.</em></h1>
          <p>{isUnlock ? 'This Skywatch instance is already configured. Use its original API token to unlock this browser.' : 'Connect your Cloudflare account once. Skywatch prepares a private vault, finds your Workers, and keeps every access rule in view.'}</p>
          <div className="trust-line"><ShieldCheck size={17} /> Your token is encrypted before it touches storage.</div>
        </div>

        <div className="setup-card">
          {state === 'token' && (
            <>
              <div className="step-count">01 <span>/ 01</span></div>
              <div className="card-heading">
                <div className="icon-tile"><KeyRound size={21} /></div>
                <div><h2>{isUnlock ? 'Unlock Skywatch' : 'Connect your account'}</h2><p>Use a scoped API token—not your Global API Key.</p></div>
              </div>

              {!isUnlock && <div className="permission-box">
                <div className="permission-title"><ShieldCheck size={16} /><span>Required token permissions</span><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create token <ArrowRight size={13} /></a></div>
                <div className="permission-row"><span>Account</span><strong>Workers Scripts · Read + Edit</strong></div>
                <div className="permission-row"><span>Account</span><strong>Access: Apps and Policies · Edit</strong></div>
                <div className="permission-row"><span>User</span><strong>Memberships · Read</strong></div>
                <div className="permission-row"><span>Resources</span><strong>Include · One account</strong></div>
              </div>}

              <form onSubmit={(event) => { event.preventDefault(); void connect() }}>
                <label className="token-label" htmlFor="api-token">Cloudflare API token</label>
                <div className={`token-input ${token && !tokenReady ? 'invalid' : ''}`}>
                  <KeyRound size={17} />
                  <input id="api-token" autoComplete="off" spellCheck="false" type={visible ? 'text' : 'password'} placeholder="Paste your token here" value={token} onChange={(event) => setToken(event.target.value)} />
                  <button type="button" onClick={() => setVisible((value) => !value)}>{visible ? 'Hide' : 'Show'}</button>
                </div>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="primary-button" type="submit" disabled={!tokenReady}>{isUnlock ? 'Unlock this browser' : 'Connect Cloudflare'} <ArrowRight size={17} /></button>
                <p className="microcopy"><LockKeyhole size={12} /> Skywatch never returns your token to the browser.</p>
              </form>
            </>
          )}

          {state === 'working' && (
            <div className="progress-view" aria-live="polite">
              <div className="orbit-mark"><Cloud size={25} /><span /></div>
              <h2>{isUnlock ? 'Unlocking Skywatch' : 'Setting up Skywatch'}</h2>
              <p>Secure handshakes are in progress. Keep this tab open.</p>
              <div className="task-list">
                {setupTasks.map((item, index) => {
                  const ItemIcon = item.icon
                  const status = index < task ? 'done' : index === task ? 'active' : 'waiting'
                  return <div className={`task-item ${status}`} key={item.label}><span className="task-icon">{status === 'done' ? <Check size={15} /> : <ItemIcon size={15} />}</span><span>{item.label}</span><span className="task-status">{status === 'done' ? 'Done' : status === 'active' ? 'Working' : 'Waiting'}</span></div>
                })}
              </div>
            </div>
          )}

          {state === 'complete' && (
            <div className="complete-view" aria-live="polite">
              <div className="success-mark"><Check size={27} /></div>
              <span className="eyebrow centered"><span /> Connection ready</span>
              <h2>Your Workers are in view.</h2>
              <p>The D1 vault is connected and your API token is encrypted with a Worker-only key.</p>
              <div className="connection-summary"><span><Database size={16} /> D1 vault</span><strong>Connected</strong></div>
              <div className="connection-summary"><span><Cloud size={16} /> Cloudflare</span><strong>{account?.name || 'Connected'}</strong></div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button" type="button" onClick={() => void finish()}>Open dashboard <ArrowRight size={17} /></button>
            </div>
          )}
        </div>
      </section>

      <footer className="setup-footer"><span>Built for Cloudflare Workers</span><span className="footer-dash" /><span>Token stored with AES-256-GCM encryption</span></footer>
    </main>
  )
}

function AccessBadge({ type }: { type: AccessType }) {
  return <span className={`access-badge ${type}`}>{type === 'protected' ? <LockKeyhole size={13} /> : <Globe2 size={13} />}{type === 'protected' ? 'Access protected' : 'Public'}</span>
}

function relativeDate(value: string | null): string {
  if (!value) return 'Unknown'
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function AccessDialog({ worker, onClose, onSaved }: { worker: Worker; onClose: () => void; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<AccessType>(worker.accessStatus)
  const [emails, setEmails] = useState(worker.emails.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`/api/workers/${encodeURIComponent(worker.id)}/access`, {
        method: 'PUT',
        body: JSON.stringify({ mode, emails: emails.split(/[\n,]/).map((email) => email.trim()).filter(Boolean) }),
      })
      await onSaved()
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Access could not be updated.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="access-dialog-title">
      <header><div><span className="eyebrow"><span /> Access boundary</span><h2 id="access-dialog-title">{worker.name}</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      {!worker.managedBySkywatch && worker.accessStatus === 'protected' && <div className="dialog-notice"><ShieldCheck size={16} /><span>This Access application was created outside Skywatch. It is shown here but will not be overwritten.</span></div>}
      <div className="mode-switch">
        <button type="button" className={mode === 'public' ? 'active' : ''} onClick={() => setMode('public')}><Globe2 size={16} /><span><strong>Public</strong><small>Anyone can open this Worker</small></span></button>
        <button type="button" className={mode === 'protected' ? 'active' : ''} onClick={() => setMode('protected')}><LockKeyhole size={16} /><span><strong>Cloudflare Access</strong><small>Only listed emails can open it</small></span></button>
      </div>
      {mode === 'protected' && <label className="email-field">Allowed email addresses<textarea value={emails} onChange={(event) => setEmails(event.target.value)} placeholder={'you@example.com\nteam@example.com'} rows={5} /><small>One email per line. Skywatch creates a dedicated allow policy.</small></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="dialog-cancel" onClick={onClose}>Cancel</button><button type="button" className="dialog-save" disabled={saving || (!worker.managedBySkywatch && worker.accessStatus === 'protected')} onClick={() => void save()}>{saving ? 'Saving…' : 'Save access'}</button></footer>
    </section>
  </div>
}

function Dashboard({ account, onLogout }: { account: { id: string; name: string }; onLogout: () => void }) {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [filter, setFilter] = useState<'all' | AccessType>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Worker | null>(null)

  const loadWorkers = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api<WorkersResponse>('/api/workers')
      setWorkers(result.workers)
      setSyncedAt(result.syncedAt)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Workers could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadWorkers() }, [])

  const filtered = useMemo(() => workers.filter((worker) =>
    (filter === 'all' || worker.accessStatus === filter)
    && (worker.name.toLowerCase().includes(query.toLowerCase()) || worker.emails.some((email) => email.includes(query.toLowerCase()))),
  ), [filter, query, workers])
  const protectedCount = workers.filter((worker) => worker.accessStatus === 'protected').length
  const identityCount = new Set(workers.flatMap((worker) => worker.emails)).size
  const initials = account.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="sidebar-top"><Logo /><button className="mobile-close" type="button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={19} /></button></div>
        <nav>
          <span className="nav-label">Workspace</span>
          <a className="nav-link active" href="#workers"><LayoutGrid size={17} /> Workers <span>{workers.length}</span></a>
          <a className="nav-link" href="#workers"><Users size={17} /> Access rules</a>
          <span className="nav-label second">Manage</span>
          <button className="nav-link nav-button" type="button" onClick={onLogout}><LogOut size={17} /> Lock Skywatch</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="account-chip"><span className="avatar">{initials || 'CF'}</span><div><strong>{account.name}</strong><span>{account.id.slice(0, 10)}…</span></div><ChevronDown size={15} /></div>
          <div className="sync-state"><span /><span><strong>Cloudflare {error ? 'needs attention' : 'synced'}</strong>{syncedAt ? relativeDate(syncedAt) : 'connecting'}</span></div>
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

      <section className="workspace" id="workers">
        <header className="topbar">
          <button className="mobile-menu" type="button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Workers or emails" aria-label="Search Workers" /></div>
          <div className="topbar-actions"><button className="secondary-button" type="button" disabled={loading} onClick={() => void loadWorkers()}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Refresh</button></div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div><span className="eyebrow"><span /> Live inventory</span><h1>Workers</h1><p>Every service and its access boundary, in one place.</p></div>
            <div className="sync-pill"><span className="pulse" /> {syncedAt ? `Synced ${relativeDate(syncedAt)}` : 'Connecting'}</div>
          </div>

          <div className="overview-strip">
            <div><span className="strip-label">Services</span><strong>{String(workers.length).padStart(2, '0')}</strong><small>deployed Workers</small></div>
            <div><span className="strip-label">Access boundary</span><strong>{String(protectedCount).padStart(2, '0')} <em>/ {String(workers.length).padStart(2, '0')}</em></strong><small>Workers protected</small></div>
            <div><span className="strip-label">Allowed identities</span><strong>{String(identityCount).padStart(2, '0')}</strong><small>unique email rules</small></div>
            <div className="access-rail-legend" aria-label="Access distribution">
              {workers.slice(0, 8).map((worker) => <span key={worker.id} className={`${worker.accessStatus}-segment`} />)}
              {workers.length === 0 && <span className="public-segment" />}
              <small><LockKeyhole size={12} /> {workers.length ? Math.round(protectedCount / workers.length * 100) : 0}% behind Access</small>
            </div>
          </div>

          <div className="list-toolbar">
            <div className="filters" role="group" aria-label="Filter workers">
              {(['all', 'protected', 'public'] as const).map((item) => <button key={item} type="button" className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? 'All Workers' : item === 'protected' ? 'Protected' : 'Public'}</button>)}
            </div>
            <span className="result-count">{filtered.length} {filtered.length === 1 ? 'service' : 'services'}</span>
          </div>

          {error && <div className="dashboard-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadWorkers()}>Try again</button></div>}
          <div className="worker-list" aria-busy={loading}>
            {loading && workers.length === 0 && <div className="empty-state"><RefreshCw className="spin" size={22} /><h2>Loading Workers</h2><p>Reading scripts and Access policies from Cloudflare.</p></div>}
            {!loading && filtered.map((worker) => (
              <article className="worker-card" key={worker.id}>
                <span className={`card-access-rail ${worker.accessStatus}`} aria-hidden="true" />
                <div className="worker-primary"><div className="worker-icon"><Cloud size={19} /></div><div><h2>{worker.name}</h2><p>Worker ID · {worker.id.slice(0, 12)}…</p></div></div>
                <div className="worker-traffic"><span>Policies</span><strong>{worker.policyCount}</strong></div>
                <div className="worker-access"><AccessBadge type={worker.accessStatus} /><span>{worker.accessStatus === 'protected' ? `${worker.emails.length} allowed ${worker.emails.length === 1 ? 'email' : 'emails'}` : 'Anyone can open'}</span></div>
                <div className="worker-users">
                  {worker.emails.length > 0 ? <><div className="avatar-stack">{worker.emails.slice(0, 3).map((email) => <span key={email}>{email.slice(0, 2).toUpperCase()}</span>)}</div><div className="email-list">{worker.emails.slice(0, 2).map((email) => <span key={email}>{email}</span>)}{worker.emails.length > 2 && <span>+{worker.emails.length - 2} more</span>}</div></> : <span className="no-rules"><Globe2 size={15} /> No email rules</span>}
                </div>
                <div className="worker-actions"><span>Updated {relativeDate(worker.modifiedAt)}</span><button type="button" onClick={() => setSelected(worker)} aria-label={`Manage access for ${worker.name}`}><MoreHorizontal size={19} /></button></div>
              </article>
            ))}
            {!loading && filtered.length === 0 && !error && <div className="empty-state"><Search size={22} /><h2>No Workers found</h2><p>Try another search or access filter.</p></div>}
          </div>
        </div>
      </section>
      {selected && <AccessDialog worker={selected} onClose={() => setSelected(null)} onSaved={loadWorkers} />}
    </main>
  )
}

export default function App() {
  const [mode, setMode] = useState<AppMode>('loading')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [bootError, setBootError] = useState('')

  const loadStatus = async () => {
    setBootError('')
    try {
      const next = await api<StatusResponse>('/api/status')
      setStatus(next)
      setMode(!next.configured ? 'setup' : next.authenticated ? 'dashboard' : 'unlock')
    } catch (caught) {
      setBootError(caught instanceof Error ? caught.message : 'Skywatch could not start.')
    }
  }

  useEffect(() => { void loadStatus() }, [])

  const logout = async () => {
    await api('/api/logout', { method: 'POST', body: '{}' })
    setMode('unlock')
  }

  if (bootError) return <main className="boot-state"><Logo /><h1>Skywatch could not start</h1><p>{bootError}</p><button type="button" onClick={() => void loadStatus()}>Try again</button></main>
  if (mode === 'loading') return <main className="boot-state"><Logo /><RefreshCw className="spin" size={23} /><p>Connecting the D1 vault…</p></main>
  if (mode === 'setup' || mode === 'unlock') return <SetupScreen mode={mode} onConnected={(next) => { setStatus(next); setMode('dashboard') }} />
  if (!status?.account) return <main className="boot-state"><Logo /><Settings size={23} /><p>Account details are unavailable.</p></main>
  return <Dashboard account={status.account} onLogout={() => void logout()} />
}
