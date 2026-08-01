import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  Database,
  Globe2,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  MemoryStick,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Users,
  Wifi,
  WifiOff,
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
  encryption: 'pending' | 'finalizing' | 'ready' | 'mismatch'
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

type SeatUsage = {
  available: boolean
  used: number | null
  limit: number | null
  access: number | null
  gateway: number | null
  message?: string
}

type WorkersResponse = { workers: Worker[]; seatUsage: SeatUsage; syncedAt: string }
type ApiError = { error?: string; code?: string }

type AgentTransport = 'vpc' | 'direct'
type AgentNode = { id: string; name: string; agentVersion?: string }
type AgentConfig = {
  id: string
  transport: AgentTransport
  endpoint: string
  allowInsecureHttp: boolean
  node: AgentNode
  connectedAt: string
  updatedAt: string
}
type AgentConfigsResponse = { servers: AgentConfig[] }
type AgentHealth = {
  status: 'ok' | 'degraded'
  node: { id: string; name: string }
  agentVersion: string
  uptimeSeconds: number
  dockerAvailable?: boolean
  collectedAt?: string
}
type AgentSystem = {
  node: { id: string; name: string }
  cpu: { usagePercent: number; cores: number }
  memory: { usedBytes: number; totalBytes: number }
  storage: Array<{ mount: string; usedBytes: number; totalBytes: number }>
  load: { one: number; five: number; fifteen: number }
  uptimeSeconds: number
  collectedAt: string
}
type AgentContainer = {
  id: string
  name: string
  image: string
  state: string
  status: string
  createdAt: string | null
  startedAt: string | null
  ports: Array<{ privatePort: number; publicPort: number | null; type: string }>
}
type ContainersResponse = { containers: AgentContainer[]; collectedAt: string }
type AgentAction = 'start' | 'stop' | 'restart'

