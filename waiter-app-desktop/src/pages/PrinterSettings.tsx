import { useState, useEffect, useCallback } from 'react'
import { Printer, RefreshCw, CheckCircle2 } from 'lucide-react'
import { getConfig } from '../services/db'
import {
  listPrinters, getPrinterMap, setPrinterMap, getBillPrinter, setBillPrinter, testPrint,
  type PrinterInfo, type PrinterMap,
} from '../services/printing'
import type { BranchInfo } from '../services/sync'

export default function PrinterSettings() {
  const [printers,   setPrinters]   = useState<PrinterInfo[]>([])
  const [branches,   setBranches]   = useState<BranchInfo[]>([])
  const [map,        setMap]        = useState<PrinterMap>({})
  const [bill,       setBill]       = useState<string>('')
  const [loading,    setLoading]    = useState(true)
  const [savedFlash, setSavedFlash] = useState(false)
  const [testMsg,    setTestMsg]    = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [p, branchesJson, m, b] = await Promise.all([
      listPrinters(), getConfig('branches'), getPrinterMap(), getBillPrinter(),
    ])
    setPrinters(p)
    try { setBranches(branchesJson ? (JSON.parse(branchesJson) as BranchInfo[]) : []) }
    catch { setBranches([]) }
    setMap(m)
    setBill(b)
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const flashSaved = () => { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500) }

  const assignBranch = async (branchId: string, deviceName: string) => {
    const next = { ...map, [branchId]: deviceName }
    if (!deviceName) delete next[branchId]
    setMap(next)
    await setPrinterMap(next)
    flashSaved()
  }

  const assignBill = async (deviceName: string) => {
    setBill(deviceName)
    await setBillPrinter(deviceName)
    flashSaved()
  }

  const runTest = async (deviceName: string, label: string) => {
    setTestMsg(null)
    try {
      await testPrint(deviceName, label)
      setTestMsg(`Test slip sent to ${label}`)
    } catch {
      setTestMsg('Test failed — check the printer is on and connected.')
    }
    setTimeout(() => setTestMsg(null), 4000)
  }

  function PrinterSelect({ value, onChange, emptyLabel }: { value: string; onChange: (v: string) => void; emptyLabel: string }) {
    return (
      <select value={value} onChange={e => onChange(e.target.value)}
        className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-400 bg-white text-gray-700 min-w-[180px]">
        <option value="">{emptyLabel}</option>
        {printers.map(p => (
          <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>
        ))}
      </select>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Printers</h2>
          <p className="text-sm text-gray-500">One printer? Just set the main printer below.</p>
        </div>
        <div className="flex items-center gap-2">
          {savedFlash && (
            <span className="flex items-center gap-1 text-xs font-semibold text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <button onClick={load} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50" title="Refresh printers">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {testMsg && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">{testMsg}</div>
      )}

      {printers.length === 0 && !loading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No printers detected. Install the receipt printer in Windows, then tap refresh.
        </div>
      )}

      {/* Main / default printer — handles everything unless a station is overridden */}
      <div className="bg-white rounded-xl border-2 border-orange-200 p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Printer className="h-4 w-4 text-orange-500 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">Main printer</p>
            <p className="text-xs text-gray-500">Prints bills and every ticket — unless a station below is set separately.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PrinterSelect value={bill} onChange={assignBill} emptyLabel="Use Windows default" />
          <button onClick={() => runTest(bill, 'Main printer')}
            className="text-xs font-semibold border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">Test</button>
        </div>
      </div>

      {/* Per-station printers — optional, only for separate kitchen/bar printers */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Separate kitchen / bar printers</p>
        <p className="text-xs text-gray-400 mb-2">Optional — only if a station has its own printer. Leave on the main printer otherwise.</p>
        {branches.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-sm text-gray-400">
            No stations found. They appear here after syncing.
          </div>
        ) : (
          <div className="space-y-2">
            {branches.map(branch => {
              const value = map[branch.id] ?? ''
              return (
                <div key={branch.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{branch.name}</p>
                    <p className="text-xs text-gray-500 capitalize">{branch.type ?? 'kitchen'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <PrinterSelect value={value} onChange={(v) => assignBranch(branch.id, v)} emptyLabel="Use main printer" />
                    <button onClick={() => runTest(value, branch.name)}
                      className="text-xs font-semibold border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">Test</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
