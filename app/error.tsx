'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, FileText, RefreshCw } from 'lucide-react'

type StartupLogData = {
  available: boolean
  content: string
  path: string | null
  updatedAt: string | null
  message: string | null
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [log, setLog] = useState<StartupLogData | null>(null)
  const [loadingLog, setLoadingLog] = useState(true)

  useEffect(() => {
    console.error(error)
  }, [error])

  useEffect(() => {
    fetch('/api/restaurant/startup-log', { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((data: StartupLogData | null) => {
        if (data?.available) setLog(data)
      })
      .catch(() => null)
      .finally(() => setLoadingLog(false))
  }, [])

  const logLines = log?.content ? log.content.split('\n').filter(Boolean) : []
  const recentLines = logLines.slice(-80)

  // A generic Next.js production message — not useful to show as the headline
  const isGenericMessage =
    !error?.message ||
    error.message.includes('omitted in production builds') ||
    error.message.includes('An error occurred in the Server Components render')

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-5">

        {/* Header */}
        <div className="rounded-2xl bg-white p-8 shadow-lg text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-red-100 rounded-2xl mb-4">
            <AlertTriangle className="h-7 w-7 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>

          {!isGenericMessage && (
            <p className="text-sm text-gray-600 mb-2 font-mono">{error.message}</p>
          )}

          {error?.digest && (
            <p className="text-xs text-gray-400 mb-5">
              digest: <span className="font-mono">{error.digest}</span>
            </p>
          )}

          {isGenericMessage && !error?.digest && (
            <p className="text-sm text-gray-500 mb-5">
              Check the startup log below for the exact error.
            </p>
          )}

          <button
            onClick={() => reset()}
            className="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </button>
        </div>

        {/* Stack trace — only when it carries real content */}
        {error?.stack && !isGenericMessage && (
          <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Stack trace</h2>
            <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words">
              {error.stack}
            </pre>
          </div>
        )}

        {/* Startup log */}
        <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <FileText className="h-4 w-4 text-orange-500 shrink-0" />
            <h2 className="text-sm font-semibold text-gray-700">Startup log</h2>
            {log?.path && (
              <span className="ml-auto text-[11px] text-gray-400 font-mono truncate max-w-xs" title={log.path}>
                {log.path}
              </span>
            )}
          </div>

          {loadingLog ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : recentLines.length > 0 ? (
            <pre className="text-xs rounded-lg bg-gray-950 text-gray-100 p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words leading-relaxed">
              {recentLines.join('\n')}
            </pre>
          ) : (
            <p className="text-xs text-gray-400">
              {log ? 'Startup log is empty.' : 'Startup log unavailable — server may not have started yet.'}
            </p>
          )}

          {log?.message && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {log.message}
            </div>
          )}
        </div>

      </div>
    </main>
  )
}
