import { GM_xmlhttpRequest } from 'vite-plugin-monkey/dist/client'
import packageJson from '../package.json' with { type: 'json' }
import { RateLimitError, fetchAllConversations, fetchConversation, fetchProjects } from './api'
import {
    DEFAULT_LOCAL_SYNC_ENDPOINT,
    DEFAULT_LOCAL_SYNC_INTERVAL_MINUTES,
    DEFAULT_LOCAL_SYNC_MAX_CONVERSATIONS,
    EXPORT_OPERATION_BATCH,
    KEY_LOCAL_SYNC_ENABLED,
    KEY_LOCAL_SYNC_INDEX,
    KEY_LOCAL_SYNC_INTERVAL_MINUTES,
    KEY_LOCAL_SYNC_LAST_RUN_AT,
    KEY_LOCAL_SYNC_QUEUE,
    KEY_LOCAL_SYNC_STATUS,
} from './constants'
import { buildJsonBatchFileName } from './utils/download'
import { RequestQueue } from './utils/queue'
import { ScriptStorage } from './utils/storage'
import { sleep, timestamp } from './utils/utils'
import type { ApiConversationItem, ApiConversationWithId } from './api'

export interface LocalSyncSettings {
    enabled: boolean
    endpoint: string
    intervalMinutes: number
    maxConversations: number
}

export interface LocalSyncProgress {
    stage: string
    completed?: number
    total?: number
}

export interface LocalSyncResult {
    conversations: number
    batches: number
    queued: number
    checked: number
    skipped: number
}

export interface SyncStatus {
    schema_version: number
    last_attempt_at: string | null
    last_success_at: string | null
    coverage_complete: boolean
    checked: number
    synced: number
    skipped: number
    queued: number
    session_expired: boolean
    rate_limited: boolean
    last_error: string | null
    exporter_version: string
}

interface QueuedLocalSyncPayload {
    id: string
    endpoint: string
    filename: string
    conversations: ApiConversationWithId[]
    createdAt: number
    attempts: number
    lastError?: string
}

interface LocalHttpResponse {
    status: number
    statusText: string
    responseText: string
}

interface LocalIndexRecord {
    conversation_id?: string
    updated_at?: string
    updated_ms?: number
}

interface LocalIndexResponse {
    ok?: boolean
    records?: Record<string, LocalIndexRecord>
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size))
    }
    return result
}

function getSettings(): LocalSyncSettings {
    return {
        enabled: ScriptStorage.get<boolean>(KEY_LOCAL_SYNC_ENABLED) ?? false,
        endpoint: DEFAULT_LOCAL_SYNC_ENDPOINT,
        intervalMinutes: ScriptStorage.get<number>(KEY_LOCAL_SYNC_INTERVAL_MINUTES) ?? DEFAULT_LOCAL_SYNC_INTERVAL_MINUTES,
        maxConversations: DEFAULT_LOCAL_SYNC_MAX_CONVERSATIONS,
    }
}

function getQueue(): QueuedLocalSyncPayload[] {
    return ScriptStorage.get<QueuedLocalSyncPayload[]>(KEY_LOCAL_SYNC_QUEUE) ?? []
}

function saveQueue(queue: QueuedLocalSyncPayload[]) {
    ScriptStorage.set(KEY_LOCAL_SYNC_QUEUE, queue)
}

function toMs(time: number | string | undefined): number {
    if (time == null) return 0
    if (typeof time === 'number') return time * 1000
    const ms = new Date(time).getTime()
    return Number.isNaN(ms) ? 0 : ms
}

function uniqueConversations(items: ApiConversationItem[]): ApiConversationItem[] {
    const seen = new Set<string>()
    return items.filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
    })
}

function isSessionExpiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /\b(401|403|unauthorized|forbidden)\b/i.test(message)
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function pingEndpoint(endpoint: string): string {
    const url = new URL(endpoint)
    url.pathname = '/ping'
    url.search = ''
    url.hash = ''
    return url.toString()
}

