import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Cpu,
  Database,
  FolderGit2,
  GitBranch,
  Globe2,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  MemoryStick,
  Menu,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'

type SetupState = 'token' | 'working' | 'complete'
type AccessType = 'protected' | 'public'
type AppMode = 'loading' | 'setup' | 'dashboard'

type StatusResponse = {
  configured: boolean
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

type WorkersResponse = { workers: Worker[]; syncedAt: string }
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

type SourceType = 'compose' | 'github' | 'image' | 'script'
type DeploymentStatus = 'pending' | 'running' | 'success' | 'failed' | 'removed'
type Deployment = {
  id: string
  projectId: string
  targetType: 'vps' | 'cloudflare'
  targetServerId: string | null
  targetName: string | null
  status: DeploymentStatus
  detail: string | null
  createdAt: string
  updatedAt: string
}
type ProjectSummary = {
  id: string
  name: string
  sourceType: SourceType
  sourceConfig: Record<string, unknown>
  hasEnv: boolean
  createdAt: string
  updatedAt: string
  latestDeployment: Deployment | null
}
type ProjectDetail = ProjectSummary & { env: string; deployments: Deployment[] }
type ProjectsResponse = { projects: ProjectSummary[] }
type GitHubCredential = { configured: boolean; label: string | null; updatedAt: string | null }

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
      <span className="brand-mark" aria-hidden="true"><img src="/skywatch-cloud-eye.png" alt="" /></span>
      <span>skywatch</span>
    </div>
  )
}

function SetupScreen({ onConnected }: { onConnected: (status: StatusResponse) => void }) {
  const [token, setToken] = useState('')
  const [state, setState] = useState<SetupState>('token')
  const [task, setTask] = useState(-1)
  const [error, setError] = useState('')
  const [account, setAccount] = useState<{ id: string; name: string } | null>(null)
  const [protectedEmail, setProtectedEmail] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const autoFinalizeStarted = useRef(false)
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
    setTask(0)
    try {
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
                <h1>Required token permissions</h1>
                <p>Create a scoped token with exactly these permissions.</p>
              </div>

              <>
                <div className="permission-list">
                  <div className="permission-row"><span>Account</span><strong>Workers Scripts</strong><em>Read + Edit</em></div>
                  <div className="permission-row"><span>Account</span><strong>Access: Apps and Policies</strong><em>Edit</em></div>
                  <div className="permission-row"><span>Account</span><strong>Access: Audit Logs</strong><em>Read</em></div>
                  <div className="permission-row"><span>User</span><strong>Memberships</strong><em>Read</em></div>
                  <div className="permission-row"><span>User</span><strong>User Details</strong><em>Read</em></div>
                  <div className="permission-row"><span>Resources</span><strong>Include</strong><em>One account</em></div>
                </div>
                <a className="create-token-button" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create token</a>
              </>

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
              <h2>Setting up Skywatch</h2>
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

export type EnvRow = { key: string; value: string }

export function parseEnv(text: string): EnvRow[] {
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return []
    const index = line.indexOf('=')
    if (index < 0) return []
    const key = line.slice(0, index).trim()
    if (!key) return []
    return [{ key, value: line.slice(index + 1).trim() }]
  })
}

export function serializeEnv(rows: EnvRow[]): string {
  return rows
    .filter((row) => row.key.trim())
    .map((row) => `${row.key.trim()}=${row.value}`)
    .join('\n')
}

const WORKER_NAME_RE = /^[a-z0-9](-?[a-z0-9]){0,62}$/

export function slugifyWorkerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}

const sourceTypeLabels: Record<SourceType, string> = {
  compose: 'Compose',
  github: 'GitHub',
  image: 'Image',
  script: 'Worker script',
}

function projectSourceSummary(project: ProjectSummary): string {
  const config = project.sourceConfig
  if (project.sourceType === 'github') {
    const repo = typeof config.repoUrl === 'string' && config.repoUrl ? config.repoUrl : 'repository'
    const branch = typeof config.branch === 'string' && config.branch ? `#${config.branch}` : ''
    return `${repo}${branch}`
  }
  if (project.sourceType === 'image') return typeof config.image === 'string' && config.image ? config.image : 'image'
  if (project.sourceType === 'compose') return 'compose.yaml'
  return 'worker script'
}

