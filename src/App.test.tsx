// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const status = {
  configured: true,
  authenticated: true,
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

function installApiMock(servers: typeof configuredAgent[] = []) {
  let registered = [...servers]
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
