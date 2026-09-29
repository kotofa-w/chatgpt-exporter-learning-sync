// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

vi.mock('vite-plugin-monkey/dist/client', () => ({
    unsafeWindow: globalThis,
    monkeyWindow: globalThis,
    GM_info: {},
    GM_getValue: undefined,
    GM_setValue: undefined,
    GM_deleteValue: undefined,
}))

const { fetchAllConversations } = await import('../src/api')

function item(id: string) {
    return { id, title: id, create_time: '2026-01-01T00:00:00Z', update_time: '2026-01-01T00:00:00Z' }
}

function reply(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

it('walks more than 100 main conversations and more than 50 project conversations', async () => {
    const main = Array.from({ length: 121 }, (_, i) => item(`main-${i}`))
    const project = Array.from({ length: 61 }, (_, i) => item(`project-${i}`))
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = new URL(String(input), 'https://chatgpt.com')
        requests.push(url.pathname + url.search)
        if (url.pathname.endsWith('/api/auth/session')) return reply({ accessToken: 'token' })
        if (url.pathname.includes('/accounts/check/')) return reply({ accounts: {} })
        if (url.pathname.includes('/gizmos/project-1/conversations')) {
            const second = url.searchParams.get('cursor') === 'next'
            return reply({ items: second ? project.slice(50) : project.slice(0, 50), cursor: second ? null : 'next' })
        }
        if (url.pathname.endsWith('/conversations')) {
            const offset = Number(url.searchParams.get('offset') || 0)
            return reply({ items: main.slice(offset, offset + 100), total: main.length, limit: 100, offset })
        }
        throw new Error(`unexpected URL: ${url}`)
    }))
    expect((await fetchAllConversations(null, 500)).length).toBe(121)
    expect((await fetchAllConversations('project-1', 500)).length).toBe(61)
    expect(requests.filter(url => url.includes('/gizmos/project-1/conversations')).length).toBe(2)
    vi.unstubAllGlobals()
})

it('reports a failed second page and a repeated project cursor', async () => {
    let projectCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = new URL(String(input), 'https://chatgpt.com')
        if (url.pathname.endsWith('/api/auth/session')) return reply({ accessToken: 'token' })
        if (url.pathname.includes('/accounts/check/')) return reply({ accounts: {} })
        if (url.pathname.includes('/gizmos/project-1/conversations')) {
            projectCalls++
            return reply({ items: [item(`project-${projectCalls}`)], cursor: 'same' })
        }
        if (url.pathname.endsWith('/conversations')) {
            if (url.searchParams.get('offset') === '100') return reply({}, 429)
            return reply({ items: Array.from({ length: 100 }, (_, i) => item(`main-${i}`)), total: 120 })
        }
        throw new Error(`unexpected URL: ${url}`)
    }))
    const mainErrors: unknown[] = []
    const projectErrors: unknown[] = []
    expect((await fetchAllConversations(null, 500, undefined, undefined, error => mainErrors.push(error))).length).toBe(100)
    expect(mainErrors).toHaveLength(1)
    expect((await fetchAllConversations('project-1', 500, undefined, undefined, error => projectErrors.push(error))).length).toBe(2)
    expect(projectErrors).toHaveLength(1)
    vi.unstubAllGlobals()
})
