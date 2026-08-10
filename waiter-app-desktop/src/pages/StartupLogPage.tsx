import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ScrollText, Trash2, X } from 'lucide-react'
import { clearAppLogs, getAppLogs } from '../services/logger'
import type { AppLogEntry } from '../services/db'

interface StartupLogPageProps {
  onClose?: () => void
}

const LEVEL_STYLES: Record<AppLogEntry['level'], string> = {
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  error: 'bg-red-50 text-red-700 border-red-200',
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleString('en-RW', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function StartupLogPage({ onClose }: StartupLogPageProps) {
  const [logs, setLogs] = useState<AppLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)

  const loadLogs = useCallback(async () => {
    setLoading(true)
    try {
      setLogs(await getAppLogs(300))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  async function handleClear() {
    setClearing(true)
    try {
      await clearAppLogs()
      await loadLogs()
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="min-h-full bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pt-12 pb-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-gray-900 text-white flex items-center justify-center flex-shrink-0">
            <ScrollText className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900">startup.log</h2>
            <p className="text-xs text-gray-500">Startup, auth, sync and order diagnostics stored on the device.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => void loadLogs()}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-white"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            onClick={() => void handleClear()}
            disabled={clearing}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            {clearing ? 'Clearing…' : 'Clear'}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center w-10 h-10 rounded-xl border border-gray-200 text-gray-600 hover:bg-white"
              title="Close startup.log"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-b border-gray-200 bg-white text-xs text-gray-500">
        {loading ? 'Loading logs…' : `${logs.length} entries loaded, newest first.`}
      </div>

      <div className="divide-y divide-gray-100">
        {loading ? (
          <div className="px-4 py-8 text-sm text-gray-500">Loading startup.log…</div>
        ) : logs.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-500">No logs recorded yet.</div>
        ) : (
          logs.map(entry => (
            <div key={entry.id} className="px-4 py-3 bg-white">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold uppercase ${LEVEL_STYLES[entry.level]}`}>
                      {entry.level}
                    </span>
                    <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">{entry.scope}</span>
                    <span className="text-[11px] text-gray-400">{formatTimestamp(entry.created_at)}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium text-gray-900 break-words">{entry.message}</p>
                  {entry.details && (
                    <pre className="mt-2 overflow-x-auto rounded-xl bg-gray-50 border border-gray-200 px-3 py-2 text-[11px] leading-relaxed text-gray-700 whitespace-pre-wrap break-words font-mono">
                      {entry.details}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}