const setupTasks = [
  { label: 'Prepare encrypted D1 vault', icon: Database },
  { label: 'Connect this Skywatch instance', icon: Cloud },
  { label: 'Create key and encrypt API token', icon: KeyRound },
  { label: 'Sync Workers and Access rules', icon: ShieldCheck },
  { label: 'Protect Skywatch for your email', icon: LockKeyhole },
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
  const [state, setState] = useState<SetupState>('token')
  const [task, setTask] = useState(-1)
  const [error, setError] = useState('')
  const [account, setAccount] = useState<{ id: string; name: string } | null>(null)
  const [protectedEmail, setProtectedEmail] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const autoFinalizeStarted = useRef(false)
  const isUnlock = mode === 'unlock'

  useEffect(() => {
    if (state !== 'working') return
    const timer = window.setInterval(() => {
      setTask((current) => Math.min(current + 1, setupTasks.length - 1))
    }, 1100)
    return () => window.clearInterval(timer)
  }, [state])

  const connect = async (submittedToken = token) => {
    const cleanToken = submittedToken.trim()
    if (cleanToken.length < 20) return
    setError('')
    setState('working')
    setTask(isUnlock ? 2 : 0)
    try {
      if (isUnlock) {
        await api('/api/unlock', { method: 'POST', body: JSON.stringify({ token: cleanToken }) })
        const status = await api<StatusResponse>('/api/status')
        onConnected(status)
        return
      }
      const result = await api<{
        account: { id: string; name: string }
        protection: { email: string; pending: boolean }
      }>('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ token: cleanToken }),
      })
      setAccount(result.account)
      setProtectedEmail(result.protection.email)
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
    setFinalizing(true)
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const status = await api<StatusResponse>('/api/status')
        if (status.encryption === 'ready') {
          if (protectedEmail) {
            await api('/api/protect-self', { method: 'POST', body: '{}' })
            window.location.reload()
            return
          }
          onConnected(status)
          return
        }
        if (status.encryption === 'mismatch') {
          setError('The stored token and Worker encryption key do not match. Reset the broken configuration before retrying setup.')
          return
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200))
      }
      setError('Cloudflare is still attaching the encryption key. Wait a few seconds, then try again.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Skywatch could not enable Cloudflare Access.')
    } finally {
      setFinalizing(false)
    }
  }

  useEffect(() => {
    if (state !== 'complete' || !protectedEmail || autoFinalizeStarted.current) return
    autoFinalizeStarted.current = true
    void finish()
  }, [state, protectedEmail])

  return (
    <main className="setup-shell">
      <div className="setup-wordmark" aria-hidden="true">SKYWATCH</div>

      <section className="setup-center">
        <div className="setup-flow">
          {state === 'token' && (
            <div className="token-view">
              <div className="permission-heading">
                <h1>{isUnlock ? 'Unlock Skywatch' : 'Required token permissions'}</h1>
                <p>{isUnlock ? 'Paste the API token used to set up this instance.' : 'Create a scoped token with exactly these permissions.'}</p>
              </div>

              {!isUnlock && <>
                <div className="permission-list">
                  <div className="permission-row"><span>Account</span><strong>Workers Scripts</strong><em>Read + Edit</em></div>
                  <div className="permission-row"><span>Account</span><strong>Access: Apps and Policies</strong><em>Edit</em></div>
                  <div className="permission-row"><span>Account</span><strong>Access: Audit Logs</strong><em>Read</em></div>
                  <div className="permission-row"><span>User</span><strong>Memberships</strong><em>Read</em></div>
                  <div className="permission-row"><span>User</span><strong>User Details</strong><em>Read</em></div>
                  <div className="permission-row"><span>Resources</span><strong>Include</strong><em>One account</em></div>
                </div>
                <a className="create-token-button" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create token</a>
              </>}

              <form onSubmit={(event) => { event.preventDefault(); void connect() }}>
                <label className="sr-only" htmlFor="api-token">Cloudflare API token</label>
                <input
                  className="token-field"
                  id="api-token"
                  autoComplete="off"
                  spellCheck="false"
                  type="password"
                  placeholder="paste your token here"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  onPaste={(event) => {
                    const pastedToken = event.clipboardData.getData('text').trim()
                    if (pastedToken.length < 20) return
                    event.preventDefault()
                    setToken(pastedToken)
                    window.setTimeout(() => void connect(pastedToken), 0)
                  }}
                />
                {error && <p className="form-error" role="alert">{error}</p>}
              </form>

              <div className="setup-disclaimer"><ShieldCheck size={17} /> Your token is encrypted before it touches storage.</div>
            </div>
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
              <div className="connection-summary"><span><LockKeyhole size={16} /> Access owner</span><strong>{protectedEmail || 'Protected'}</strong></div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button" type="button" disabled={finalizing} onClick={() => void finish()}>{finalizing ? 'Enabling Access…' : 'Continue through Access'} <ArrowRight size={17} /></button>
            </div>
          )}
        </div>
      </section>
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** power).toFixed(power < 2 ? 0 : 1)} ${units[power]}`
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function boundedPercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, used / total * 100))
}

function isInsecureHttpEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === 'http:'
  } catch {
    return endpoint.trim().toLowerCase().startsWith('http:')
  }
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

function ConfirmAgentActionDialog({ container, action, busy, error, onClose, onConfirm }: {
  container: AgentContainer
  action: AgentAction
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-action-title" aria-describedby="agent-action-description">
      <header><div><span className="eyebrow"><span /> Confirm container action</span><h2 id="agent-action-title">{action[0].toUpperCase() + action.slice(1)} {container.name}</h2></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <p id="agent-action-description">Skywatch will send this action once. It will not retry if the result is uncertain.</p>
      <div className="action-target"><Box size={17} /><span><strong>{container.name}</strong><small>{container.image}</small></span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="dialog-cancel" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className={`dialog-save ${action === 'stop' ? 'danger' : ''}`} disabled={busy} onClick={onConfirm}>{busy ? `${action[0].toUpperCase() + action.slice(1)}ing…` : `Confirm ${action}`}</button></footer>
    </section>
  </div>
}

function ContainerLogsDialog({ serverId, container, onClose }: { serverId: string; container: AgentContainer; onClose: () => void }) {
  const [tail, setTail] = useState(200)
  const [logs, setLogs] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [collectedAt, setCollectedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadLogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api<{ containerId: string; logs: string; truncated: boolean; collectedAt: string }>(
        `/api/servers/${encodeURIComponent(serverId)}/containers/${encodeURIComponent(container.id)}/logs?tail=${tail}`,
      )
      setLogs(result.logs)
      setTruncated(result.truncated)
      setCollectedAt(result.collectedAt)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Container logs could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [container.id, serverId, tail])

  useEffect(() => { void loadLogs() }, [loadLogs])

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog logs-dialog" role="dialog" aria-modal="true" aria-labelledby="container-logs-title">
      <header><div><span className="eyebrow"><span /> Finite log snapshot</span><h2 id="container-logs-title">{container.name}</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <div className="logs-toolbar">
        <label>Tail<select value={tail} onChange={(event) => setTail(Number(event.target.value))}>{[100, 200, 500, 1000].map((value) => <option value={value} key={value}>{value} lines</option>)}</select></label>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void loadLogs()}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button>
      </div>
      {error && <div className="dashboard-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadLogs()}>Try again</button></div>}
      <pre className="log-output" aria-busy={loading}>{loading && !logs ? 'Loading finite log snapshot…' : logs || 'No log lines returned.'}</pre>
      <footer className="logs-footer"><span>{truncated ? 'Response capped by the agent · ' : ''}{collectedAt ? `Captured ${relativeDate(collectedAt)}` : 'Not streaming'}</span><button type="button" className="dialog-cancel" onClick={onClose}>Close</button></footer>
    </section>
  </div>
}

function sortServers(servers: AgentConfig[]): AgentConfig[] {
  return [...servers].sort((left, right) => {
    const names = left.node.name.toLowerCase().localeCompare(right.node.name.toLowerCase())
    return names || left.id.localeCompare(right.id)
  })
}

function AgentConfigPanel({ config, vpcInUse, loading, onSaved, onCancel }: {
  config: AgentConfig | null
  vpcInUse: boolean
  loading: boolean
  onSaved: (config: AgentConfig) => void
  onCancel: (() => void) | null
}) {
  const [transport, setTransport] = useState<AgentTransport>(config?.transport ?? 'direct')
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? 'https://agent.example.com')
  const [pairingToken, setPairingToken] = useState('')
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(config?.allowInsecureHttp ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const vpcUnavailable = vpcInUse && config?.transport !== 'vpc'

  const selectTransport = (next: AgentTransport) => {
    if (next === 'vpc' && vpcUnavailable) return
    setTransport(next)
    setAllowInsecureHttp(false)
    if (next === 'vpc' && (!endpoint || endpoint === 'https://agent.example.com')) setEndpoint('http://skywatch-agent.internal')
    if (next === 'direct' && (!endpoint || endpoint === 'http://skywatch-agent.internal')) setEndpoint('https://agent.example.com')
  }

  const insecureHttp = transport === 'direct' && isInsecureHttpEndpoint(endpoint)
  const canSave = endpoint.trim().length > 0
    && (Boolean(config) || pairingToken.trim().length > 0)
    && (!insecureHttp || allowInsecureHttp)

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const path = config ? `/api/servers/${encodeURIComponent(config.id)}` : '/api/servers'
      const result = await api<AgentConfig>(path, {
        method: config ? 'PUT' : 'POST',
        body: JSON.stringify({
          transport,
          endpoint: endpoint.trim(),
          pairingToken: pairingToken.trim(),
          ...(insecureHttp ? { allowInsecureHttp } : {}),
        }),
      })
      onSaved(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The server connection could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return <section className="agent-config-panel" aria-busy={loading || saving}>
    <header><div><span className="eyebrow"><span /> Connection settings</span><h2>{config ? `Update ${config.node.name}` : 'Register another server'}</h2><p>Pair the node once, then Skywatch keeps its transport and encrypted signing key separate.</p></div>{onCancel && <button className="icon-button" type="button" onClick={onCancel} aria-label="Close connection settings"><X size={17} /></button>}</header>
    {error && <div className="dashboard-error" role="alert"><span>{error}</span></div>}
    <div className="transport-switch" role="radiogroup" aria-label="Agent transport">
      <button type="button" role="radio" aria-checked={transport === 'vpc'} disabled={vpcUnavailable} className={transport === 'vpc' ? 'active' : ''} onClick={() => selectTransport('vpc')}><Cloud size={18} /><span><strong>Cloudflare VPC</strong><small>{vpcUnavailable ? 'Static binding already assigned' : 'Private, fixed-scope binding'}</small></span><em>One slot</em></button>
      <button type="button" role="radio" aria-checked={transport === 'direct'} className={transport === 'direct' ? 'active' : ''} onClick={() => selectTransport('direct')}><Globe2 size={18} /><span><strong>Direct endpoint</strong><small>HTTPS Tunnel or public origin</small></span></button>
    </div>
    <div className="agent-fields">
      <label><span>{transport === 'vpc' ? 'Tunnel request URL' : 'Public agent URL'}</span><input type="url" spellCheck="false" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setAllowInsecureHttp(false) }} placeholder={transport === 'vpc' ? 'http://skywatch-agent.internal' : 'https://agent.example.com'} /><small>{transport === 'vpc' ? 'The single VPS_AGENT binding fixes the destination. Additional servers should use direct HTTPS.' : 'Use a Cloudflare Tunnel hostname or another public HTTPS origin. Redirects are rejected.'}</small></label>
      <label><span>Agent pairing key</span><input type="password" autoComplete="new-password" spellCheck="false" value={pairingToken} onChange={(event) => setPairingToken(event.target.value)} placeholder={config ? 'Leave blank to keep the encrypted key' : 'key-id.base64url-secret'} /><small>{config ? 'Leave blank to reuse this server’s encrypted key.' : 'Run skywatch pairing-key on this VPS. The secret is never returned by Skywatch.'}</small></label>
    </div>
    {insecureHttp && <div className="insecure-warning" role="alert"><AlertTriangle size={18} /><div><strong>HTTP exposes control traffic on the public internet.</strong><p>Only literal public IP addresses can use this escape hatch. Metrics, logs, and action metadata are not encrypted.</p><label><input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} /> I understand the risk and want to allow insecure HTTP.</label></div></div>}
    <footer><span>{loading ? 'Loading registered servers…' : 'Skywatch verifies the signed node identity before saving.'}</span><button className="dialog-save" type="button" disabled={loading || saving || !canSave} onClick={() => void save()}>{saving ? 'Testing connection…' : config ? 'Test and update' : 'Test and register'}</button></footer>
  </section>
}

function ServerWorkspace({ config, deleting, onEdit, onDelete }: {
  config: AgentConfig
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [health, setHealth] = useState<AgentHealth | null>(null)
  const [system, setSystem] = useState<AgentSystem | null>(null)
  const [containers, setContainers] = useState<AgentContainer[]>([])
  const [containersAt, setContainersAt] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)
  const [pollError, setPollError] = useState('')
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<{ container: AgentContainer; action: AgentAction } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [logsContainer, setLogsContainer] = useState<AgentContainer | null>(null)
  const pollInFlight = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const fetchLive = useCallback(async (): Promise<boolean> => {
    if (pollInFlight.current) return false
    pollInFlight.current = true
    setPolling(true)
    const base = `/api/servers/${encodeURIComponent(config.id)}`
    const [healthResult, systemResult, containersResult] = await Promise.allSettled([
      api<AgentHealth>(`${base}/health`),
      api<AgentSystem>(`${base}/system`),
      api<ContainersResponse>(`${base}/containers`),
    ])
    if (!mounted.current) return false
    let firstError = ''
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value)
    else firstError ||= healthResult.reason instanceof Error ? healthResult.reason.message : 'Agent health is unavailable.'
    if (systemResult.status === 'fulfilled') setSystem(systemResult.value)
    else firstError ||= systemResult.reason instanceof Error ? systemResult.reason.message : 'System metrics are unavailable.'
    if (containersResult.status === 'fulfilled') {
      setContainers(containersResult.value.containers)
      setContainersAt(containersResult.value.collectedAt)
    } else firstError ||= containersResult.reason instanceof Error ? containersResult.reason.message : 'Containers are unavailable.'
    const successful = !firstError
    if (successful) {
      setPollError('')
      setLastSuccessAt(new Date().toISOString())
    } else {
      setPollError(firstError)
    }
    pollInFlight.current = false
    setPolling(false)
    return successful
  }, [config.id])

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    let failures = 0
    const schedule = (delay: number) => {
      window.clearTimeout(timer)
      if (!stopped && document.visibilityState === 'visible') timer = window.setTimeout(() => void cycle(), delay)
    }
    const cycle = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      const successful = await fetchLive()
      failures = successful ? 0 : Math.min(failures + 1, 4)
      schedule(successful ? 5000 : Math.min(60_000, 5000 * 2 ** failures))
    }
    const visibilityChanged = () => {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible') void cycle()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    void cycle()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [fetchLive])

  const runAction = async () => {
    if (!pendingAction || actionBusy) return
    setActionBusy(true)
    setActionError('')
    try {
      const result = await api<{ action: AgentAction; container: AgentContainer; completedAt: string }>(
        `/api/servers/${encodeURIComponent(config.id)}/containers/${encodeURIComponent(pendingAction.container.id)}/${pendingAction.action}`,
        { method: 'POST', body: '{}' },
      )
      setContainers((current) => current.map((container) => container.id === result.container.id ? result.container : container))
      setPendingAction(null)
      void fetchLive()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'The container action could not be completed.')
    } finally {
      setActionBusy(false)
    }
  }

  const storage = system?.storage.find((disk) => disk.mount === '/') ?? system?.storage[0]
  const runningCount = containers.filter((container) => container.state.toLowerCase() === 'running').length
  const stale = Boolean(pollError && lastSuccessAt)
  const healthDegraded = health?.status === 'degraded' || health?.dockerAvailable === false

  return <>
    <div className="selected-server-status">
      <div><span className="eyebrow"><span /> Selected node</span><strong>{config.node.name}</strong></div>
      <div className={`agent-state ${pollError || healthDegraded ? 'degraded' : 'online'}`}>{pollError || healthDegraded ? <WifiOff size={14} /> : <Wifi size={14} />}<span><strong>{pollError ? stale ? 'Stale data' : 'Agent unavailable' : healthDegraded ? 'Docker degraded' : 'Agent connected'}</strong>{lastSuccessAt ? `Updated ${relativeDate(lastSuccessAt)}` : 'Waiting for first sample'}</span></div>
    </div>
    <section className="agent-connection-card">
      <div className="connection-identity"><span className="server-mark"><Server size={21} /></span><div><span className="eyebrow"><span /> Paired node</span><h2>{config.node.name}</h2><p>{config.node.id}</p></div></div>
      <dl><div><dt>Transport</dt><dd><span className={`transport-tag ${config.transport} ${config.transport === 'direct' && isInsecureHttpEndpoint(config.endpoint ?? '') ? 'unsafe' : ''}`}>{config.transport === 'vpc' ? 'VPC tunnel' : isInsecureHttpEndpoint(config.endpoint ?? '') ? 'Direct HTTP · Unsafe' : 'Direct HTTPS'}</span></dd></div><div><dt>Endpoint</dt><dd>{config.endpoint}</dd></div><div><dt>Agent</dt><dd>{config.node?.agentVersion ?? health?.agentVersion ?? 'Checking…'}</dd></div></dl>
      <div className="connection-actions"><button type="button" className="secondary-button" onClick={onEdit}><Settings size={15} /> Edit</button><button type="button" className="icon-button danger-icon" disabled={deleting} onClick={onDelete} aria-label={`Delete ${config.node.name}`}><Trash2 size={16} /></button></div>
    </section>
      {pollError && <div className="dashboard-error stale-error" role="alert"><span>{pollError}{lastSuccessAt ? ` Showing the last successful sample from ${relativeDate(lastSuccessAt)}.` : ''}</span><button type="button" disabled={polling} onClick={() => void fetchLive()}>Retry now</button></div>}
      <div className="server-toolbar"><div><span className="result-count">Auto-refreshes every 5 seconds while this tab is visible</span>{polling && <RefreshCw className="spin" size={13} />}</div><button className="secondary-button" type="button" disabled={polling} onClick={() => void fetchLive()}><RefreshCw size={15} className={polling ? 'spin' : ''} /> Refresh now</button></div>

      <section className="metrics-grid" aria-label="Server metrics" aria-busy={polling && !system}>
        <article><span className="metric-icon"><Cpu size={18} /></span><div><span>CPU usage</span><strong>{system ? `${system.cpu.usagePercent.toFixed(1)}%` : '—'}</strong><small>{system ? `${system.cpu.cores} logical cores` : 'Waiting for metrics'}</small></div><i style={{ '--metric-fill': `${system?.cpu.usagePercent ?? 0}%` } as CSSProperties} /></article>
        <article><span className="metric-icon"><MemoryStick size={18} /></span><div><span>Memory</span><strong>{system ? `${boundedPercent(system.memory.usedBytes, system.memory.totalBytes).toFixed(1)}%` : '—'}</strong><small>{system ? `${formatBytes(system.memory.usedBytes)} of ${formatBytes(system.memory.totalBytes)}` : 'Waiting for metrics'}</small></div><i style={{ '--metric-fill': `${system ? boundedPercent(system.memory.usedBytes, system.memory.totalBytes) : 0}%` } as CSSProperties} /></article>
        <article><span className="metric-icon"><HardDrive size={18} /></span><div><span>Storage {storage?.mount ? `· ${storage.mount}` : ''}</span><strong>{storage ? `${boundedPercent(storage.usedBytes, storage.totalBytes).toFixed(1)}%` : '—'}</strong><small>{storage ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)}` : 'Waiting for metrics'}</small></div><i style={{ '--metric-fill': `${storage ? boundedPercent(storage.usedBytes, storage.totalBytes) : 0}%` } as CSSProperties} /></article>
        <article><span className="metric-icon"><Activity size={18} /></span><div><span>Load average</span><strong>{system ? system.load.one.toFixed(2) : '—'}</strong><small>{system ? `${system.load.five.toFixed(2)} · ${system.load.fifteen.toFixed(2)} · up ${formatUptime(system.uptimeSeconds)}` : 'Waiting for metrics'}</small></div></article>
      </section>

      <section className="containers-section">
        <header><div><span className="eyebrow"><span /> Docker inventory</span><h2>Containers</h2><p>{runningCount} running · {containers.length - runningCount} stopped · {containersAt ? `sampled ${relativeDate(containersAt)}` : 'waiting for agent'}</p></div><span className="container-count"><Box size={15} /> {containers.length}</span></header>
        <div className="container-list">
          {!system && containers.length === 0 && polling && <div className="empty-state"><RefreshCw className="spin" size={22} /><h2>Reading server state</h2><p>The first signed metrics request is in flight.</p></div>}
          {!polling && containers.length === 0 && !pollError && <div className="empty-state"><Box size={22} /><h2>No containers found</h2><p>The agent is connected, but Docker returned an empty inventory.</p></div>}
          {containers.map((container) => {
            const running = container.state.toLowerCase() === 'running'
            return <article className="container-card" key={container.id}>
              <span className={`container-state-dot ${running ? 'running' : 'stopped'}`} aria-label={container.state} />
              <div className="container-primary"><span className="container-icon"><Box size={18} /></span><div><h3>{container.name}</h3><p>{container.image}</p></div></div>
              <div className="container-status"><span className={`state-badge ${running ? 'running' : 'stopped'}`}>{container.state}</span><small>{container.status}</small></div>
              <div className="container-ports"><span>Ports</span><strong>{container.ports.length ? container.ports.slice(0, 2).map((port) => `${port.publicPort ?? '—'}:${port.privatePort}/${port.type}`).join(' · ') : 'None exposed'}</strong></div>
              <div className="container-actions">
                <button type="button" onClick={() => setLogsContainer(container)}><Terminal size={15} /> Logs</button>
                {running ? <><button type="button" onClick={() => { setActionError(''); setPendingAction({ container, action: 'restart' }) }}><RotateCw size={15} /> Restart</button><button type="button" className="danger" onClick={() => { setActionError(''); setPendingAction({ container, action: 'stop' }) }}><Square size={14} /> Stop</button></> : <button type="button" onClick={() => { setActionError(''); setPendingAction({ container, action: 'start' }) }}><Play size={15} /> Start</button>}
              </div>
            </article>
          })}
        </div>
      </section>
    {pendingAction && <ConfirmAgentActionDialog container={pendingAction.container} action={pendingAction.action} busy={actionBusy} error={actionError} onClose={() => { if (!actionBusy) setPendingAction(null) }} onConfirm={() => void runAction()} />}
    {logsContainer && <ContainerLogsDialog serverId={config.id} container={logsContainer} onClose={() => setLogsContainer(null)} />}
  </>
}