function indexEndpoint(endpoint: string): string {
    const url = new URL(endpoint)
    url.pathname = '/chatgpt-web/index'
    url.search = ''
    url.hash = ''
    return url.toString()
}

function statusEndpoint(endpoint: string): string {
    const url = new URL(endpoint)
    url.pathname = '/chatgpt-web/status'
    url.search = ''
    url.hash = ''
    return url.toString()
}

function localRequest(method: 'GET' | 'POST', url: string, body?: unknown): Promise<LocalHttpResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {}
        if (body !== undefined) headers['Content-Type'] = 'application/json'

        GM_xmlhttpRequest({
            method,
            url,
            headers,
            data: body === undefined ? undefined : JSON.stringify(body),
            timeout: 15_000,
            onload: response => resolve({
                status: response.status,
                statusText: response.statusText,
                responseText: response.responseText,
            }),
            onerror: response => reject(new Error(response.error || 'local request failed')),
            ontimeout: () => reject(new Error('local request timed out')),
        })
    })
}

async function ensureReceiverHealthy(endpoint: string) {
    const response = await localRequest('GET', pingEndpoint(endpoint))
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Local receiver health check failed: ${response.status} ${response.statusText}`)
    }
}

async function fetchLocalIndex(endpoint: string): Promise<Record<string, LocalIndexRecord>> {
    const response = await localRequest('GET', indexEndpoint(endpoint))
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Local receiver index failed: ${response.status} ${response.statusText}`)
    }
    const payload = response.responseText ? JSON.parse(response.responseText) as LocalIndexResponse : {}
    if (!payload.records || typeof payload.records !== 'object') throw new Error('Local receiver returned an invalid index')
    ScriptStorage.set(KEY_LOCAL_SYNC_INDEX, payload.records)
    return payload.records
}

export async function getLocalSyncStatus(): Promise<SyncStatus | null> {
    try {
        const response = await localRequest('GET', statusEndpoint(DEFAULT_LOCAL_SYNC_ENDPOINT))
        if (response.status < 200 || response.status >= 300) throw new Error(`Status request failed: ${response.status}`)
        const payload = JSON.parse(response.responseText) as { status?: SyncStatus }
        if (payload.status) return payload.status
    }
    catch { /* Use the last state cached in the userscript while the receiver is offline. */ }
    return ScriptStorage.get<SyncStatus>(KEY_LOCAL_SYNC_STATUS)
}

async function publishStatus(endpoint: string, status: SyncStatus): Promise<boolean> {
    ScriptStorage.set(KEY_LOCAL_SYNC_STATUS, status)
    try {
        const response = await localRequest('POST', statusEndpoint(endpoint), status)
        return response.status >= 200 && response.status < 300
    }
    catch {
        return false
    }
}

function needsSync(item: ApiConversationItem, localIndex: Record<string, LocalIndexRecord>): boolean {
    const local = localIndex[item.id]
    if (!local) return true
    const remoteMs = toMs(item.update_time ?? item.create_time)
    const localMs = Number(local.updated_ms ?? 0) || toMs(local.updated_at)
    if (!remoteMs || !localMs) return true
    return remoteMs > localMs + 1000
}