function deploymentTargetLabel(deployment: Deployment, servers: AgentConfig[]): string {
  if (deployment.targetType === 'cloudflare') return `worker:${deployment.targetName ?? 'unnamed'}`
  const server = deployment.targetServerId ? servers.find((item) => item.id === deployment.targetServerId) : null
  return server?.node.name ?? deployment.targetName ?? deployment.targetServerId ?? 'unknown server'
}

function DeploymentStatusPill({ status }: { status: DeploymentStatus }) {
  return <span className={`state-badge ${status}`}>{status}</span>
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
      <div><h1>Servers</h1><p>Switch between registered nodes without mixing their metrics, logs, or controls.</p></div>
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

function ConfirmDialog({ eyebrow, title, description, confirmLabel, busy, error, onClose, onConfirm }: {
  eyebrow: string
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description">
      <header><div><span className="eyebrow"><span /> {eyebrow}</span><h2 id="confirm-dialog-title">{title}</h2></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <p id="confirm-dialog-description">{description}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="dialog-cancel" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="dialog-save danger" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</button></footer>
    </section>
  </div>
}

function EnvEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [mode, setMode] = useState<'plain' | 'pairs'>('plain')
  const [rows, setRows] = useState<EnvRow[]>([])

  const switchMode = (next: 'plain' | 'pairs') => {
    if (next === 'pairs') setRows(parseEnv(value))
    setMode(next)
  }

  const updateRows = (nextRows: EnvRow[]) => {
    setRows(nextRows)
    onChange(serializeEnv(nextRows))
  }

  return <div className="env-editor">
    <div className="env-editor-header">
      <span>Environment variables</span>
      <div className="env-mode-toggle" role="group" aria-label="Environment editor mode">
        <button type="button" className={mode === 'pairs' ? 'active' : ''} aria-pressed={mode === 'pairs'} onClick={() => switchMode('pairs')}>Key/value</button>
        <button type="button" className={mode === 'plain' ? 'active' : ''} aria-pressed={mode === 'plain'} onClick={() => switchMode('plain')}>Plain text</button>
      </div>
    </div>
    {mode === 'plain'
      ? <textarea rows={6} value={value} onChange={(event) => onChange(event.target.value)} placeholder={'KEY=value\nANOTHER=thing'} aria-label="Environment variables as text" spellCheck={false} />
      : <>
          {rows.length === 0 && <p className="env-empty">No variables yet. Add one below or switch to plain text.</p>}
          <div className="env-rows">
            {rows.map((row, index) => <div className="env-row" key={index}>
              <input aria-label={`Variable key ${index + 1}`} placeholder="KEY" value={row.key} spellCheck={false} onChange={(event) => updateRows(rows.map((item, position) => position === index ? { ...item, key: event.target.value } : item))} />
              <input aria-label={`Variable value ${index + 1}`} placeholder="value" value={row.value} spellCheck={false} onChange={(event) => updateRows(rows.map((item, position) => position === index ? { ...item, value: event.target.value } : item))} />
              <button type="button" aria-label={`Remove variable ${index + 1}`} onClick={() => updateRows(rows.filter((_, position) => position !== index))}><X size={13} /></button>
            </div>)}
          </div>
          <button type="button" className="env-add-row" onClick={() => updateRows([...rows, { key: '', value: '' }])}><Plus size={13} /> Add variable</button>
        </>}
    <small>Stored encrypted. Comments and blank lines are dropped when you edit in key/value mode.</small>
  </div>
}

const DEFAULT_WORKER_SCRIPT = 'export default {\n  async fetch(request, env) {\n    return new Response("Hello from Skywatch!");\n  }\n};'
const COMPOSE_PLACEHOLDER = 'services:\n  app:\n    image: ghcr.io/user/app:latest\n    ports:\n      - "8080:8080"'

function ProjectFormDialog({ project, onClose, onSaved }: {
  project: ProjectDetail | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const config = project?.sourceConfig ?? {}
  const configText = (key: string): string => {
    const entry = config[key]
    return typeof entry === 'string' ? entry : ''
  }
  const [name, setName] = useState(project?.name ?? '')
  const [sourceType, setSourceType] = useState<SourceType>(project?.sourceType ?? 'compose')
  const [compose, setCompose] = useState(project?.sourceType === 'compose' ? configText('compose') : '')
  const [repoUrl, setRepoUrl] = useState(project?.sourceType === 'github' ? configText('repoUrl') : '')
  const [branch, setBranch] = useState(project?.sourceType === 'github' ? configText('branch') : '')
  const [buildMode, setBuildMode] = useState<'docker' | 'command'>(project?.sourceType === 'github' && config.buildMode === 'command' ? 'command' : 'docker')
  const [dockerfilePath, setDockerfilePath] = useState(project?.sourceType === 'github' ? configText('dockerfilePath') : '')
  const [buildCommand, setBuildCommand] = useState(project?.sourceType === 'github' ? configText('buildCommand') : '')
  const [image, setImage] = useState(project?.sourceType === 'image' ? configText('image') : '')
  const [script, setScript] = useState(project?.sourceType === 'script' ? configText('script') : DEFAULT_WORKER_SCRIPT)
  const [env, setEnv] = useState(project?.env ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const validate = (): string => {
    if (!name.trim()) return 'Name is required.'
    if (sourceType === 'compose' && !compose.trim()) return 'Compose YAML is required.'
    if (sourceType === 'github') {
      if (!/^(https:\/\/|git@|ssh:\/\/)/.test(repoUrl.trim())) return 'Repository URL must start with https://, git@, or ssh://.'
      if (buildMode === 'command' && !buildCommand.trim()) return 'A build command is required for the custom build mode.'
    }
    if (sourceType === 'image' && !image.trim()) return 'An image reference is required.'
    if (sourceType === 'script' && !script.trim()) return 'Worker script source is required.'
    return ''
  }

  const save = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError('')
    const sourceConfig: Record<string, unknown> =
      sourceType === 'compose' ? { compose: compose.trim() }
      : sourceType === 'github' ? {
          repoUrl: repoUrl.trim(),
          ...(branch.trim() ? { branch: branch.trim() } : {}),
          buildMode,
          ...(buildMode === 'docker'
            ? (dockerfilePath.trim() ? { dockerfilePath: dockerfilePath.trim() } : {})
            : { buildCommand: buildCommand.trim() }),
        }
      : sourceType === 'image' ? { image: image.trim() }
      : { script }
    try {
      await api(project ? `/api/projects/${encodeURIComponent(project.id)}` : '/api/projects', {
        method: project ? 'PUT' : 'POST',
        body: JSON.stringify({ name: name.trim(), sourceType, sourceConfig, env }),
      })
      await onSaved()
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The project could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
      <header><div><span className="eyebrow"><span /> {project ? 'Edit project' : 'Project source'}</span><h2 id="project-form-title">{project ? project.name : 'New project'}</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <form className="project-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-service" autoComplete="off" spellCheck="false" /></label>
        <div className="project-field">
          <span>Source type</span>
          <div className="source-switch" role="radiogroup" aria-label="Source type">
            {([['compose', 'Docker Compose'], ['github', 'GitHub repo'], ['image', 'Docker image'], ['script', 'Worker script']] as Array<[SourceType, string]>).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={sourceType === value} className={sourceType === value ? 'active' : ''} onClick={() => setSourceType(value)}>{label}</button>
            ))}
          </div>
        </div>
        {sourceType === 'compose' && <label><span>Compose YAML</span><textarea rows={14} value={compose} onChange={(event) => setCompose(event.target.value)} placeholder={COMPOSE_PLACEHOLDER} spellCheck="false" /></label>}
        {sourceType === 'github' && <>
          <label><span>Repository URL</span><input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/user/repo.git or git@github.com:user/repo.git" autoComplete="off" spellCheck="false" /></label>
          <div className="field-row">
            <label><span>Branch (optional)</span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" autoComplete="off" spellCheck="false" /></label>
            <label><span>Build mode</span><select value={buildMode} onChange={(event) => setBuildMode(event.target.value === 'command' ? 'command' : 'docker')}><option value="docker">Docker build</option><option value="command">Custom build command</option></select></label>
          </div>
          {buildMode === 'docker'
            ? <label><span>Dockerfile path (optional)</span><input value={dockerfilePath} onChange={(event) => setDockerfilePath(event.target.value)} placeholder="Dockerfile" autoComplete="off" spellCheck="false" /></label>
            : <label><span>Build command</span><textarea rows={3} value={buildCommand} onChange={(event) => setBuildCommand(event.target.value)} placeholder="docker compose up -d --build" spellCheck="false" /></label>}
          <p className="field-hint">Skywatch uses your saved GitHub token for private repos over HTTPS; SSH uses the agent’s host keys.</p>
        </>}
        {sourceType === 'image' && <label><span>Image reference</span><input value={image} onChange={(event) => setImage(event.target.value)} placeholder="ghcr.io/user/app:latest" autoComplete="off" spellCheck="false" /></label>}
        {sourceType === 'script' && <label><span>Worker script</span><textarea rows={16} value={script} onChange={(event) => setScript(event.target.value)} placeholder={DEFAULT_WORKER_SCRIPT} spellCheck="false" /></label>}
        <EnvEditor value={env} onChange={setEnv} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer><button type="button" className="dialog-cancel" disabled={saving} onClick={onClose}>Cancel</button><button type="submit" className="dialog-save" disabled={saving}>{saving ? 'Saving…' : project ? 'Save project' : 'Create project'}</button></footer>
      </form>
    </section>
  </div>
}

function DeployDialog({ project, servers, onClose, onDeployed }: {
  project: ProjectSummary
  servers: AgentConfig[]
  onClose: () => void
  onDeployed: () => Promise<void>
}) {
  const scriptOnly = project.sourceType === 'script'
  const [targetType, setTargetType] = useState<'vps' | 'cloudflare'>(scriptOnly ? 'cloudflare' : 'vps')
  const [serverId, setServerId] = useState('')
  const [workerName, setWorkerName] = useState(slugifyWorkerName(project.name))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Deployment | null>(null)

  const selectTarget = (next: 'vps' | 'cloudflare') => {
    if (next === 'vps' && scriptOnly) return
    if (next === 'cloudflare' && project.sourceType !== 'script') return
    setTargetType(next)
    setError('')
  }

  const submit = async () => {
    setError('')
    if (targetType === 'cloudflare' && !WORKER_NAME_RE.test(workerName)) {
      setError('Worker names must be 1–63 characters of lowercase letters, numbers, and single dashes, starting with a letter or number.')
      return
    }
    if (targetType === 'vps' && !serverId) {
      setError('Choose a server to deploy to.')
      return
    }
    setBusy(true)
    try {
      const body = targetType === 'vps' ? { targetType, serverId } : { targetType, workerName }
      const deployed = await api<{ deployment: Deployment }>(`/api/projects/${encodeURIComponent(project.id)}/deploy`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setResult(deployed.deployment)
      await onDeployed()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The deployment could not be started.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="deploy-dialog-title">
      <header><div><span className="eyebrow"><span /> Deploy project</span><h2 id="deploy-dialog-title">{project.name}</h2></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <div className="mode-switch" role="radiogroup" aria-label="Deploy target">
        <button type="button" role="radio" aria-checked={targetType === 'vps'} disabled={scriptOnly} className={targetType === 'vps' ? 'active' : ''} onClick={() => selectTarget('vps')}><Server size={16} /><span><strong>VPS server</strong><small>{scriptOnly ? 'Not available for Worker scripts' : 'Run on a registered node'}</small></span></button>
        <button type="button" role="radio" aria-checked={targetType === 'cloudflare'} disabled={!scriptOnly} className={targetType === 'cloudflare' ? 'active' : ''} onClick={() => selectTarget('cloudflare')}><Cloud size={16} /><span><strong>Cloudflare Worker</strong><small>{scriptOnly ? 'Deploy the script to your account' : 'Worker scripts only'}</small></span></button>
      </div>
      {!result && targetType === 'vps' && <label className="deploy-field"><span>Server</span><select value={serverId} onChange={(event) => setServerId(event.target.value)} aria-label="Server">
        {servers.length === 0
          ? <option value="" disabled>No servers registered</option>
          : <option value="" disabled={Boolean(serverId)}>Select a server</option>}
        {sortServers(servers).map((server) => <option key={server.id} value={server.id}>{server.node.name}</option>)}
      </select></label>}
      {!result && targetType === 'cloudflare' && <label className="deploy-field"><span>Worker name</span><input value={workerName} onChange={(event) => setWorkerName(event.target.value)} placeholder="my-worker" autoComplete="off" spellCheck="false" /><small>Lowercase letters, numbers, and single dashes. This becomes the Worker script name.</small></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {result && <div className="deploy-result" aria-live="polite"><DeploymentStatusPill status={result.status} /><span>Deployment {result.status} on {deploymentTargetLabel(result, servers)}.</span></div>}
      <footer>{result
        ? <button type="button" className="dialog-save" onClick={onClose}>Done</button>
        : <><button type="button" className="dialog-cancel" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="dialog-save" disabled={busy} onClick={() => void submit()}>{busy ? 'Deploying…' : 'Start deployment'}</button></>}</footer>
    </section>
  </div>
}

function GitHubTokenDialog({ onClose }: { onClose: () => void }) {
  const [credential, setCredential] = useState<GitHubCredential | null>(null)
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api<GitHubCredential>('/api/credentials/github')
      .then((result) => { if (!cancelled) { setCredential(result); setLoading(false) } })
      .catch((caught) => { if (!cancelled) { setError(caught instanceof Error ? caught.message : 'The GitHub credential could not be loaded.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    if (!token.trim()) {
      setError('Paste a token first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api<GitHubCredential>('/api/credentials/github', {
        method: 'PUT',
        body: JSON.stringify({ token: token.trim() }),
      })
      setCredential(result)
      setToken('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The token could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Remove the saved GitHub token? Private repository deploys over HTTPS will stop working.')) return
    setBusy(true)
    setError('')
    try {
      await api('/api/credentials/github', { method: 'DELETE' })
      setCredential({ configured: false, label: null, updatedAt: null })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The token could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <section className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="github-token-title">
      <header><div><span className="eyebrow"><span /> GitHub credential</span><h2 id="github-token-title">GitHub token</h2></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      {loading && <p className="dialog-loading"><RefreshCw className="spin" size={14} /> Checking the stored credential…</p>}
      {!loading && credential?.configured && <div className="dialog-notice github-credential"><GitBranch size={16} /><span>Configured as {credential.label ?? 'unknown'}{credential.updatedAt ? ` (updated ${relativeDate(credential.updatedAt)})` : ''}.</span></div>}
      {!loading && !credential?.configured && <p className="dialog-copy">Used to clone private GitHub repositories over HTTPS. The token is encrypted before it touches storage.</p>}
      {!loading && <label className="deploy-field"><span>{credential?.configured ? 'Replace token' : 'Token'}</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ghp_…" autoComplete="off" spellCheck="false" /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer>
        {credential?.configured && <button type="button" className="dialog-cancel dialog-danger-text" disabled={busy} onClick={() => void remove()}>Remove token</button>}
        <button type="button" className="dialog-cancel" disabled={busy} onClick={onClose}>Close</button>
        {!loading && <button type="button" className="dialog-save" disabled={busy || !token.trim()} onClick={() => void save()}>{busy ? 'Saving…' : credential?.configured ? 'Replace token' : 'Save token'}</button>}
      </footer>
    </section>
  </div>
}

function ProjectDeployments({ projectId, servers, onChanged }: {
  projectId: string
  servers: AgentConfig[]
  onChanged: () => Promise<void>
}) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null)
  const [error, setError] = useState('')
  const [openDetailId, setOpenDetailId] = useState<string | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [teardown, setTeardown] = useState<Deployment | null>(null)
  const [teardownBusy, setTeardownBusy] = useState(false)
  const [teardownError, setTeardownError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const result = await api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}`)
      setDeployments(result.project.deployments)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Deployments could not be loaded.')
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const refreshDeployment = async (id: string) => {
    setRefreshingId(id)
    setError('')
    try {
      const result = await api<{ deployment: Deployment }>(`/api/deployments/${encodeURIComponent(id)}`)
      setDeployments((current) => current ? current.map((deployment) => deployment.id === id ? result.deployment : deployment) : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The deployment status could not be refreshed.')
    } finally {
      setRefreshingId(null)
    }
  }

  const confirmTeardown = async () => {
    if (!teardown || teardownBusy) return
    setTeardownBusy(true)
    setTeardownError('')
    try {
      await api(`/api/deployments/${encodeURIComponent(teardown.id)}`, { method: 'DELETE' })
      setTeardown(null)
      await load()
      await onChanged()
    } catch (caught) {
      setTeardownError(caught instanceof Error ? caught.message : 'The deployment could not be torn down.')
    } finally {
      setTeardownBusy(false)
    }
  }

  return <div className="project-deployments">
    {error && <div className="dashboard-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Try again</button></div>}
    {!deployments && !error && <p className="deployments-note"><RefreshCw className="spin" size={13} /> Loading deployments…</p>}
    {deployments && deployments.length === 0 && !error && <p className="deployments-note">No deployments yet. Use Deploy to ship this project.</p>}
    {deployments?.map((deployment) => {
      const canTeardown = deployment.targetType === 'vps' && deployment.status !== 'removed'
      return <div className="deployment-item" key={deployment.id}>
        <div className="deployment-row">
          <DeploymentStatusPill status={deployment.status} />
          <span className="deployment-target">{deploymentTargetLabel(deployment, servers)}</span>
          <span className="deployment-time">{relativeDate(deployment.createdAt)}</span>
          <div className="deployment-actions">
            <button type="button" aria-expanded={openDetailId === deployment.id} onClick={() => setOpenDetailId((current) => current === deployment.id ? null : deployment.id)}><Terminal size={13} /> Detail</button>
            <button type="button" disabled={refreshingId === deployment.id} aria-label="Refresh deployment status" onClick={() => void refreshDeployment(deployment.id)}><RefreshCw size={13} className={refreshingId === deployment.id ? 'spin' : ''} /> Refresh</button>
            {canTeardown && <button type="button" className="danger" onClick={() => { setTeardownError(''); setTeardown(deployment) }}><Trash2 size={13} /> Tear down</button>}
          </div>
        </div>
        {openDetailId === deployment.id && <pre className="deployment-detail">{deployment.detail || 'No detail recorded for this deployment.'}</pre>}
      </div>
    })}
    {teardown && <ConfirmDialog eyebrow="Tear down deployment" title="Tear down deployment" description={`Skywatch asks the agent to stop and remove the stack on ${deploymentTargetLabel(teardown, servers)}. This cannot be undone.`} confirmLabel="Tear down" busy={teardownBusy} error={teardownError} onClose={() => { if (!teardownBusy) setTeardown(null) }} onConfirm={() => void confirmTeardown()} />}
  </div>
}

function ProjectsDashboard({ projects, loading, error, reload }: {
  projects: ProjectSummary[]
  loading: boolean
  error: string
  reload: () => Promise<void>
}) {
  const [servers, setServers] = useState<AgentConfig[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formProject, setFormProject] = useState<ProjectDetail | null>(null)
  const [formError, setFormError] = useState('')
  const [editLoadingId, setEditLoadingId] = useState<string | null>(null)
  const [deployProject, setDeployProject] = useState<ProjectSummary | null>(null)
  const [deleteProject, setDeleteProject] = useState<ProjectSummary | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<AgentConfigsResponse>('/api/servers')
      .then((result) => { if (!cancelled) setServers(result.servers) })
      .catch(() => { /* server names are optional context for labels */ })
    return () => { cancelled = true }
  }, [])

  const openEdit = async (project: ProjectSummary) => {
    setFormError('')
    setEditLoadingId(project.id)
    try {
      const result = await api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(project.id)}`)
      setFormProject(result.project)
      setFormOpen(true)
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'The project could not be loaded.')
    } finally {
      setEditLoadingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteProject || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError('')
    try {
      await api(`/api/projects/${encodeURIComponent(deleteProject.id)}`, { method: 'DELETE' })
      setDeleteProject(null)
      await reload()
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : 'The project could not be deleted.')
    } finally {
      setDeleteBusy(false)
    }
  }

  return <div className="content projects-content">
    <div className="page-heading projects-heading">
      <div><h1>Projects</h1><p>Deploy compose stacks, Docker images, and Worker scripts from one place.</p></div>
      <div className="heading-actions">
        <button className="secondary-button" type="button" onClick={() => setTokenOpen(true)}><GitBranch size={15} /> GitHub token</button>
        <button className="action-primary" type="button" onClick={() => { setFormProject(null); setFormOpen(true) }}><Plus size={15} /> New project</button>
      </div>
    </div>

    {(error || formError) && <div className="dashboard-error" role="alert"><span>{error || formError}</span><button type="button" onClick={() => void reload()}>Try again</button></div>}

    <div className="project-list" aria-busy={loading}>
      {loading && projects.length === 0 && <div className="empty-state"><RefreshCw className="spin" size={22} /><h2>Loading projects</h2><p>Reading project sources and deployments from D1.</p></div>}
      {!loading && projects.length === 0 && !error && <div className="empty-state"><FolderGit2 size={22} /><h2>No projects yet</h2><p>Create a project to deploy a compose stack, Docker image, or Worker script.</p></div>}
      {projects.map((project) => {
        const expanded = expandedId === project.id
        const latest = project.latestDeployment
        return <article className="project-card" key={project.id}>
          <div className="project-card-head">
            <div className="project-primary">
              <span className="project-icon"><FolderGit2 size={18} /></span>
              <div><h3>{project.name}</h3><p>{projectSourceSummary(project)}</p></div>
            </div>
            <div className="project-tags"><span className="source-badge">{sourceTypeLabels[project.sourceType]}</span>{project.hasEnv && <span className="env-chip">env</span>}</div>
            <div className="project-latest">{latest
              ? <><DeploymentStatusPill status={latest.status} /><small>{deploymentTargetLabel(latest, servers)} · {relativeDate(latest.createdAt)}</small></>
              : <small>Not deployed yet</small>}</div>
            <div className="project-actions">
              <button type="button" onClick={() => setDeployProject(project)}><Rocket size={14} /> Deploy</button>
              <button type="button" disabled={editLoadingId === project.id} onClick={() => void openEdit(project)}><Pencil size={14} /> Edit</button>
              <button type="button" className="danger" onClick={() => { setDeleteError(''); setDeleteProject(project) }}><Trash2 size={14} /> Delete</button>
              <button type="button" className="icon-only" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} deployments for ${project.name}`} onClick={() => setExpandedId(expanded ? null : project.id)}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
            </div>
          </div>
          {expanded && <ProjectDeployments projectId={project.id} servers={servers} onChanged={reload} />}
        </article>
      })}
    </div>

    {formOpen && <ProjectFormDialog project={formProject} onClose={() => setFormOpen(false)} onSaved={reload} />}
    {deployProject && <DeployDialog project={deployProject} servers={servers} onClose={() => setDeployProject(null)} onDeployed={reload} />}
    {tokenOpen && <GitHubTokenDialog onClose={() => setTokenOpen(false)} />}
    {deleteProject && <ConfirmDialog eyebrow="Delete project" title={`Delete ${deleteProject.name}`} description="The project source and its environment variables are removed. Active deployments are not torn down automatically." confirmLabel="Delete project" busy={deleteBusy} error={deleteError} onClose={() => { if (!deleteBusy) setDeleteProject(null) }} onConfirm={() => void confirmDelete()} />}
  </div>
}

function Dashboard({ account }: { account: { id: string; name: string } }) {
  const [section, setSection] = useState<'workers' | 'servers' | 'projects'>('workers')
  const [workers, setWorkers] = useState<Worker[]>([])
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [filter, setFilter] = useState<'all' | AccessType>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Worker | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState('')

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

  const loadProjects = async () => {
    setProjectsLoading(true)
    setProjectsError('')
    try {
      const result = await api<ProjectsResponse>('/api/projects')
      setProjects(result.projects)
    } catch (caught) {
      setProjectsError(caught instanceof Error ? caught.message : 'Projects could not be loaded.')
    } finally {
      setProjectsLoading(false)
    }
  }

  useEffect(() => { void loadProjects() }, [])

  const filtered = useMemo(() => workers.filter((worker) =>
    filter === 'all' || worker.accessStatus === filter,
  ), [filter, workers])
  const protectedCount = workers.filter((worker) => worker.accessStatus === 'protected').length

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="sidebar-top"><Logo /><button className="mobile-close" type="button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={19} /></button></div>
        <nav>
          <span className="nav-label">Workspace</span>
          <button className={`nav-link nav-button ${section === 'workers' ? 'active' : ''}`} type="button" onClick={() => { setSection('workers'); setMobileNav(false) }}><LayoutGrid size={17} /> Workers <span>{workers.length}</span></button>
          <button className={`nav-link nav-button ${section === 'servers' ? 'active' : ''}`} type="button" onClick={() => { setSection('servers'); setMobileNav(false) }}><Server size={17} /> Servers</button>
          <button className={`nav-link nav-button ${section === 'projects' ? 'active' : ''}`} type="button" onClick={() => { setSection('projects'); setMobileNav(false) }}><Rocket size={17} /> Projects <span>{projects.length}</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="account-chip"><div><strong>{account.name}</strong><span>{account.id.slice(0, 10)}…</span></div></div>
          <div className="sync-state"><span /><span><strong>Cloudflare {error ? 'needs attention' : 'synced'}</strong>{syncedAt ? relativeDate(syncedAt) : 'connecting'}</span></div>
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

      <section className="workspace" id={section}>
        <header className="topbar">
          <button className="mobile-menu" type="button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          {section === 'workers'
            ? <div className="topbar-actions"><button className="secondary-button" type="button" disabled={loading} onClick={() => void loadWorkers()}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Refresh</button></div>
            : section === 'servers'
              ? <div className="topbar-section"><Server size={16} /><span>Server operations</span></div>
              : <div className="topbar-section"><Rocket size={16} /><span>Projects and deployments</span></div>}
        </header>

        {section === 'workers' ? <div className="content">
          <div className="page-heading">
            <div><h1>Workers</h1><p>Every service and its access boundary, in one place.</p></div>
            <div className="sync-pill"><span className="pulse" /> {syncedAt ? `Synced ${relativeDate(syncedAt)}` : 'Connecting'}</div>
          </div>

          <div className="overview-strip">
            <div><span className="strip-label">Services</span><strong>{String(workers.length).padStart(2, '0')}</strong><small>deployed Workers</small></div>
            <div><span className="strip-label">Access boundary</span><strong>{String(protectedCount).padStart(2, '0')} <em>/ {String(workers.length).padStart(2, '0')}</em></strong><small>Workers protected</small></div>
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
            {!loading && filtered.length === 0 && !error && <div className="empty-state"><Search size={22} /><h2>No Workers found</h2><p>Try a different access filter.</p></div>}
          </div>
        </div> : section === 'servers' ? <ServersDashboard /> : <ProjectsDashboard projects={projects} loading={projectsLoading} error={projectsError} reload={loadProjects} />}
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
      setMode(next.configured ? 'dashboard' : 'setup')
    } catch (caught) {
      setBootError(caught instanceof Error ? caught.message : 'Skywatch could not start.')
    }
  }

  useEffect(() => { void loadStatus() }, [])

  if (bootError) return <main className="boot-state"><Logo /><h1>Skywatch could not start</h1><p>{bootError}</p><button type="button" onClick={() => void loadStatus()}>Try again</button></main>
  if (mode === 'loading') return <main className="boot-state"><Logo /><RefreshCw className="spin" size={23} /><p>Connecting the D1 vault…</p></main>
  if (mode === 'setup') return <SetupScreen onConnected={(next) => { setStatus(next); setMode('dashboard') }} />
  if (!status?.account) return <main className="boot-state"><Logo /><Settings size={23} /><p>Account details are unavailable.</p></main>
  return <Dashboard account={status.account} />
}
