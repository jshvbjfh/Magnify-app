'use client'

import { useEffect, useState } from 'react'
import { X, Printer, Wifi, Monitor, RotateCw, CheckCircle, AlertCircle } from 'lucide-react'

interface PrinterSettings {
  enabled: boolean
  type: 'system' | 'network'
  printerName: string
  networkHost: string
  networkPort: number
}

interface SystemPrinter {
  name: string
  isDefault: boolean
}

interface Props {
  onClose: () => void
}

const DEFAULT: PrinterSettings = {
  enabled: false,
  type: 'system',
  printerName: '',
  networkHost: '',
  networkPort: 9100,
}

export default function PrinterSettingsModal({ onClose }: Props) {
  const [settings, setSettings] = useState<PrinterSettings>(DEFAULT)
  const [printers, setPrinters] = useState<SystemPrinter[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'running' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  const api = typeof window !== 'undefined' ? window.electronPrinter : undefined

  useEffect(() => {
    if (!api) { setLoading(false); return }
    Promise.all([api.getSettings(), api.listPrinters()]).then(([s, p]) => {
      setSettings(s ?? DEFAULT)
      setPrinters(p ?? [])
      setLoading(false)
    })
  }, [])

  async function handleSave() {
    if (!api) return
    setSaving(true)
    await api.saveSettings(settings)
    setSaving(false)
  }

  async function handleTest() {
    if (!api) return
    setTestState('running')
    setTestError('')
    const result = await api.testPrint()
    if (result.ok) {
      setTestState('ok')
      setTimeout(() => setTestState('idle'), 3000)
    } else {
      setTestState('error')
      setTestError(result.reason ?? 'Unknown error')
    }
  }

  const set = <K extends keyof PrinterSettings>(key: K, value: PrinterSettings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }))

  if (!api) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="w-80 rounded-xl bg-white p-6 shadow-xl">
          <p className="text-sm text-gray-500">Printer settings are only available in the desktop app.</p>
          <button onClick={onClose} className="mt-4 w-full rounded-lg bg-gray-100 py-2 text-sm font-medium">Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[420px] rounded-2xl bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <Printer className="h-5 w-5 text-gray-600" />
            <h2 className="text-base font-semibold text-gray-900">Printer Settings</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <RotateCw className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="space-y-5 px-6 py-5">

            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">Auto-print tickets</p>
                <p className="text-xs text-gray-500">Print when a new order arrives</p>
              </div>
              <button
                onClick={() => set('enabled', !settings.enabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.enabled ? 'bg-orange-500' : 'bg-gray-200'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Connection type */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Connection type</p>
              <div className="flex gap-2">
                {(['system', 'network'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => set('type', t)}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                      settings.type === t
                        ? 'border-orange-400 bg-orange-50 text-orange-700'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t === 'system' ? <Monitor className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
                    {t === 'system' ? 'System (USB)' : 'Network (IP)'}
                  </button>
                ))}
              </div>
            </div>

            {/* System printer selector */}
            {settings.type === 'system' && (
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Printer name
                </label>
                <select
                  value={settings.printerName}
                  onChange={e => set('printerName', e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-orange-300"
                >
                  <option value="">— select a printer —</option>
                  {printers.map(p => (
                    <option key={p.name} value={p.name}>
                      {p.name}{p.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                {printers.length === 0 && (
                  <p className="mt-1 text-xs text-gray-400">No system printers found. Install printer drivers first.</p>
                )}
              </div>
            )}

            {/* Network printer */}
            {settings.type === 'network' && (
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">IP Address</label>
                  <input
                    type="text"
                    placeholder="192.168.1.100"
                    value={settings.networkHost}
                    onChange={e => set('networkHost', e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div className="w-24">
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Port</label>
                  <input
                    type="number"
                    value={settings.networkPort}
                    onChange={e => set('networkPort', Number(e.target.value))}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>
            )}

            {/* Test result */}
            {testState === 'ok' && (
              <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                <CheckCircle className="h-4 w-4" /> Test print sent successfully
              </div>
            )}
            {testState === 'error' && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                <AlertCircle className="h-4 w-4" /> {testError}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        {!loading && (
          <div className="flex gap-2 border-t border-gray-100 px-6 py-4">
            <button
              onClick={handleTest}
              disabled={testState === 'running'}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testState === 'running' ? <RotateCw className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
              Test print
            </button>
            <div className="flex-1" />
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