async function sendLocalSync(endpoint: string, filename: string, conversations: ApiConversationWithId[]) {
    const response = await localRequest('POST', endpoint, {
        source: 'chatgpt-web',
        filename,
        content_type: 'application/json',
        conversations,
    })
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Local sync failed: ${response.status} ${response.statusText}`)
    }
    return response.responseText ? JSON.parse(response.responseText) : {}
}

function enqueueLocalSync(endpoint: string, filename: string, conversations: ApiConversationWithId[], error?: unknown) {
    const queue = getQueue()
    queue.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        endpoint,
        filename,
        conversations,
        createdAt: Date.now(),
        attempts: 0,
        lastError: error instanceof Error ? error.message : error ? String(error) : undefined,
    })
    saveQueue(queue)
}

async function flushQueuedLocalSync(settings: LocalSyncSettings, onProgress?: (progress: LocalSyncProgress) => void): Promise<number> {
    const queue = getQueue()
    if (queue.length === 0) return 0

    onProgress?.({ stage: `retrying queued payloads (${queue.length})` })
    const remaining: QueuedLocalSyncPayload[] = []
    let sent = 0
    for (const item of queue) {
        try {
            await sendLocalSync(item.endpoint || settings.endpoint, item.filename, item.conversations)
            sent++
        }
        catch (error) {
            remaining.push({
                ...item,
                attempts: item.attempts + 1,
                lastError: error instanceof Error ? error.message : String(error),
            })
        }
    }
    saveQueue(remaining)
    return sent
}

function runQueue(chunk: ApiConversationItem[], onProgress?: (progress: LocalSyncProgress) => void): Promise<{ conversations: ApiConversationWithId[], skipped: readonly string[] }> {
    return new Promise((resolve) => {
        const queue = new RequestQueue<ApiConversationWithId>(200, 1600)
        queue.on('progress', prog => onProgress?.({
            stage: prog.currentStatus === 'rate_limited' ? `rate-limited ${prog.rateLimitWaitSecs ?? ''}s` : prog.currentName,
            completed: prog.completed,
            total: prog.total,
        }))
        queue.on('done', conversations => resolve({ conversations, skipped: queue.getSkipped() }))
        chunk.forEach(({ id, title }) => {
            queue.add({ name: title, request: () => fetchConversation(id) })
        })
        queue.start()
    })
}

export async function postLocalSync(endpoint: string, filename: string, conversations: ApiConversationWithId[]) {
    try {
        await ensureReceiverHealthy(endpoint)
        return await sendLocalSync(endpoint, filename, conversations)
    }
    catch (error) {
        enqueueLocalSync(endpoint, filename, conversations, error)
        throw error
    }
}

export async function runLocalAutoSync(
    options: Partial<LocalSyncSettings> = {},
    onProgress?: (progress: LocalSyncProgress) => void,
): Promise<LocalSyncResult> {
    const settings = { ...getSettings(), ...options }
    const maxConversations = Math.max(1, Number(settings.maxConversations) || DEFAULT_LOCAL_SYNC_MAX_CONVERSATIONS)
    const endpoint = settings.endpoint || DEFAULT_LOCAL_SYNC_ENDPOINT
    const previous = ScriptStorage.get<SyncStatus>(KEY_LOCAL_SYNC_STATUS) ?? await getLocalSyncStatus()
    const status: SyncStatus = {
        schema_version: 1,
        last_attempt_at: new Date().toISOString(),
        last_success_at: previous?.last_success_at ?? null,
        coverage_complete: false,
        checked: 0,
        synced: 0,
        skipped: 0,
        queued: getQueue().length,
        session_expired: false,
        rate_limited: false,
        last_error: null,
        exporter_version: packageJson.version,
    }
    ScriptStorage.set(KEY_LOCAL_SYNC_LAST_RUN_AT, Date.now())
    await publishStatus(endpoint, status)
    const errors: string[] = []
    let localIndex = ScriptStorage.get<Record<string, LocalIndexRecord>>(KEY_LOCAL_SYNC_INDEX) ?? {}
    let receiverOnline = false
    onProgress?.({ stage: 'reading local archive index' })
    try {
        await ensureReceiverHealthy(endpoint)
        receiverOnline = true
        await flushQueuedLocalSync(settings, onProgress)
        localIndex = await fetchLocalIndex(endpoint)
    }
    catch (error) {
        errors.push(`receiver: ${errorText(error)}`)
    }

    const items: ApiConversationItem[] = []
    const loadInventory = async (project: string | null) => {
        const remaining = maxConversations - uniqueConversations(items).length
        if (remaining <= 0) {
            errors.push('conversation inventory reached maxConversations')
            return
        }
        let failed = false
        let capped = false
        const onHasMore = (hasMore: boolean) => {
            capped = hasMore
        }
        const onError = (error: unknown) => {
            failed = true
            errors.push(`${project ?? 'main'} inventory: ${errorText(error)}`)
            if (isSessionExpiredError(error)) status.session_expired = true
            if (error instanceof RateLimitError || /\b429\b/.test(errorText(error))) status.rate_limited = true
        }
        const found = await fetchAllConversations(project, remaining, undefined, onHasMore, onError)
        items.push(...found)
        if (capped && !failed) errors.push(`${project ?? 'main'} inventory reached maxConversations`)
    }

    onProgress?.({ stage: 'loading conversation list' })
    await loadInventory(null)
    onProgress?.({ stage: 'loading projects' })
    try {
        const projects = await fetchProjects()
        for (const project of projects) await loadInventory(project.id)
    }
    catch (error) {
        errors.push(`projects: ${errorText(error)}`)
        if (isSessionExpiredError(error)) status.session_expired = true
        if (error instanceof RateLimitError || /\b429\b/.test(errorText(error))) status.rate_limited = true
    }

    const checkedItems = uniqueConversations(items).slice(0, maxConversations)
    const syncItems = checkedItems.filter(item => needsSync(item, localIndex))
    const chunks = chunkArray(syncItems, Math.min(EXPORT_OPERATION_BATCH, 20))
    status.checked = checkedItems.length
    status.skipped = checkedItems.length - syncItems.length
    for (let i = 0; i < chunks.length; i++) {
        onProgress?.({ stage: `fetching batch ${i + 1}/${chunks.length}`, completed: status.synced, total: syncItems.length })
        const { conversations, skipped } = await runQueue(chunks[i], (progress) => {
            if (progress.stage.startsWith('rate-limited')) status.rate_limited = true
            onProgress?.(progress)
        })
        if (skipped.length) errors.push(`${skipped.length} conversation fetches failed`)
        if (conversations.length > 0) {
            const filename = buildJsonBatchFileName(undefined, chunks.length > 1 ? { part: i + 1, total: chunks.length } : undefined)
                .replace('chatgpt-export', `chatgpt-auto-sync-${timestamp()}`)
            try {
                await sendLocalSync(endpoint, filename, conversations)
                status.synced += conversations.length
            }
            catch (error) {
                enqueueLocalSync(endpoint, filename, conversations, error)
                errors.push(`receiver: ${errorText(error)}`)
            }
        }
        if (i < chunks.length - 1) await sleep(400)
    }
    status.queued = getQueue().length
    status.coverage_complete = errors.length === 0 && receiverOnline && status.queued === 0
    status.last_error = errors.length ? errors.join('; ') : null
    if (status.coverage_complete) status.last_success_at = new Date().toISOString()
    if (!await publishStatus(endpoint, status)) {
        status.coverage_complete = false
        status.last_success_at = previous?.last_success_at ?? null
        status.last_error = [status.last_error, 'receiver status unavailable'].filter(Boolean).join('; ')
        ScriptStorage.set(KEY_LOCAL_SYNC_STATUS, status)
    }
    onProgress?.({ stage: status.coverage_complete ? 'done' : 'partial', completed: status.synced, total: syncItems.length })
    return {
        conversations: status.synced,
        batches: chunks.length,
        queued: status.queued,
        checked: status.checked,
        skipped: status.skipped,
    }
}

export function scheduleLocalAutoSync() {
    // ponytail: each open tab schedules independently; add a cross-tab lease if duplicate runs become costly.
    let running = false
    const tick = async () => {
        const settings = getSettings()
        if (!settings.enabled || running) return
        const intervalMs = Math.max(1, Number(settings.intervalMinutes) || DEFAULT_LOCAL_SYNC_INTERVAL_MINUTES) * 60_000
        const lastRunAt = ScriptStorage.get<number>(KEY_LOCAL_SYNC_LAST_RUN_AT) ?? 0
        if (Date.now() - lastRunAt < intervalMs) return

        running = true
        try {
            await runLocalAutoSync(settings)
        }
        catch {
            // Manual "Sync now" reports detailed failures in the dialog. The
            // scheduled loop stays quiet so it does not spam the page console.
        }
        finally {
            running = false
        }
    }

    setTimeout(tick, 5_000)
    setInterval(tick, 60_000)
}
