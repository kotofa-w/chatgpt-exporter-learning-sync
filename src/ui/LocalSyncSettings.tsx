import { useEffect, useState } from 'preact/hooks'
import { getLocalSyncStatus, runLocalAutoSync } from '../localSync'
import { useSettingContext } from './SettingContext'
import { Toggle } from './Toggle'

type SyncStatus = NonNullable<Awaited<ReturnType<typeof getLocalSyncStatus>>>

export function LocalSyncSettings({ open }: { open: boolean }) {
    const {
        localSyncEnabled,
        setLocalSyncEnabled,
        localSyncIntervalMinutes,
        setLocalSyncIntervalMinutes,
    } = useSettingContext()
    const [status, setStatus] = useState<SyncStatus | null>(null)
    const [running, setRunning] = useState(false)
    const [progress, setProgress] = useState('')
    const [error, setError] = useState('')

    useEffect(() => {
        if (!open) return
        let active = true
        setError('')
        getLocalSyncStatus()
            .then((value) => { if (active) setStatus(value) })
            .catch((cause) => { if (active) setError(String(cause)) })
        return () => {
            active = false
        }
    }, [open])

    const syncNow = async () => {
        if (running) return
        setRunning(true)
        setError('')
        setProgress('Starting sync…')
        try {
            await runLocalAutoSync({}, value => setProgress(value.stage))
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
        }
        finally {
            try {
                setStatus(await getLocalSyncStatus())
            }
            catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
            }
            setProgress('')
            setRunning(false)
        }
    }

    const statusError = status?.session_expired
        ? 'ChatGPT session expired. Sign in again before syncing.'
        : status?.last_error || (status?.rate_limited ? 'ChatGPT rate limited this sync.' : '')

    return (
        <div className="ce-setting-card ce-local-sync-card">
            <div>
                <dt className="ce-setting-title">Enable Auto Sync</dt>
                <dd className="ce-setting-desc">Sync changed conversations to the local receiver.</dd>
                <dd className="ce-setting-desc ce-mt-2">
                    <label htmlFor="ce-local-sync-interval">Sync every </label>
                    <input
                        id="ce-local-sync-interval"
                        className="ce-input ce-local-sync-interval"
                        type="number"
                        min="1"
                        step="1"
                        value={localSyncIntervalMinutes}
                        disabled={running}
                        onChange={event => setLocalSyncIntervalMinutes(Math.max(1, Math.floor(Number(event.currentTarget.value) || 1)))}
                    />
                    {' '}minutes
                </dd>
                <dd className="ce-setting-desc ce-mt-2">
                    <button className="ce-button ce-button-neutral" disabled={running} onClick={syncNow}>
                        {running ? 'Syncing…' : 'Sync Now'}
                    </button>
                </dd>
                <dd className="ce-setting-desc ce-mt-2" role="status" aria-live="polite">
                    {progress || (status?.last_attempt_at
                        ? `Last sync: ${new Date(status.last_attempt_at).toLocaleString()} · checked ${status.checked}, synced ${status.synced}, skipped ${status.skipped}, queued ${status.queued}${status.coverage_complete ? '' : ' · partial coverage'}`
                        : 'No sync attempted yet.')}
                </dd>
                {(error || statusError) && (
                    <dd className="ce-setting-desc ce-local-sync-error" role="alert">
                        {error || statusError}
                    </dd>
                )}
            </div>
            <div className="ce-setting-control">
                <Toggle label="Enable Auto Sync" checked={localSyncEnabled} onCheckedUpdate={setLocalSyncEnabled} />
            </div>
        </div>
    )
}