function ServersDashboard() {
  const [servers, setServers] = useState<AgentConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<'add' | 'edit' | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const result = await api<AgentConfigsResponse>('/api/servers')
        if (cancelled) return
        const next = sortServers(result.servers)
        setServers(next)
        setSelectedId((current) => current && next.some((server) => server.id === current) ? current : next[0]?.id ?? null)
        setFormMode(next.length ? null : 'add')
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Registered servers could not be loaded.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const selected = servers.find((server) => server.id === selectedId) ?? null
  const formConfig = formMode === 'edit' ? selected : null
  const vpcInUse = servers.some((server) => server.transport === 'vpc')

  const saved = (server: AgentConfig) => {
    setServers((current) => sortServers([...current.filter((item) => item.id !== server.id), server]))
    setSelectedId(server.id)
    setFormMode(null)
    setError('')
  }

  const deleteSelected = async () => {
    if (!selected || deleting) return
    if (!window.confirm(`Disconnect ${selected.node.name} from Skywatch? The agent keeps running, but its stored pairing credentials will be removed.`)) return
    setDeleting(true)
    setError('')
    try {
      await api(`/api/servers/${encodeURIComponent(selected.id)}`, { method: 'DELETE' })
      const remaining = servers.filter((server) => server.id !== selected.id)
      setServers(remaining)
      setSelectedId(remaining[0]?.id ?? null)
      setFormMode(remaining.length ? null : 'add')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The server connection could not be deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return <div className="content servers-content">
    <div className="page-heading servers-heading">
      <div><span className="eyebrow"><span /> Host control plane</span><h1>Servers</h1><p>Switch between registered nodes without mixing their metrics, logs, or controls.</p></div>
      <button className="secondary-button add-server-button" type="button" onClick={() => setFormMode('add')}><Plus size={16} /> Add server</button>
    </div>

    <section className="server-fleet" aria-label="Registered servers">
      <header><span>Registered nodes</span><strong>{servers.length}</strong><small>Only the selected node is polled</small></header>
      <div className="server-rack">
        {servers.map((server) => <button key={server.id} type="button" className={server.id === selectedId ? 'active' : ''} aria-pressed={server.id === selectedId} onClick={() => { setSelectedId(server.id); setFormMode(null) }}><i /><span><strong>{server.node.name}</strong><small>{server.transport === 'vpc' ? 'VPC binding' : isInsecureHttpEndpoint(server.endpoint) ? 'Direct HTTP' : 'Direct HTTPS'}</small></span><em>{server.node.agentVersion ?? 'agent'}</em></button>)}
        {!servers.length && !loading && <div className="server-rack-empty"><Server size={18} /><span><strong>No registered nodes</strong><small>Pair the first VPS to begin.</small></span></div>}
      </div>
    </section>

    {error && <div className="dashboard-error" role="alert"><span>{error}</span></div>}
    {loading && !servers.length && <div className="empty-state"><RefreshCw className="spin" size={22} /><h2>Loading server registry</h2><p>Reading encrypted agent connections from D1.</p></div>}

    {formMode && <AgentConfigPanel key={formMode === 'edit' && formConfig ? formConfig.id : 'new-server'} config={formConfig} vpcInUse={vpcInUse} loading={loading} onSaved={saved} onCancel={servers.length ? () => setFormMode(null) : null} />}
    {!formMode && selected && <ServerWorkspace key={selected.id} config={selected} deleting={deleting} onEdit={() => setFormMode('edit')} onDelete={() => void deleteSelected()} />}
  </div>
}

function Dashboard({ account }: { account: { id: string; name: string } }) {
  const [section, setSection] = useState<'workers' | 'servers'>('workers')
  const [workers, setWorkers] = useState<Worker[]>([])
  const [seatUsage, setSeatUsage] = useState<SeatUsage | null>(null)
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
      setSeatUsage(result.seatUsage)
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
  const initials = account.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="sidebar-top"><Logo /><button className="mobile-close" type="button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={19} /></button></div>
        <nav>
          <span className="nav-label">Workspace</span>
          <button className={`nav-link nav-button ${section === 'workers' ? 'active' : ''}`} type="button" onClick={() => { setSection('workers'); setMobileNav(false) }}><LayoutGrid size={17} /> Workers <span>{workers.length}</span></button>
          <button className={`nav-link nav-button ${section === 'servers' ? 'active' : ''}`} type="button" onClick={() => { setSection('servers'); setMobileNav(false) }}><Server size={17} /> Servers</button>
          <button className="nav-link nav-button" type="button" onClick={() => { setSection('workers'); setFilter('all'); setMobileNav(false) }}><Users size={17} /> Access rules</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="account-chip"><span className="avatar">{initials || 'CF'}</span><div><strong>{account.name}</strong><span>{account.id.slice(0, 10)}…</span></div><ChevronDown size={15} /></div>
          <div className="sync-state"><span /><span><strong>Cloudflare {error ? 'needs attention' : 'synced'}</strong>{syncedAt ? relativeDate(syncedAt) : 'connecting'}</span></div>
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

      <section className="workspace" id={section}>
        <header className="topbar">
          <button className="mobile-menu" type="button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          {section === 'workers'
            ? <><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Workers or emails" aria-label="Search Workers" /></div><div className="topbar-actions"><button className="secondary-button" type="button" disabled={loading} onClick={() => void loadWorkers()}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Refresh</button></div></>
            : <div className="topbar-section"><Server size={16} /><span>Server operations</span></div>}
        </header>

        {section === 'workers' ? <div className="content">
          <div className="page-heading">
            <div><span className="eyebrow"><span /> Live inventory</span><h1>Workers</h1><p>Every service and its access boundary, in one place.</p></div>
            <div className="sync-pill"><span className="pulse" /> {syncedAt ? `Synced ${relativeDate(syncedAt)}` : 'Connecting'}</div>
          </div>

          <div className="overview-strip">
            <div><span className="strip-label">Services</span><strong>{String(workers.length).padStart(2, '0')}</strong><small>deployed Workers</small></div>
            <div><span className="strip-label">Access boundary</span><strong>{String(protectedCount).padStart(2, '0')} <em>/ {String(workers.length).padStart(2, '0')}</em></strong><small>Workers protected</small></div>
            <div className="seat-usage" title={seatUsage?.message}>
              <span className="strip-label">User limit usage</span>
              <strong>
                {seatUsage?.available ? String(seatUsage.used ?? 0).padStart(2, '0') : '—'}
                {seatUsage?.available && seatUsage.limit !== null && <em> / {seatUsage.limit}</em>}
              </strong>
              <small>{seatUsage?.available
                ? seatUsage.limit === null
                  ? `${seatUsage.access ?? 0} Access · ${seatUsage.gateway ?? 0} Gateway seats`
                  : `${Math.max(0, seatUsage.limit - (seatUsage.used ?? 0))} seats remaining`
                : seatUsage?.message ?? 'reading active seats'}</small>
            </div>
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
        </div> : <ServersDashboard />}
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

  if (bootError) return <main className="boot-state"><Logo /><h1>Skywatch could not start</h1><p>{bootError}</p><button type="button" onClick={() => void loadStatus()}>Try again</button></main>
  if (mode === 'loading') return <main className="boot-state"><Logo /><RefreshCw className="spin" size={23} /><p>Connecting the D1 vault…</p></main>
  if (mode === 'setup' || mode === 'unlock') return <SetupScreen mode={mode} onConnected={(next) => { setStatus(next); setMode('dashboard') }} />
  if (!status?.account) return <main className="boot-state"><Logo /><Settings size={23} /><p>Account details are unavailable.</p></main>
  return <Dashboard account={status.account} />
}
