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

const configuredAgent = {
  configured: true,
  transport: 'direct',
  endpoint: 'https://agent.example.com',
  node: { id: 'a'.repeat(64), name: 'vps-one', agentVersion: '0.1.0' },
  connectedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const unconfiguredAgent = {
  configured: false,
  transport: null,
  endpoint: null,
  node: null,
  connectedAt: null,
  updatedAt: null,
}

function response(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installApiMock(agentConfig: typeof configuredAgent | typeof unconfiguredAgent = unconfiguredAgent) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(value, 'https://skywatch.example')
    if (url.pathname === '/api/status') return response(status)
    if (url.pathname === '/api/workers') return response(workers)
    if (url.pathname === '/api/agent/config' && (!init?.method || init.method === 'GET')) return response(agentConfig)
    if (url.pathname === '/api/agent/health') return response({ status: 'ok', node: { id: 'a'.repeat(64), name: 'vps-one' }, agentVersion: '0.1.0', uptimeSeconds: 7200 })
    if (url.pathname === '/api/agent/system') return response({
      node: { id: 'a'.repeat(64), name: 'vps-one' },
      cpu: { usagePercent: 12.5, cores: 4 },
      memory: { usedBytes: 2_147_483_648, totalBytes: 4_294_967_296 },
      storage: [{ mount: '/', usedBytes: 10_737_418_240, totalBytes: 53_687_091_200 }],
      load: { one: 0.4, five: 0.3, fifteen: 0.2 },
      uptimeSeconds: 7200,
      collectedAt: '2026-08-01T00:00:00.000Z',
    })
    if (url.pathname === '/api/agent/containers') return response({ containers: [], collectedAt: '2026-08-01T00:00:00.000Z' })
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

    expect(await screen.findByRole('heading', { name: 'Connect your first server' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Cloudflare VPC/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(/Agent pairing key/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Test and connect' })).toBeDisabled()
  })

  it('renders a configured node and normalized live metrics', async () => {
    installApiMock(configuredAgent)
    await openServers()

    expect(await screen.findByRole('heading', { name: 'vps-one' })).toBeInTheDocument()
    expect(screen.getByText('Direct HTTPS')).toBeInTheDocument()
    expect(await screen.findByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('2.0 GB of 4.0 GB')).toBeInTheDocument()
  })

  it('requires explicit consent before saving a direct HTTP endpoint', async () => {
    installApiMock()
    await openServers()

    fireEvent.click(screen.getByRole('radio', { name: /Direct endpoint/ }))
    fireEvent.change(screen.getByLabelText(/Public agent URL/i), { target: { value: 'http://203.0.113.10:8080' } })
    fireEvent.change(screen.getByLabelText(/Agent pairing key/i), { target: { value: 'key-id.c2VjcmV0' } })

    expect(screen.getByText('HTTP exposes control traffic on the public internet.')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Test and connect' })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand the risk/ }))
    expect(save).toBeEnabled()
  })

  it('schedules visible-tab polling and clears it when the Servers view unmounts', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    installApiMock(configuredAgent)
    await openServers()

    await waitFor(() => expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000))
    fireEvent.click(screen.getByRole('button', { name: /Workers/ }))
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })
})
