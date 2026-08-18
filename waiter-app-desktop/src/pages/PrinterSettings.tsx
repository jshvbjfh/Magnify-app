import { useState, useEffect, useCallback } from 'react'
import { Printer, RefreshCw, CheckCircle2 } from 'lucide-react'
import { getConfig, setConfig } from '../services/db'
import {
  listPrinters, getPrinterMap, setPrinterMap, getBillPrinter, setBillPrinter, testPrint,
  getBillEscposMode, setBillEscposMode, printBillRaw, printTicketRaw, isVirtualPrinter,
  type PrinterInfo, type PrinterMap,
} from '../services/printing'
import type { BranchInfo } from '../services/sync'

export default function PrinterSettings() {
  const [printers,   setPrinters]   = useState<PrinterInfo[]>([])
  const [branches,   setBranches]   = useState<BranchInfo[]>([])
  const [map,        setMap]        = useState<PrinterMap>({})
  const [bill,       setBill]       = useState<string>('')
  const [billCols,   setBillCols]   = useState<string>('42')
  const [escposOn,   setEscposOn]   = useState<boolean>(false)
  const [loading,    setLoading]    = useState(true)
  const [savedFlash, setSavedFlash] = useState(false)
  const [testMsg,    setTestMsg]    = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [p, branchesJson, m, b, cols, escpos] = await Promise.all([
      listPrinters(), getConfig('branches'), getPrinterMap(), getBillPrinter(), getConfig('billColumns'), getBillEscposMode(),
    ])
    setEscposOn(escpos)
    setPrinters(p)
    try { setBranches(branchesJson ? (JSON.parse(branchesJson) as BranchInfo[]) : []) }
    catch { setBranches([]) }
    setMap(m)
    setBill(b)
    setBillCols(cols && ['32', '40', '42', '48'].includes(cols) ? cols : '42')
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

  const assignBillCols = async (cols: string) => {
    setBillCols(cols)
    await setConfig('billColumns', cols)
    flashSaved()
  }

  const toggleEscpos = async (on: boolean) => {
    setEscposOn(on)
    await setBillEscposMode(on)
    flashSaved()
  }

  // Sends a sample bill through the raw ESC/POS path so staff can confirm the
  // styled layout (big header, bold total, barcode) on the actual paper.
  const runStyledTest = async () => {
    setTestMsg(null)
    const target = bill || printers.find(p => p.isDefault && !isVirtualPrinter(p.name))?.name
    if (!target) { setTestMsg('Select a main printer first.'); return }
    try {
      const result = await printBillRaw({
        printerName: target,
        topText: 'MAGNIFY\nStyled bill test',
        server: 'Test', station: 'Front',
        orderNo: 'TEST-1234', orderType: 'Dine In', tableName: 'T1',
        dt: new Date().toLocaleString(),
        items: [{ qty: 2, name: 'Sample Dish', unitPrice: 4500, notes: null }],
        totalAmount: 9000,
        columns: parseInt(billCols) || 42,
      })
      setTestMsg(result.ok ? 'Styled test bill sent.' : `Styled test failed: ${result.error ?? 'unknown error'}`)
    } catch (err) {
      setTestMsg(`Styled test failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
    setTimeout(() => setTestMsg(null), 6000)
  }

  // Prints a ruler of candidate widths. Nothing in software can measure the
  // paper, and a bill laid out wider than the printer wraps every rule and
  // splits the total across two lines — so staff read the width off the paper.
  const runWidthTest = async () => {
    setTestMsg(null)
    const target = bill || printers.find(p => p.isDefault && !isVirtualPrinter(p.name))?.name
    if (!target) { setTestMsg('Select a main printer first.'); return }
    try {
      const result = await printBillRaw({ printerName: target, widthTest: true })
      setTestMsg(result.ok ? 'Width ruler sent — set the width it shows.' : `Width test failed: ${result.error ?? 'unknown error'}`)
    } catch (err) {
      setTestMsg(`Width test failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
    setTimeout(() => setTestMsg(null), 6000)
  }

  // Test a station printer the way tickets will actually reach it. With thermal
  // styling on, the HTML test slip would come out blank on a Generic / Text Only
  // printer while real tickets print fine — a test that lies about the setup.
  const runTest = async (deviceName: string, label: string) => {
    setTestMsg(null)
    try {
      if (escposOn) {
        const target = deviceName || bill || printers.find(p => p.isDefault && !isVirtualPrinter(p.name))?.name
        if (!target) { setTestMsg('Select a main printer first.'); return }
        const result = await printTicketRaw({
          printerName: target,
          branchName: label, station: 'KITCHEN', copy: 'station',
          server: 'Test', orderType: 'Dine In', tableName: 'T1',
          dateStr: new Date().toLocaleDateString(),
          timeStr: new Date().toLocaleTimeString(),
          ticketNo: 1, orderNo: 'TEST-1234',
          items: [{ qty: 2, name: 'Sample Dish', note: null }],
          columns: parseInt(billCols) || 42,
        })
        setTestMsg(result.ok ? `Test ticket sent to ${label}` : `Test failed: ${result.error ?? 'unknown error'}`)
      } else {
        await testPrint(deviceName, label)
        setTestMsg(`Test slip sent to ${label}`)
      }
    } catch {
      setTestMsg('Test failed — check the printer is on and connected.')
    }
    setTimeout(() => setTestMsg(null), 5000)
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

      {/* Thermal bill styling — raw ESC/POS to the local queue: big header,
          bold total, barcode. Off = plain-text bills (works on any printer). */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Thermal styling</p>
          <p className="text-xs text-gray-500">Bills and kitchen tickets print as thermal text — big header, bold total, barcode. Required on a Generic / Text Only printer, which prints blank slips without it. Turn off if slips print strange symbols.</p>
        </div>
        <div className="flex items-center gap-2">
          {escposOn && (
            <button onClick={() => void runStyledTest()}
              className="text-xs font-semibold border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">Print styled test</button>
          )}
          <button onClick={() => void toggleEscpos(!escposOn)} role="switch" aria-checked={escposOn}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${escposOn ? 'bg-orange-500' : 'bg-gray-300'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${escposOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>

      {/* Bill width — must match the physical printer's characters-per-line */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Bill width</p>
          <p className="text-xs text-gray-500">Characters per line on the bill printer. 58mm paper is 32; 80mm is 42 or 48. Set too wide and every line wraps — the total splits across two lines and reads like the wrong amount. Print the ruler if unsure.</p>
        </div>
        <div className="flex items-center gap-2">
          {escposOn && (
            <button onClick={() => void runWidthTest()}
              className="text-xs font-semibold border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">Print width ruler</button>
          )}
          <select value={billCols} onChange={e => void assignBillCols(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-400 bg-white text-gray-700">
            <option value="32">32 — 58mm paper</option>
            <option value="40">40 — 80mm (narrow font)</option>
            <option value="42">42 — 80mm (standard)</option>
            <option value="48">48 — 80mm (wide)</option>
          </select>
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
