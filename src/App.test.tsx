// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App, { parseEnv, serializeEnv, slugifyWorkerName } from './App'

const status = {
  configured: true,
  account: { id: 'account-1234567890', name: 'Test Account' },
  database: 'connected',
  encryption: 'ready',
}

const workers = {
  workers: [],
  seatUsage: { available: true, used: 0, limit: 50, access: 0, gateway: 0 },
  syncedAt: '2026-08-01T00:00:00.000Z',
}

const SERVER_ONE_ID = '123e4567-e89b-42d3-a456-426614174000'
const SERVER_TWO_ID = '123e4567-e89b-42d3-a456-426614174001'

const configuredAgent = {
  id: SERVER_ONE_ID,
  transport: 'direct',
  endpoint: 'https://agent.example.com',
  allowInsecureHttp: false,
  node: { id: SERVER_ONE_ID, name: 'vps-one', agentVersion: '0.1.2' },
  connectedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const secondAgent = {
  ...configuredAgent,
  id: SERVER_TWO_ID,
  endpoint: 'https://agent-two.example.com',
  node: { id: SERVER_TWO_ID, name: 'vps-two', agentVersion: '0.1.2' },
}

function response(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  })
}

const DEPLOYMENT_ONE = {
  id: 'dep-1',
  projectId: 'proj-compose',
  targetType: 'vps',
  targetServerId: SERVER_ONE_ID,
  targetName: null,
  status: 'success',
  detail: 'stack is up',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const composeProject = {
  id: 'proj-compose',
  name: 'blog stack',
  sourceType: 'compose',
  sourceConfig: { compose: 'services:\n  web:\n    image: nginx' },
  hasEnv: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  latestDeployment: DEPLOYMENT_ONE,
}

const scriptProject = {
  id: 'proj-script',
  name: 'Hello API',
  sourceType: 'script',
  sourceConfig: { script: 'export default {}' },
  hasEnv: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  latestDeployment: null,
}

const imageProject = {
  id: 'proj-image',
  name: 'ghcr app',
  sourceType: 'image',
  sourceConfig: { image: 'ghcr.io/user/app:latest' },
  hasEnv: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  latestDeployment: null,
}

type ProjectFixture = {
  id: string
  name: string
  sourceType: string
  sourceConfig: Record<string, unknown>
  hasEnv: boolean
  createdAt: string
  updatedAt: string
  latestDeployment: Record<string, unknown> | null
}

function installApiMock(servers: typeof configuredAgent[] = [], options: {
  projects?: ProjectFixture[]
  github?: { configured: boolean; label: string | null; updatedAt: string | null }
} = {}) {
  let registered = [...servers]
  let registeredProjects = [...(options.projects ?? [])]
  let github = options.github ?? { configured: false, label: null, updatedAt: null }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(value, 'https://skywatch.example')
    if (url.pathname === '/api/status') return response(status)
    if (url.pathname === '/api/workers') return response(workers)
    if (url.pathname === '/api/servers' && (!init?.method || init.method === 'GET')) return response({ servers: registered })
    if (url.pathname === '/api/servers' && init?.method === 'POST') {
      registered = [...registered, secondAgent]
      return response(secondAgent, 201)
    }
    const configMatch = /^\/api\/servers\/([^/]+)$/.exec(url.pathname)
    if (configMatch && init?.method === 'DELETE') {
      registered = registered.filter((server) => server.id !== configMatch[1])
      return response({ deleted: true, id: configMatch[1] })
    }
    const serverMatch = /^\/api\/servers\/([^/]+)\/(health|system|containers)$/.exec(url.pathname)
    if (serverMatch?.[2] === 'health') return response({ status: 'ok', node: { id: serverMatch[1], name: serverMatch[1] === SERVER_TWO_ID ? 'vps-two' : 'vps-one' }, agentVersion: '0.1.2', uptimeSeconds: 7200 })
    if (serverMatch?.[2] === 'system') return response({
      node: { id: serverMatch[1], name: serverMatch[1] === SERVER_TWO_ID ? 'vps-two' : 'vps-one' },
      cpu: { usagePercent: serverMatch[1] === SERVER_TWO_ID ? 44.4 : 12.5, cores: 4 },
      memory: { usedBytes: 2_147_483_648, totalBytes: 4_294_967_296 },
      storage: [{ mount: '/', usedBytes: 10_737_418_240, totalBytes: 53_687_091_200 }],
      load: { one: 0.4, five: 0.3, fifteen: 0.2 },
      uptimeSeconds: 7200,
      collectedAt: '2026-08-01T00:00:00.000Z',
    })
    if (serverMatch?.[2] === 'containers') return response({ containers: [], collectedAt: '2026-08-01T00:00:00.000Z' })
    if (url.pathname === '/api/projects' && (!init?.method || init.method === 'GET')) return response({ projects: registeredProjects })
    if (url.pathname === '/api/projects' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; sourceType: string; sourceConfig: Record<string, unknown>; env: string }
      const project = {
        id: `proj-${registeredProjects.length + 1}`,
        name: body.name,
        sourceType: body.sourceType,
        sourceConfig: body.sourceConfig,
        hasEnv: Boolean(body.env?.trim()),
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        latestDeployment: null,
      }
      registeredProjects = [...registeredProjects, project]
      return response({ project }, 201)
    }
    const deployMatch = /^\/api\/projects\/([^/]+)\/deploy$/.exec(url.pathname)
    if (deployMatch && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { targetType: 'vps' | 'cloudflare'; serverId?: string; workerName?: string }
      const deployment = {
        id: 'dep-new',
        projectId: deployMatch[1],
        targetType: body.targetType,
        targetServerId: body.serverId ?? null,
        targetName: body.workerName ?? null,
        status: 'pending',
        detail: null,
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      }
      registeredProjects = registeredProjects.map((project) => project.id === deployMatch[1] ? { ...project, latestDeployment: deployment } : project)
      return response({ deployment }, 202)
    }
    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
    if (projectMatch && init?.method === 'DELETE') {
      registeredProjects = registeredProjects.filter((project) => project.id !== projectMatch[1])
      return response({ ok: true })
    }
    if (projectMatch && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { name: string; sourceType: string; sourceConfig: Record<string, unknown>; env: string }
      const found = registeredProjects.find((project) => project.id === projectMatch[1])
      if (!found) return response({ error: 'Project not found.' }, 404)
      const updated = { ...found, name: body.name, sourceType: body.sourceType, sourceConfig: body.sourceConfig, hasEnv: Boolean(body.env?.trim()), updatedAt: '2026-08-02T00:00:00.000Z' }
      registeredProjects = registeredProjects.map((project) => project.id === updated.id ? updated : project)
      return response({ project: updated })
    }
    if (projectMatch && (!init?.method || init.method === 'GET')) {
      const found = registeredProjects.find((project) => project.id === projectMatch[1])
      if (!found) return response({ error: 'Project not found.' }, 404)
      return response({ project: { ...found, env: '', deployments: found.latestDeployment ? [found.latestDeployment] : [] } })
    }
    const deploymentMatch = /^\/api\/deployments\/([^/]+)$/.exec(url.pathname)
    if (deploymentMatch && init?.method === 'DELETE') return response({ ok: true })
    if (deploymentMatch && (!init?.method || init.method === 'GET')) {
      return response({ deployment: { ...DEPLOYMENT_ONE, id: deploymentMatch[1], status: 'running' } })
    }
    if (url.pathname === '/api/credentials/github' && (!init?.method || init.method === 'GET')) return response(github)
    if (url.pathname === '/api/credentials/github' && init?.method === 'PUT') {
      github = { configured: true, label: 'octo-user', updatedAt: '2026-08-02T00:00:00.000Z' }
      return response(github)
    }
    if (url.pathname === '/api/credentials/github' && init?.method === 'DELETE') {
      github = { configured: false, label: null, updatedAt: null }
      return response(github)
    }
    throw new Error(`Unexpected API request: ${init?.method ?? 'GET'} ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function openServers() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Workers' })
  fireEvent.click(screen.getByRole('button', { name: /Servers/ }))
  await screen.findByRole('heading', { name: 'Servers' })
}

describe('Servers dashboard', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens a configured instance directly through Cloudflare Access without an unlock prompt', async () => {
    installApiMock()
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Workers' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('paste your token here')).not.toBeInTheDocument()
  })

  it('opens the unconfigured Servers workspace without changing the Workers flow', async () => {
    installApiMock()
    await openServers()

    expect(await screen.findByRole('heading', { name: 'Register another server' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Direct endpoint/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(/Agent pairing key/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Test and register' })).toBeDisabled()
  })

  it('renders a configured node and normalized live metrics', async () => {
    installApiMock([configuredAgent])
    await openServers()

    expect((await screen.findAllByText('vps-one')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Direct HTTPS').length).toBeGreaterThan(0)
    expect(await screen.findByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('2.0 GB of 4.0 GB')).toBeInTheDocument()
  })

  it('requires explicit consent before saving a direct HTTP endpoint', async () => {
    installApiMock()
    await openServers()

    fireEvent.change(screen.getByLabelText(/Public agent URL/i), { target: { value: 'http://203.0.113.10:8080' } })
    fireEvent.change(screen.getByLabelText(/Agent pairing key/i), { target: { value: 'key-id.c2VjcmV0' } })

    expect(screen.getByText('HTTP exposes control traffic on the public internet.')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Test and register' })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand the risk/ }))
    expect(save).toBeEnabled()
  })

  it('schedules visible-tab polling and clears it when the Servers view unmounts', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    installApiMock([configuredAgent])
    await openServers()

    await waitFor(() => expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000))
    fireEvent.click(screen.getByRole('button', { name: /Workers/ }))
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('switches polling to the selected server without reusing the first server route', async () => {
    const fetchMock = installApiMock([configuredAgent, secondAgent])
    await openServers()

    expect(await screen.findByText('12.5%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /vps-two.*Direct HTTPS/ }))
    expect(await screen.findByText('44.4%')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/servers/${SERVER_TWO_ID}/system`,
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('registers a second server and selects its isolated workspace', async () => {
    const fetchMock = installApiMock([configuredAgent])
    await openServers()

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    fireEvent.change(screen.getByLabelText(/Public agent URL/i), { target: { value: secondAgent.endpoint } })
    fireEvent.change(screen.getByLabelText(/Agent pairing key/i), { target: { value: 'key-id.base64url-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test and register' }))

    expect(await screen.findByRole('button', { name: /vps-two.*Direct HTTPS/ })).toHaveAttribute('aria-pressed', 'true')
    expect(fetchMock).toHaveBeenCalledWith('/api/servers', expect.objectContaining({ method: 'POST' }))
  })

  it('reserves the single static VPC binding while allowing more direct servers', async () => {
    installApiMock([{ ...configuredAgent, transport: 'vpc', endpoint: 'http://skywatch-agent.internal' }])
    await openServers()
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))

    expect(screen.getByRole('radio', { name: /Cloudflare VPC/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Direct endpoint/ })).toBeEnabled()
  })

  it('deletes only the selected registration and keeps the other server available', async () => {
    const fetchMock = installApiMock([configuredAgent, secondAgent])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openServers()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete vps-one' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /vps-one.*Direct HTTPS/ })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /vps-two.*Direct HTTPS/ })).toHaveAttribute('aria-pressed', 'true')
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/servers/${SERVER_ONE_ID}`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

async function openProjects() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Workers' })
  fireEvent.click(screen.getByRole('button', { name: /Projects/ }))
  await screen.findByRole('heading', { name: 'Projects' })
}

describe('env helpers', () => {
  it('parses .env text, ignoring comments, blanks, and malformed lines', () => {
    expect(parseEnv('A=1\n# note\n\nB=two=2\n=no-key\nC =')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two=2' },
      { key: 'C', value: '' },
    ])
  })

  it('serializes rows, dropping entries without a key', () => {
    expect(serializeEnv([{ key: 'A', value: '1' }, { key: ' ', value: 'x' }, { key: 'B', value: '' }])).toBe('A=1\nB=')
  })

  it('slugifies project names into valid Worker names', () => {
    expect(slugifyWorkerName('Hello API')).toBe('hello-api')
    expect(slugifyWorkerName('  My_App!! v2  ')).toBe('my-app-v2')
    expect(slugifyWorkerName('!!!')).toBe('')
  })
})

describe('Projects dashboard', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists projects with source badges, env chips, and latest deployment status', async () => {
    installApiMock([configuredAgent], { projects: [composeProject, scriptProject] })
    await openProjects()

    expect(await screen.findByText('blog stack')).toBeInTheDocument()
    expect(screen.getByText('Hello API')).toBeInTheDocument()
    expect(screen.getByText('Compose')).toBeInTheDocument()
    expect(screen.getByText('Worker script')).toBeInTheDocument()
    expect(screen.getByText('env')).toBeInTheDocument()
    expect(screen.getByText('success')).toBeInTheDocument()
    expect(screen.getByText('Not deployed yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Projects/ })).toHaveTextContent('2')
  })

  it('creates a project through the form dialog', async () => {
    const fetchMock = installApiMock()
    await openProjects()

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'metrics api' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Docker image' }))
    fireEvent.change(within(dialog).getByLabelText('Image reference'), { target: { value: 'ghcr.io/me/metrics:1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('metrics api')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'metrics api',
        sourceType: 'image',
        sourceConfig: { image: 'ghcr.io/me/metrics:1' },
        env: '',
      }),
    }))
  })

  it('rejects invalid GitHub repository URLs before submitting', async () => {
    const fetchMock = installApiMock()
    await openProjects()

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'repo app' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'GitHub repo' }))
    fireEvent.change(within(dialog).getByLabelText('Repository URL'), { target: { value: 'ftp://nope' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Repository URL must start with https://, git@, or ssh://.')
    expect(fetchMock).not.toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST' }))
  })

  it('edits env vars in key/value mode without losing data on mode switches', async () => {
    installApiMock()
    await openProjects()

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    const plain = within(dialog).getByLabelText('Environment variables as text')
    fireEvent.change(plain, { target: { value: 'A=1\n# note\nB=2' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Key/value' }))
    expect(within(dialog).getByLabelText('Variable key 1')).toHaveValue('A')
    expect(within(dialog).getByLabelText('Variable key 2')).toHaveValue('B')
    fireEvent.change(within(dialog).getByLabelText('Variable value 1'), { target: { value: '3' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Plain text' }))
    expect(within(dialog).getByLabelText('Environment variables as text')).toHaveValue('A=3\nB=2')
  })

  it('restricts deploy targets by source type and prefills a worker name slug', async () => {
    const fetchMock = installApiMock([], { projects: [scriptProject] })
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    const dialog = await screen.findByRole('dialog', { name: 'Hello API' })

    expect(within(dialog).getByRole('radio', { name: /VPS server/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /Cloudflare Worker/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByLabelText(/Worker name/)).toHaveValue('hello-api')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Start deployment' }))
    expect(await within(dialog).findByText(/Deployment pending/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${scriptProject.id}/deploy`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targetType: 'cloudflare', workerName: 'hello-api' }),
    }))
  })

  it('blocks Cloudflare targets for non-script projects and requires a server', async () => {
    installApiMock([configuredAgent], { projects: [imageProject] })
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    const dialog = await screen.findByRole('dialog', { name: 'ghcr app' })

    expect(within(dialog).getByRole('radio', { name: /Cloudflare Worker/ })).toBeDisabled()
    expect(within(dialog).getByText('Worker scripts only')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Start deployment' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a server to deploy to.')

    fireEvent.change(within(dialog).getByLabelText('Server'), { target: { value: SERVER_ONE_ID } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start deployment' }))
    expect(await within(dialog).findByText(/Deployment pending on vps-one/)).toBeInTheDocument()
  })

  it('validates worker names against the Cloudflare naming rules', async () => {
    const fetchMock = installApiMock([], { projects: [scriptProject] })
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    const dialog = await screen.findByRole('dialog', { name: 'Hello API' })
    fireEvent.change(within(dialog).getByLabelText(/Worker name/), { target: { value: 'Bad_Name!' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start deployment' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Worker names must be/)
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/deploy'), expect.anything())
  })

  it('expands a project to list, refresh, and tear down deployments', async () => {
    const fetchMock = installApiMock([configuredAgent], { projects: [composeProject] })
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'Show deployments for blog stack' }))
    expect(await screen.findByText('vps-one')).toBeInTheDocument()
    expect(screen.getAllByText('success').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Detail' }))
    expect(screen.getByText('stack is up')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh deployment status' }))
    expect(await screen.findByText('running')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(`/api/deployments/${DEPLOYMENT_ONE.id}`, expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Tear down' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Tear down deployment' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Tear down' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(`/api/deployments/${DEPLOYMENT_ONE.id}`, expect.objectContaining({ method: 'DELETE' }))
  })

  it('deletes a project through the confirm dialog', async () => {
    const fetchMock = installApiMock([], { projects: [composeProject] })
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete blog stack' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete project' }))

    await waitFor(() => expect(screen.queryByText('blog stack')).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${composeProject.id}`, expect.objectContaining({ method: 'DELETE' }))
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
  })

  it('saves and reports a GitHub token through the credential dialog', async () => {
    const fetchMock = installApiMock()
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'GitHub token' }))
    const dialog = await screen.findByRole('dialog', { name: 'GitHub token' })
    expect(await within(dialog).findByText(/Used to clone private GitHub repositories/)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Token'), { target: { value: 'ghp_secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save token' }))

    expect(await within(dialog).findByText(/Configured as octo-user/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/credentials/github', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ token: 'ghp_secret' }),
    }))
  })

  it('removes a configured GitHub token after confirmation', async () => {
    const fetchMock = installApiMock([], { github: { configured: true, label: 'octo-user', updatedAt: '2026-08-01T00:00:00.000Z' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openProjects()

    fireEvent.click(await screen.findByRole('button', { name: 'GitHub token' }))
    const dialog = await screen.findByRole('dialog', { name: 'GitHub token' })
    expect(await within(dialog).findByText(/Configured as octo-user/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove token' }))
    expect(await within(dialog).findByText(/Used to clone private GitHub repositories/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/credentials/github', expect.objectContaining({ method: 'DELETE' }))
  })
})
