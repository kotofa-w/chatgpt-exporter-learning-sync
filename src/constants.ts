const API_MAPPING: Record<string, string> = {
    'https://chat.openai.com': 'https://chat.openai.com/backend-api',
    'https://chatgpt.com': 'https://chatgpt.com/backend-api',
}

export const baseUrl = new URL(location.href).origin
export const apiUrl = API_MAPPING[baseUrl]

export const KEY_LANGUAGE = 'exporter:language'
export const KEY_FILENAME_FORMAT = 'exporter:filename_format'
export const KEY_TIMESTAMP_ENABLED = 'exporter:enable_timestamp'
export const KEY_TIMESTAMP_24H = 'exporter:timestamp_24h'
export const KEY_TIMESTAMP_MARKDOWN = 'exporter:timestamp_markdown'
export const KEY_TIMESTAMP_HTML = 'exporter:timestamp_html'
export const KEY_META_ENABLED = 'exporter:enable_meta'
export const KEY_META_LIST = 'exporter:meta_list'
export const KEY_THINKING_ENABLED = 'exporter:enable_thinking'
export const KEY_SOURCES_ENABLED = 'exporter:enable_sources'
export const KEY_EXPORT_ALL_LIMIT = 'exporter:export_all_limit'
export const KEY_EXPORTED_UPDATE_TIMES = 'exporter:exported_update_times'
export const KEY_LOCAL_SYNC_ENABLED = 'exporter:local_sync_enabled'
export const KEY_LOCAL_SYNC_INTERVAL_MINUTES = 'exporter:local_sync_interval_minutes'
export const KEY_LOCAL_SYNC_LAST_RUN_AT = 'exporter:local_sync_last_run_at'
export const KEY_LOCAL_SYNC_QUEUE = 'exporter:local_sync_queue'
export const KEY_LOCAL_SYNC_INDEX = 'exporter:local_sync_index'
export const KEY_LOCAL_SYNC_STATUS = 'exporter:local_sync_status'

export const DEFAULT_LOCAL_SYNC_ENDPOINT = 'http://127.0.0.1:8765/chatgpt-web'
export const DEFAULT_LOCAL_SYNC_INTERVAL_MINUTES = 60
export const DEFAULT_LOCAL_SYNC_MAX_CONVERSATIONS = 5000

export const KEY_OAI_LOCALE = 'oai/apps/locale'

/**
 * Fixed batch size for both the per-conversation API fetch loop and each
 * generated download archive.  Not user-configurable—kept at 100 to stay
 * well within ChatGPT web-session rate limits.
 */
export const EXPORT_OPERATION_BATCH = 100
