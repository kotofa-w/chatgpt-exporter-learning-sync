// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    main: [] as Array<{ id: string, title: string, create_time: string, update_time: string }>,
    project: [] as Array<{ id: string, title: string, create_time: string, update_time: string }>,
    records: {} as Record<string, { updated_ms: number }>,
    posted: [] as string[],
    receiverOnline: true,
    projectError: false,
    projectErrorCode: 403,
    pageError: false,
    cap: false,
    status: null as Record<string, unknown> | null,
}))

vi.mock('vite-plugin-monkey/dist/client', () => ({
    GM_getValue: undefined,
    GM_setValue: undefined,
    GM_deleteValue: undefined,
    GM_xmlhttpRequest: (request: { method: string, url: string, data?: string, onload: (response: { status: number, statusText: string, responseText: string }) => void, onerror: (error: { error: string }) => void }) => {
        if (!state.receiverOnline) return request.onerror({ error: 'receiver unavailable' })
        let body: unknown = { ok: true }
        if (request.method === 'GET' && request.url.endsWith('/index')) body = { records: state.records }
        if (request.method === 'GET' && request.url.endsWith('/status')) body = { status: state.status }
        if (request.method === 'POST' && request.url.endsWith('/status')) state.status = JSON.parse(request.data!)
        if (request.method === 'POST' && request.url.endsWith('/chatgpt-web')) {
            const payload = JSON.parse(request.data!) as { conversations: Array<{ id: string, update_time: number }> }
            for (const item of payload.conversations) {
                state.posted.push(item.id)
                state.records[item.id] = { updated_ms: item.update_time * 1000 }
            }
        }
        request.onload({ status: 200, statusText: 'OK', responseText: JSON.stringify(body) })
    },
}))

vi.mock('../src/api', () => ({
    RateLimitError: class extends Error {},
    fetchProjects: async () => {
        if (state.projectError) throw new Error(`HTTP ${state.projectErrorCode}: session unavailable`)
        return [{ id: 'project-1' }]
    },
    fetchAllConversations: async (project: string | null, limit: number, _batch: unknown, onHasMore: (value: boolean) => void, onError: (error: unknown) => void) => {
        const items = project ? state.project : state.main
        if (state.pageError) onError(new Error('HTTP 429: Too Many Requests'))
        onHasMore(state.cap || items.length > limit)
        return items.slice(0, limit)
    },
    fetchConversation: async (id: string) => ({ id, title: id, create_time: 1, update_time: Date.parse((state.main.find(x => x.id === id) ?? state.project.find(x => x.id === id))!.update_time) / 1000, mapping: {} }),
}))

const { runLocalAutoSync, getLocalSyncStatus } = await import('../src/localSync')

function item(id: string, day = 1) {
    return { id, title: id, create_time: '2026-01-01T00:00:00Z', update_time: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` }
}

beforeEach(() => {
    localStorage.clear()
    state.main = [item('A'), item('B'), item('C')]
    state.project = [item('B')]
    state.records = {}
    state.posted = []
    state.receiverOnline = true
    state.projectError = false
    state.projectErrorCode = 403
    state.pageError = false
    state.cap = false
    state.status = null
})

describe('local auto sync', () => {
    it('backfills, skips unchanged, resyncs an edit, and finds a new conversation once', async () => {
        await runLocalAutoSync()
        expect(state.posted).toEqual(['A', 'B', 'C'])
        expect((await getLocalSyncStatus())?.coverage_complete).toBe(true)
        state.posted = []
        await runLocalAutoSync()
        expect(state.posted).toEqual([])
        state.main[1] = item('B', 2)
        state.main.push(item('D'))
        await runLocalAutoSync()
        expect(state.posted).toEqual(['B', 'D'])
    })

    it('does not claim complete coverage after a failed page, failed project list, or cap', async () => {
        state.pageError = true
        await runLocalAutoSync()
        expect((await getLocalSyncStatus())?.coverage_complete).toBe(false)
        const success = (await getLocalSyncStatus())?.last_success_at
        state.pageError = false
        state.projectError = true
        await runLocalAutoSync()
        expect((await getLocalSyncStatus())?.session_expired).toBe(true)
        expect((await getLocalSyncStatus())?.last_success_at).toBe(success)
        state.projectError = false
        state.cap = true
        await runLocalAutoSync()
        expect((await getLocalSyncStatus())?.coverage_complete).toBe(false)
        state.cap = false
        state.projectError = true
        state.projectErrorCode = 401
        await runLocalAutoSync()
        expect((await getLocalSyncStatus())?.session_expired).toBe(true)
    })

    it('queues payloads while the receiver is down and retries after recovery', async () => {
        state.receiverOnline = false
        await runLocalAutoSync()
        expect((await getLocalSyncStatus())?.queued).toBe(1)
        state.receiverOnline = true
        await runLocalAutoSync()
        expect(state.posted).toEqual(['A', 'B', 'C'])
        expect((await getLocalSyncStatus())?.queued).toBe(0)
    })
})
