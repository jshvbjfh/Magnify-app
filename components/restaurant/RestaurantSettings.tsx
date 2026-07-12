'use client'
import { useState, useEffect, useRef } from 'react'
import { Save, CheckCircle2, FileText, ReceiptText, UtensilsCrossed, Layers, Cloud, RefreshCw, Download, Upload, ShieldCheck, ChevronDown, Briefcase, AlertTriangle } from 'lucide-react'
import { FIFO_FEATURE_AVAILABLE } from '@/lib/fifoFeature'
import { getOwnerSyncRetryDelayMs, loadOwnerSyncConfig, loadOwnerSyncStatus, loadServerOwnerSyncConfig, loadSyncConflicts, resolveSyncConflict, retryStalledSyncOutbox, saveOwnerSyncConfig, syncOwnerCloud, type OwnerSyncConfig, type OwnerSyncStatus, type ServerOwnerSyncConfig, type SyncConflictEntry } from '@/lib/ownerSyncBrowser'
import { composeRestaurantBillTemplate, parseRestaurantBillTemplate } from '@/lib/restaurantBillTemplate'

function formatSyncTimestamp(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatConflictPayload(value: unknown) {
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

function formatFileSize(sizeBytes: number) {
  const normalized = Number(sizeBytes)
  if (!Number.isFinite(normalized) || normalized <= 0) return '0 B'
  if (normalized < 1024) return `${normalized} B`
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`
}

function getVisibleSyncStatus(syncStatus: OwnerSyncStatus | null, syncInFlight: boolean) {
  if (syncInFlight) return 'syncing' as const
  return syncStatus?.currentStatus ?? 'idle'
}

function getSyncStatusBadge(status: 'idle' | 'syncing' | 'failed') {
  if (status === 'failed') {
    return { label: 'Failed', className: 'bg-red-100 text-red-700' }
  }

  if (status === 'syncing') {
    return { label: 'Syncing', className: 'bg-amber-100 text-amber-700' }
  }

  return { label: 'Idle', className: 'bg-green-100 text-green-700' }
}

function getSyncReadiness(syncStatus: OwnerSyncStatus | null, syncConfig: OwnerSyncConfig, syncConfiguredByServer: boolean) {
  if (!syncStatus) {
    return { label: 'Checking sync status', tone: 'neutral' as const, detail: 'Sync health has not loaded yet.' }
  }

  if (syncStatus.recoveryRequired) {
    const issues = [
      syncStatus.failedBatchCount > 0 ? `${syncStatus.failedBatchCount} failed batch${syncStatus.failedBatchCount === 1 ? '' : 'es'}` : null,
      syncStatus.processingBatchCount > 0 ? `${syncStatus.processingBatchCount} in-progress batch${syncStatus.processingBatchCount === 1 ? '' : 'es'}` : null,
    ].filter(Boolean).join(' and ')

    return {
      label: 'Recovery attention needed',
      tone: 'warning' as const,
      detail: `This station has unresolved sync recovery state: ${issues}. Retry sync now and review recent batches below until this clears.`,
    }
  }

  if (!syncStatus.branchLinked) {
    return { label: 'Station not linked', tone: 'warning' as const, detail: 'This station is missing its cloud sync identity and cannot export yet.' }
  }

  if (syncConfiguredByServer) {
    if (!syncStatus.serverManagedConfigured) {
      return { label: 'Server sync not configured', tone: 'warning' as const, detail: 'The app server is missing the remote target or credentials for owner sync.' }
    }
    if (!syncConfig.enabled) {
      return { label: 'Auto sync disabled', tone: 'neutral' as const, detail: 'Server-managed owner sync is available, but background sync is turned off on this device.' }
    }
    return { label: 'Ready to sync', tone: 'success' as const, detail: 'Server-managed owner sync is configured for this station.' }
  }

  if (!syncConfig.targetUrl.trim() || !syncConfig.email.trim()) {
    return { label: 'Device sync incomplete', tone: 'warning' as const, detail: 'Enter the remote target URL and station email on this device.' }
  }

  if (!syncConfig.password.trim()) {
    return { label: 'Device sync incomplete', tone: 'warning' as const, detail: 'Enter the station sync password on this device before background sync can run, or sign out and sign back in once to let Magnify save it automatically.' }
  }

  if (!syncConfig.enabled) {
    return { label: 'Auto sync disabled', tone: 'neutral' as const, detail: 'This device is configured but background sync is turned off.' }
  }

  return { label: 'Ready to sync', tone: 'success' as const, detail: 'This device can push local station data to the owner cloud.' }
}

type InventoryIntegritySummary = {
  totalIngredients: number
  mismatchCount: number
  totalAbsoluteDrift: number
}

type InventoryIntegrityResponse = {
  summary: InventoryIntegritySummary
  mismatches: Array<{
    ingredientId: string
    ingredientName: string
    unit: string
    driftQuantity: number
  }>
}

type InventoryReconciliationResponse = {
  effectiveAt: string
  summary: {
    totalActions: number
    positiveAdjustments: number
    negativeAdjustments: number
    totalPositiveDrift: number
    totalNegativeDrift: number
  }
  actions: Array<{
    ingredientId: string
    ingredientName: string
    unit: string
    driftQuantity: number
    direction: 'create-opening-layer' | 'reduce-open-layers'
    batchId: string | null
  }>
  restaurant?: {
    fifoEnabled: boolean
    fifoConfiguredAt: string | null
    fifoCutoverAt: string | null
  }
}

type FifoValidationResponse = {
  status: 'blocked' | 'ready' | 'live' | 'attention'
  restaurant: {
    id: string
    name: string
    fifoEnabled: boolean
    fifoConfiguredAt: string | null
    fifoCutoverAt: string | null
    rolloutAvailable: boolean
    runtimeActive: boolean
  }
  summary: {
    integrityMismatchCount: number
    integrityTotalAbsoluteDrift: number
    salesChecked: number
    saleIngredientChecks: number
    salesMissingUsageCount: number
    salesQuantityMismatchCount: number
    wasteLogsChecked: number
    wasteMissingUsageCount: number
    wasteQuantityMismatchCount: number
  }
}

type StartupLogResponse = {
  available: boolean
  path: string | null
  updatedAt: string | null
  sizeBytes: number
  truncated: boolean
  content: string
  message: string | null
}

export default function RestaurantSettings() {
  const billTopRef = useRef<HTMLTextAreaElement>(null)
  const billBottomRef = useRef<HTMLTextAreaElement>(null)

  const [billTopText, setBillTopText] = useState('')
  const [billBottomText, setBillBottomText] = useState('')
  const [billFooter2Text, setBillFooter2Text] = useState('')
  const [billPrinterIp, setBillPrinterIp] = useState('')
  const [billPrinterPort, setBillPrinterPort] = useState('9100')
  const [restaurantName, setRestaurantName] = useState('')
  const [qrOrderingMode, setQrOrderingMode] = useState<'order' | 'view_only' | 'disabled'>('disabled')
  const [trackingMode, setTrackingMode] = useState<'simple' | 'dish_tracking'>('simple')
  const [restaurantIdValue, setRestaurantIdValue] = useState<string | null>(null)
  const [fifoEnabled, setFifoEnabled] = useState(true)
  const [fifoAvailable, setFifoAvailable] = useState(FIFO_FEATURE_AVAILABLE)
  const [fifoConfiguredAt, setFifoConfiguredAt] = useState<string | null>(null)
  const [fifoCutoverAt, setFifoCutoverAt] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savingMode, setSavingMode] = useState(false)
  const [savedMode, setSavedMode] = useState(false)
  const [syncConfig, setSyncConfig] = useState<OwnerSyncConfig>({ enabled: false, targetUrl: '', email: '', password: '' })
  const [savingSync, setSavingSync] = useState(false)
  const [savedSync, setSavedSync] = useState(false)
  const [syncingNow, setSyncingNow] = useState(false)
  const [syncInFlight, setSyncInFlight] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [serverSyncConfig, setServerSyncConfig] = useState<ServerOwnerSyncConfig | null>(null)
  const [syncStatus, setSyncStatus] = useState<OwnerSyncStatus | null>(null)
  const [syncConflicts, setSyncConflicts] = useState<SyncConflictEntry[]>([])
  const [loadingConflicts, setLoadingConflicts] = useState(true)
  const [retryingOutbox, setRetryingOutbox] = useState(false)
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null)
  const [startupLog, setStartupLog] = useState<StartupLogResponse | null>(null)
  const [loadingStartupLog, setLoadingStartupLog] = useState(true)
  const [refreshingStartupLog, setRefreshingStartupLog] = useState(false)
  const [downloadingStartupLog, setDownloadingStartupLog] = useState(false)
  const [startupLogError, setStartupLogError] = useState<string | null>(null)
  const [inventoryIntegrity, setInventoryIntegrity] = useState<InventoryIntegrityResponse | null>(null)
  const [loadingInventoryIntegrity, setLoadingInventoryIntegrity] = useState(true)
  const [inventoryReconciliation, setInventoryReconciliation] = useState<InventoryReconciliationResponse | null>(null)
  const [loadingInventoryReconciliation, setLoadingInventoryReconciliation] = useState(false)
  const [applyingInventoryReconciliation, setApplyingInventoryReconciliation] = useState(false)
  const [inventoryReconciliationError, setInventoryReconciliationError] = useState<string | null>(null)
  const [fifoValidation, setFifoValidation] = useState<FifoValidationResponse | null>(null)
  const [loadingFifoValidation, setLoadingFifoValidation] = useState(true)
  const [loading, setLoading] = useState(true)

  // Desktop sync secret state (only used on packaged desktop)
  const [syncSecretInput, setSyncSecretInput] = useState('')
  const [savingSecret, setSavingSecret] = useState(false)
  const [savedSecret, setSavedSecret] = useState(false)
  const [secretConfigured, setSecretConfigured] = useState<boolean | null>(null)
  const [secretError, setSecretError] = useState<string | null>(null)
  const [clearingSecret, setClearingSecret] = useState(false)

  // Backup / restore state
  const [backingUp, setBackingUp] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreMessage, setRestoreMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false)

  async function refreshStartupLog(options?: { silent?: boolean }) {
    const silent = options?.silent === true

    if (silent) setRefreshingStartupLog(true)
    else setLoadingStartupLog(true)

    setStartupLogError(null)

    try {
      const response = await fetch('/api/restaurant/startup-log', { credentials: 'include', cache: 'no-store' })
      const data = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load startup log')
      }

      setStartupLog({
        available: Boolean(data?.available),
        path: typeof data?.path === 'string' ? data.path : null,
        updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : null,
        sizeBytes: Number(data?.sizeBytes ?? 0),
        truncated: Boolean(data?.truncated),
        content: typeof data?.content === 'string' ? data.content : '',
        message: typeof data?.message === 'string' ? data.message : null,
      })
    } catch (error) {
      setStartupLog(null)
      setStartupLogError(error instanceof Error ? error.message : 'Failed to load startup log')
    } finally {
      if (silent) setRefreshingStartupLog(false)
      else setLoadingStartupLog(false)
    }
  }

  async function refreshSyncStatus() {
    const [status, conflicts] = await Promise.all([
      loadOwnerSyncStatus(),
      loadSyncConflicts(),
    ])
    setSyncStatus(status)
    setSyncConflicts(conflicts)
    setLoadingConflicts(false)
  }

  async function refreshInventoryIntegrity() {
    try {
      const response = await fetch('/api/restaurant/inventory-integrity', { credentials: 'include' })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load inventory integrity')
      }

      setInventoryIntegrity({
        summary: data?.summary ?? { totalIngredients: 0, mismatchCount: 0, totalAbsoluteDrift: 0 },
        mismatches: Array.isArray(data?.mismatches) ? data.mismatches : [],
      })
    } catch {
      setInventoryIntegrity(null)
    } finally {
      setLoadingInventoryIntegrity(false)
    }
  }

  async function previewInventoryReconciliation() {
    setLoadingInventoryReconciliation(true)
    setInventoryReconciliationError(null)
    try {
      const response = await fetch('/api/restaurant/inventory-integrity/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'preview' }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to preview reconciliation')
      }

      setInventoryReconciliation(data)
    } catch (error) {
      setInventoryReconciliation(null)
      setInventoryReconciliationError(error instanceof Error ? error.message : 'Failed to preview reconciliation')
    } finally {
      setLoadingInventoryReconciliation(false)
    }
  }

  async function refreshFifoValidation() {
    setLoadingFifoValidation(true)
    try {
      const response = await fetch('/api/restaurant/fifo-validation', { credentials: 'include' })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load FIFO validation')
      }

      setFifoValidation(data)
    } catch {
      setFifoValidation(null)
    } finally {
      setLoadingFifoValidation(false)
    }
  }

  async function applyInventoryReconciliation() {
    const confirmation = window.prompt('Type RECONCILE to apply inventory layer reconciliation for this station.')
    if (confirmation !== 'RECONCILE') return

    setApplyingInventoryReconciliation(true)
    setInventoryReconciliationError(null)
    try {
      const effectiveAt = inventoryReconciliation?.effectiveAt ?? new Date().toISOString()
      const response = await fetch('/api/restaurant/inventory-integrity/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'apply',
          effectiveAt,
          confirm: 'RECONCILE',
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to apply reconciliation')
      }

      setInventoryReconciliation(data)
      if (data?.restaurant) {
        setFifoEnabled(true)
        setFifoConfiguredAt(typeof data.restaurant.fifoConfiguredAt === 'string' ? data.restaurant.fifoConfiguredAt : null)
        setFifoCutoverAt(typeof data.restaurant.fifoCutoverAt === 'string' ? data.restaurant.fifoCutoverAt : null)
        window.dispatchEvent(new CustomEvent('restaurantFifoChanged', { detail: { fifoEnabled: true } }))
      }

      setLoadingInventoryIntegrity(true)
      await refreshInventoryIntegrity()
      await refreshFifoValidation()
    } catch (error) {
      setInventoryReconciliationError(error instanceof Error ? error.message : 'Failed to apply reconciliation')
    } finally {
      setApplyingInventoryReconciliation(false)
    }
  }

  useEffect(() => {
    Promise.all([
      fetch('/api/restaurant/setup', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null),
      fetch('/api/user/profile', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null),
      loadServerOwnerSyncConfig(),
      loadOwnerSyncStatus(),
      loadSyncConflicts(),
      fetch('/api/desktop/sync-secret', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([setupData, profileData, serverData, syncStatusData, conflictData, syncSecretData]) => {
        if (syncSecretData && typeof syncSecretData.configured === 'boolean') {
          setSecretConfigured(syncSecretData.configured)
        }
        const localSyncConfig = loadOwnerSyncConfig(serverData)

        if (setupData) {
          setRestaurantIdValue(typeof setupData.restaurant?.id === 'string' ? setupData.restaurant.id : null)
          setRestaurantName(setupData.restaurant?.name ?? '')
          const template = parseRestaurantBillTemplate(setupData.restaurant?.billHeader)
          setBillTopText(template.topText)
          setBillBottomText(template.bottomText)
          setBillFooter2Text(template.footer2Text)
          setBillPrinterIp(setupData.restaurant?.billPrinterIp ?? '')
          setBillPrinterPort(setupData.restaurant?.billPrinterPort != null ? String(setupData.restaurant.billPrinterPort) : '9100')
          setFifoEnabled(true)
          setFifoConfiguredAt(typeof setupData.restaurant?.fifoConfiguredAt === 'string' ? setupData.restaurant.fifoConfiguredAt : null)
          setFifoCutoverAt(typeof setupData.restaurant?.fifoCutoverAt === 'string' ? setupData.restaurant.fifoCutoverAt : null)
          if (setupData.restaurant?.qrOrderingMode === 'view_only') setQrOrderingMode('view_only')
          else if (setupData.restaurant?.qrOrderingMode === 'order') setQrOrderingMode('order')
          else setQrOrderingMode('disabled')
        }

        if (profileData) {
          if (profileData.trackingMode) setTrackingMode(profileData.trackingMode)
          if (typeof profileData.fifoAvailable === 'boolean') setFifoAvailable(profileData.fifoAvailable)
        }

        setServerSyncConfig(serverData)
        setSyncStatus(syncStatusData)
        setSyncConflicts(conflictData)
        setLoadingConflicts(false)
        setSyncConfig({
          enabled: localSyncConfig.enabled,
          targetUrl: localSyncConfig.targetUrl,
          email: localSyncConfig.email,
          password: serverData?.configured ? '' : localSyncConfig.password,
        })
      })
      .finally(() => {
        setLoading(false)
        setLoadingConflicts(false)
      })

    void refreshStartupLog()
    void refreshInventoryIntegrity()
    void refreshFifoValidation()
  }, [])

  useEffect(() => {
    const handler = () => { void refreshSyncStatus() }
    window.addEventListener('ownerSyncStatusChanged', handler)
    const timer = window.setInterval(() => { void refreshSyncStatus() }, 30000)
    return () => {
      window.removeEventListener('ownerSyncStatusChanged', handler)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const handler = (event: Event) => {
      const syncing = Boolean((event as CustomEvent).detail?.syncing)
      setSyncInFlight(syncing)
    }

    window.addEventListener('ownerSyncRunStateChanged', handler)
    return () => window.removeEventListener('ownerSyncRunStateChanged', handler)
  }, [])

  const syncConfiguredByServer = Boolean(serverSyncConfig?.configured)
  const syncReadiness = getSyncReadiness(syncStatus, syncConfig, syncConfiguredByServer)
  const visibleSyncStatus = getVisibleSyncStatus(syncStatus, syncInFlight || syncingNow)
  const syncStatusBadge = getSyncStatusBadge(visibleSyncStatus)
  const reconciliationActionCount = inventoryReconciliation?.summary.totalActions ?? inventoryIntegrity?.summary.mismatchCount ?? 0
  const rolloutStage = fifoCutoverAt
    ? {
        label: 'FIFO live for this restaurant',
        toneClassName: 'bg-green-50 border-green-200 text-green-800',
        detail: 'Strict FIFO cutover is recorded. The next step is live validation with real paid orders and waste activity.',
      }
    : !fifoAvailable
      ? {
          label: 'FIFO unavailable in this build',
          toneClassName: 'bg-amber-50 border-amber-200 text-amber-800',
          detail: 'This restaurant cannot activate strict FIFO until the build enables it.',
        }
      : {
          label: reconciliationActionCount > 0 ? 'Strict FIFO required, reconciliation needed' : 'Strict FIFO required, ready to lock',
          toneClassName: reconciliationActionCount > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-blue-50 border-blue-200 text-blue-800',
          detail: reconciliationActionCount > 0
            ? 'This app now uses strict FIFO only. Review the reconciliation preview and apply it so every open quantity is backed by FIFO layers before live depletion continues.'
            : 'No inventory layer drift is currently shown. Save settings to record FIFO cutover and keep this restaurant on strict batch-based FIFO costing.',
        }
  const rolloutNextStep = fifoCutoverAt
    ? 'Create one paid order and one waste event, then refresh validation to confirm FIFO usage rows and quantities stay clean.'
    : !fifoAvailable
      ? 'Use a build where FIFO is enabled before trying to activate strict FIFO for this restaurant.'
      : reconciliationActionCount > 0
        ? 'Run preview reconciliation, review the planned layer fixes, then apply reconciliation so strict FIFO can go live cleanly.'
        : 'Save settings to record FIFO cutover for this restaurant, then validate live sales and waste activity.'

  function wrapSelection(
    ref: React.RefObject<HTMLTextAreaElement>,
    setter: (v: string) => void,
    open: string,
    close: string
  ) {
    const el = ref.current
    if (!el) return
    const { selectionStart: s, selectionEnd: e, value } = el
    const newVal = value.slice(0, s) + open + value.slice(s, e) + close + value.slice(e)
    setter(newVal)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + open.length, e + open.length)
    })
  }

  function mdPreview(text: string): string {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br/>')
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      const billHeader = composeRestaurantBillTemplate(billTopText, billBottomText, billFooter2Text)
      // Only send fifoEnabled when FIFO hasn't been activated yet for this restaurant — once
      // fifoConfiguredAt is set, re-sending it on every unrelated settings save (name, bill
      // header, printer IP, QR mode) would re-trigger the strict FIFO integrity gate and block
      // saving anything else until a full inventory reconciliation is done.
      const body: Record<string, unknown> = { name: restaurantName, billHeader, billPrinterIp: billPrinterIp.trim() || null, billPrinterPort: billPrinterPort.trim() ? parseInt(billPrinterPort) || 9100 : null, qrOrderingMode }
      if (!fifoConfiguredAt) body.fifoEnabled = true
      const response = await fetch('/api/restaurant/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })

      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setSaveError(data?.error || 'Failed to save settings.')
        return
      }

      const savedRestaurant = data?.restaurant
      if (savedRestaurant) {
        setRestaurantIdValue(typeof savedRestaurant.id === 'string' ? savedRestaurant.id : restaurantIdValue)
        setRestaurantName(savedRestaurant.name ?? '')
        const template = parseRestaurantBillTemplate(savedRestaurant.billHeader)
        setBillTopText(template.topText)
        setBillBottomText(template.bottomText)
        setBillFooter2Text(template.footer2Text)
        setBillPrinterIp(savedRestaurant.billPrinterIp ?? '')
        setBillPrinterPort(savedRestaurant.billPrinterPort != null ? String(savedRestaurant.billPrinterPort) : '9100')
        if (savedRestaurant.qrOrderingMode === 'view_only') setQrOrderingMode('view_only')
        else if (savedRestaurant.qrOrderingMode === 'order') setQrOrderingMode('order')
        else setQrOrderingMode('disabled')
        setFifoEnabled(true)
        setFifoConfiguredAt(typeof savedRestaurant.fifoConfiguredAt === 'string' ? savedRestaurant.fifoConfiguredAt : null)
        setFifoCutoverAt(typeof savedRestaurant.fifoCutoverAt === 'string' ? savedRestaurant.fifoCutoverAt : null)
        window.dispatchEvent(new CustomEvent('restaurantFifoChanged', { detail: { fifoEnabled: true } }))
      }

      setLoadingInventoryIntegrity(true)
      await refreshInventoryIntegrity()
      await refreshFifoValidation()

      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } finally {
      setSaving(false)
    }
  }

  async function saveTrackingMode(mode: 'simple' | 'dish_tracking') {
    setSavingMode(true)
    const previousMode = trackingMode
    setTrackingMode(mode)
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ trackingMode: mode }),
      })
      if (!res.ok) {
        setTrackingMode(previousMode)
        const data = await res.json().catch(() => ({}))
        setSaveError(data?.error || 'Failed to save tracking mode. Please try again.')
        return
      }
      setSavedMode(true)
      // Notify RestaurantShell to update nav immediately
      window.dispatchEvent(new CustomEvent('trackingModeChanged', { detail: { trackingMode: mode } }))
      setTimeout(() => setSavedMode(false), 2500)
    } catch {
      setTrackingMode(previousMode)
      setSaveError('Failed to save tracking mode. Check your connection and try again.')
    } finally {
      setSavingMode(false)
    }
  }

  async function saveSyncSecret() {
    const secret = syncSecretInput.trim()
    if (!secret) return
    setSavingSecret(true)
    setSecretError(null)
    try {
      const response = await fetch('/api/desktop/sync-secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ secret }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setSecretError(data?.error ?? 'Failed to save sync secret.')
        return
      }
      setSecretConfigured(true)
      setSyncSecretInput('')
      setSavedSecret(true)
      setTimeout(() => setSavedSecret(false), 3000)
      // Refresh server sync config so the sync readiness banner updates
      const updated = await loadServerOwnerSyncConfig()
      setServerSyncConfig(updated)
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSavingSecret(false)
    }
  }

  async function clearSyncSecret() {
    setClearingSecret(true)
    setSecretError(null)
    try {
      const response = await fetch('/api/desktop/sync-secret', {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        setSecretError(data?.error ?? 'Failed to clear sync secret.')
        return
      }
      setSecretConfigured(false)
      const updated = await loadServerOwnerSyncConfig()
      setServerSyncConfig(updated)
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setClearingSecret(false)
    }
  }

  async function saveSyncSettings() {
    setSavingSync(true)
    saveOwnerSyncConfig(syncConfig)
    setSavedSync(true)
    setSyncMessage('Sync settings saved on this device.')
    setTimeout(() => setSavedSync(false), 2500)
    setSavingSync(false)
  }

  async function runSyncNow() {
    setSyncingNow(true)
    const result = await syncOwnerCloud(syncConfig, { ignoreEnabled: true })
    setSyncMessage(result.message)
    setSyncingNow(false)
    await refreshSyncStatus()
  }

  async function requeueStalledChanges() {
    setRetryingOutbox(true)
    const result = await retryStalledSyncOutbox()
    setRetryingOutbox(false)
    setSyncMessage(result.ok
      ? `Requeued ${result.resetCount} stalled sync change${result.resetCount === 1 ? '' : 's'}.`
      : result.error ?? null)
    await refreshSyncStatus()
  }

  async function handleResolveConflict(conflictId: string, resolution: 'accept_local' | 'accept_remote') {
    setResolvingConflictId(conflictId)
    const result = await resolveSyncConflict(conflictId, resolution)
    setResolvingConflictId(null)
    setSyncMessage(result.ok
      ? `Conflict resolved by ${resolution === 'accept_local' ? 'keeping the local version' : 'accepting the remote version'}.`
      : result.error ?? null)
    await refreshSyncStatus()
  }

  async function downloadStartupLog() {
    if (!startupLog?.available || downloadingStartupLog) return

    setDownloadingStartupLog(true)
    setStartupLogError(null)

    try {
      const response = await fetch('/api/restaurant/startup-log?download=1', { credentials: 'include', cache: 'no-store' })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Failed to download startup log')
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'startup.log'
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setStartupLogError(error instanceof Error ? error.message : 'Failed to download startup log')
    } finally {
      setDownloadingStartupLog(false)
    }
  }

  async function downloadBackup() {
    setBackingUp(true)
    try {
      const res = await fetch('/api/restaurant/backup', { credentials: 'include' })
      if (!res.ok) throw new Error('Backup failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `magnify-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setRestoreMessage({ type: 'error', text: 'Backup download failed. Please try again.' })
      setTimeout(() => setRestoreMessage(null), 4000)
    } finally {
      setBackingUp(false)
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (!file.name.endsWith('.json')) {
      setRestoreMessage({ type: 'error', text: 'Please choose a .json backup file.' })
      setTimeout(() => setRestoreMessage(null), 4000)
      return
    }

    const confirmed = window.confirm(
      'Restore from this backup?\n\nExisting data with the same IDs will be overwritten. New data in the backup will be added alongside your current data.\n\nThis cannot be undone.'
    )
    if (!confirmed) return

    setRestoring(true)
    setRestoreMessage(null)
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const res = await fetch('/api/restaurant/backup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      })
      const data = await res.json()
      if (!res.ok) {
        setRestoreMessage({ type: 'error', text: data.error ?? 'Restore failed.' })
      } else {
        setRestoreMessage({ type: 'success', text: 'Backup restored successfully! Refresh the page to see your data.' })
      }
    } catch {
      setRestoreMessage({ type: 'error', text: 'Invalid backup file or restore failed.' })
    } finally {
      setRestoring(false)
      setTimeout(() => setRestoreMessage(null), 6000)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-24 text-gray-400 text-sm">Loading…</div>
  )

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">

      {/* ── LEFT: Receipt settings ── */}
      <div className="space-y-6">

        {/* Restaurant name */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-base font-bold text-gray-900">Restaurant name</h2>
          <input
            value={restaurantName}
            onChange={e => setRestaurantName(e.target.value)}
            placeholder="My Restaurant"
            className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent"
          />
        </div>

        {/* Bill header */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-orange-500" />
            <h2 className="text-base font-bold text-gray-900">Receipt / Bill editor</h2>
          </div>
          <p className="text-sm text-gray-500">
            Edit the printed bill in two parts: the top block and the bottom message. The middle pricing section is generated automatically from the order. This applies to the whole restaurant — all stations use the same receipt.
          </p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Top of receipt</label>
                <div className="mb-1.5 flex gap-1">
                  <button type="button" title="Bold — select text then click"
                    onClick={() => wrapSelection(billTopRef, setBillTopText, '**', '**')}
                    className="h-6 w-6 rounded border border-gray-300 bg-white text-xs font-bold text-gray-700 hover:bg-gray-100 leading-none">B</button>
                  <button type="button" title="Italic — select text then click"
                    onClick={() => wrapSelection(billTopRef, setBillTopText, '_', '_')}
                    className="h-6 w-6 rounded border border-gray-300 bg-white text-xs italic text-gray-700 hover:bg-gray-100 leading-none">I</button>
                </div>
                <textarea
                  ref={billTopRef}
                  value={billTopText}
                  onChange={e => setBillTopText(e.target.value)}
                  rows={7}
                  placeholder={`e.g.\nSUNSET GRILL\n123 Kigali Heights, KG 7 Ave\nTel: +250 788 000 000\nMoMo: *182*1*1*0788000000#\nTIN: 123456789`}
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent resize-y leading-relaxed"
                />
                <p className="mt-2 text-xs text-gray-400">Use this for your restaurant name, address, TIN, phone number, MoMo code, or bank details. Select text then click <strong>B</strong> or <em>I</em> to format.</p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Bottom message</label>
                <div className="mb-1.5 flex gap-1">
                  <button type="button" title="Bold — select text then click"
                    onClick={() => wrapSelection(billBottomRef, setBillBottomText, '**', '**')}
                    className="h-6 w-6 rounded border border-gray-300 bg-white text-xs font-bold text-gray-700 hover:bg-gray-100 leading-none">B</button>
                  <button type="button" title="Italic — select text then click"
                    onClick={() => wrapSelection(billBottomRef, setBillBottomText, '_', '_')}
                    className="h-6 w-6 rounded border border-gray-300 bg-white text-xs italic text-gray-700 hover:bg-gray-100 leading-none">I</button>
                </div>
                <textarea
                  ref={billBottomRef}
                  value={billBottomText}
                  onChange={e => setBillBottomText(e.target.value)}
                  rows={4}
                  placeholder={`e.g.\nThank you for dining with us!\nPlease come again.`}
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent resize-y leading-relaxed"
                />
                <p className="mt-2 text-xs text-gray-400">This prints at the bottom center of the receipt, after the totals.</p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Footer 2 (below &quot;Powered by Magnify&quot;)</label>
                <textarea
                  value={billFooter2Text}
                  onChange={e => setBillFooter2Text(e.target.value)}
                  rows={3}
                  placeholder={`Optional — add blank lines here if the bottom of the bill gets cut off, to push it up past the cutter.`}
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent resize-y leading-relaxed"
                />
                <p className="mt-2 text-xs text-gray-400">Prints under &quot;Powered by Magnify&quot;. Mostly for blank lines that feed extra paper before the cut.</p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Receipt printer IP (optional)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={billPrinterIp}
                    onChange={e => setBillPrinterIp(e.target.value)}
                    placeholder="e.g. 192.168.1.100"
                    className="flex-1 border border-gray-300 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent"
                  />
                  <input
                    type="text"
                    value={billPrinterPort}
                    onChange={e => setBillPrinterPort(e.target.value)}
                    placeholder="9100"
                    className="w-24 border border-gray-300 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent"
                  />
                </div>
                <p className="mt-2 text-xs text-gray-400">If the receipt printer is on the network, enter its IP and port here. This enables bold text and auto-cut on printed bills. Leave blank to use the default Windows printer.</p>
              </div>
            </div>

            <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-4">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Receipt preview</p>
              <div className="mx-auto max-w-[280px] rounded-lg bg-white px-4 py-3 font-mono text-[12px] leading-relaxed text-gray-800 shadow-sm">
                <div className="border-b border-dashed border-gray-300 pb-2 text-center whitespace-pre-wrap" dangerouslySetInnerHTML={{__html: mdPreview(billTopText.trim() || 'RECEIPT')}} />
                <div className="border-b border-dashed border-gray-300 py-2 text-center">
                  <div>23 Mar 2026, 00:13</div>
                  <div>Table: Takeaway</div>
                </div>
                <div className="border-b border-dashed border-gray-300 py-2 space-y-1">
                  <div className="flex items-start justify-between gap-3"><span>Trey way burger</span><span>6,500 RWF</span></div>
                  <div className="flex items-start justify-between gap-3 font-bold"><span>TOTAL</span><span>6,500 RWF</span></div>
                </div>
                <div className="pt-2 text-center whitespace-pre-wrap" dangerouslySetInnerHTML={{__html: mdPreview(billBottomText.trim() || 'Thank you for dining with us!')}} />
                <div className="pt-1.5 text-center text-[9px] text-gray-400">Powered by Magnify</div>
                {billFooter2Text !== '' && (
                  <div className="text-center whitespace-pre-wrap" dangerouslySetInnerHTML={{__html: mdPreview(billFooter2Text)}} />
                )}
                {/* Cut/tear line — mirrors the small line printed at the end of every bill */}
                <div className="mx-auto mt-4 h-px w-16 bg-gray-800"></div>
              </div>
            </div>
          </div>
        </div>

        {saveError ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {saveError}
          </div>
        ) : null}

        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 bg-gray-900 hover:bg-gray-700 disabled:opacity-60 text-white font-semibold px-6 py-3 rounded-2xl transition-colors shadow-sm"
        >
          {saved ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : <Save className="h-4 w-4" />}
          {saved ? 'Saved!' : saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      {/* ── RIGHT: More settings ── */}
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-gray-900">Restaurant Tracking Mode</h2>
            <p className="text-sm text-gray-500 mt-1">Controls which features are shown in your sidebar. You can switch at any time.</p>
          </div>

          <div className="space-y-3">
            <button type="button" onClick={() => saveTrackingMode('simple')}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                trackingMode === 'simple' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg flex-shrink-0 ${trackingMode === 'simple' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                  <ReceiptText className={`h-5 w-5 ${trackingMode === 'simple' ? 'text-orange-600' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-sm font-bold ${trackingMode === 'simple' ? 'text-orange-700' : 'text-gray-800'}`}>Simple — Financial Records Only</p>
                    {trackingMode === 'simple' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">{savingMode ? 'Saving…' : savedMode ? 'Saved!' : 'Active'}</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    AI records purchases and expenses straight into transactions and financial reports. No dish or ingredient setup needed.
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {['Transactions', 'Income & Expenses', 'AI receipt scanning', 'Financial reports'].map(tag => (
                      <span key={tag} className="text-[10px] bg-green-50 border border-green-200 text-green-700 rounded-full px-2 py-0.5">✅ {tag}</span>
                    ))}
                    {['Dish menu', 'Ingredient tracking'].map(tag => (
                      <span key={tag} className="text-[10px] bg-gray-50 border border-gray-200 text-gray-400 rounded-full px-2 py-0.5">❌ {tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            </button>

            <button type="button" onClick={() => saveTrackingMode('dish_tracking')}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                trackingMode === 'dish_tracking' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg flex-shrink-0 ${trackingMode === 'dish_tracking' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                  <UtensilsCrossed className={`h-5 w-5 ${trackingMode === 'dish_tracking' ? 'text-orange-600' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-sm font-bold ${trackingMode === 'dish_tracking' ? 'text-orange-700' : 'text-gray-800'}`}>Dish Tracking — Full Kitchen Control</p>
                    {trackingMode === 'dish_tracking' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">{savingMode ? 'Saving…' : savedMode ? 'Saved!' : 'Active'}</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Full menu builder with dishes, ingredients, and quantities. Every order auto-deducts stock. Includes Tables, Kitchen display, Orders, and Waste tracking.
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {['Everything in Simple', 'Dish menu builder', 'Ingredient per dish', 'Auto stock deduction', 'Waste tracking', 'Tables & Kitchen'].map(tag => (
                      <span key={tag} className="text-[10px] bg-green-50 border border-green-200 text-green-700 rounded-full px-2 py-0.5">✅ {tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>

        {trackingMode === 'dish_tracking' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-orange-500" />
              <h2 className="text-base font-bold text-gray-900">Inventory Costing Policy</h2>
            </div>
            <p className="text-sm text-gray-500">
              This app now uses strict FIFO for ingredient costs and stock depletion.
            </p>
            <div className="rounded-xl border-2 border-orange-500 bg-orange-50 p-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg flex-shrink-0 bg-orange-100">
                  <Layers className="h-5 w-5 text-orange-600" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-bold text-orange-700">Strict FIFO — First In, First Out</p>
                    <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Required</span>
                  </div>
                  <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                    Every incoming stock batch keeps its own cost, and depletion always uses the oldest open batch first. Average Cost and blended batch merging are not supported in this app.
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {['Oldest batch first', 'No average blending', 'Batch cost audit trail'].map(tag => (
                      <span key={tag} className="text-[10px] bg-green-50 border border-green-200 text-green-700 rounded-full px-2 py-0.5">{tag}</span>
                    ))}
                    <span className="text-[10px] bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-2 py-0.5">Reconcile legacy layer drift before cutover</span>
                  </div>
                </div>
              </div>
            </div>
            {fifoCutoverAt ? (
              <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                Strict FIFO is already live for this restaurant. Every stock deduction now depends on purchase layers.
              </div>
            ) : !fifoAvailable ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Strict FIFO cannot go live in this build yet.
              </div>
            ) : reconciliationActionCount > 0 ? (
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                Strict FIFO is required for this restaurant. Apply reconciliation first so every open quantity is backed by FIFO layers before cutover is recorded.
              </div>
            ) : (
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                Strict FIFO is ready. Save settings to record cutover for this restaurant.
              </div>
            )}
          </div>
        )}

        {trackingMode === 'dish_tracking' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-orange-500" />
              <h2 className="text-base font-bold text-gray-900">FIFO Activation Status</h2>
            </div>
            <p className="text-sm text-gray-500">
                This screen tracks inventory integrity, reconciliation, cutover, and live validation for FIFO costing on the current restaurant.
            </p>
            <p className="text-xs text-gray-500">
              Activation applies to the whole restaurant and every staff login linked to it.
            </p>
            {fifoConfiguredAt && (
              <p className="text-xs text-gray-400">
                Last saved for this station: {formatSyncTimestamp(fifoConfiguredAt)}
              </p>
            )}
            {fifoCutoverAt && (
              <p className="text-xs font-medium text-green-700">
                FIFO cutover locked for this station at {formatSyncTimestamp(fifoCutoverAt)}.
              </p>
            )}
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-gray-900">Inventory layer integrity</p>
                  {loadingInventoryIntegrity ? (
                    <p className="mt-1 text-xs text-gray-500">Checking whether ingredient totals match open batch layers…</p>
                  ) : inventoryIntegrity ? (
                    inventoryIntegrity.summary.mismatchCount === 0 ? (
                      <p className="mt-1 text-xs text-green-700">No drift detected between ingredient quantities and open purchase layers.</p>
                    ) : (
                      <p className="mt-1 text-xs text-amber-700">
                        {inventoryIntegrity.summary.mismatchCount} ingredient{inventoryIntegrity.summary.mismatchCount === 1 ? '' : 's'} have layer drift.
                        Total absolute drift: {inventoryIntegrity.summary.totalAbsoluteDrift.toLocaleString('en-RW')} units.
                      </p>
                    )
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">Integrity status is currently unavailable.</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLoadingInventoryIntegrity(true)
                    void refreshInventoryIntegrity()
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-gray-400"
                >
                  Refresh
                </button>
              </div>
              {!loadingInventoryIntegrity && inventoryIntegrity && inventoryIntegrity.summary.mismatchCount > 0 && (
                <div className="mt-3 space-y-1 text-xs text-amber-800">
                  {inventoryIntegrity.mismatches.slice(0, 3).map((mismatch) => (
                    <p key={mismatch.ingredientId}>
                      {mismatch.ingredientName}: drift {mismatch.driftQuantity.toLocaleString('en-RW')} {mismatch.unit}
                    </p>
                  ))}
                  {inventoryIntegrity.summary.mismatchCount > 3 && (
                    <p>More mismatches exist beyond the first 3 shown here.</p>
                  )}
                </div>
              )}
              <div className="mt-4 border-t border-gray-200 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">Reconciliation preview</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Preview creates no data. Apply records restaurant cutover time and fixes open layers to match current ingredient quantities.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void previewInventoryReconciliation()}
                      disabled={loadingInventoryReconciliation || applyingInventoryReconciliation}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-gray-400 disabled:opacity-60"
                    >
                      {loadingInventoryReconciliation ? 'Previewing…' : 'Preview reconciliation'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyInventoryReconciliation()}
                      disabled={
                        !fifoAvailable ||
                        Boolean(fifoCutoverAt) ||
                        loadingInventoryReconciliation ||
                        applyingInventoryReconciliation ||
                        !inventoryReconciliation ||
                        inventoryReconciliation.summary.totalActions === 0
                      }
                      className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:border-orange-400 disabled:opacity-60"
                    >
                      {applyingInventoryReconciliation ? 'Applying…' : 'Apply reconciliation'}
                    </button>
                  </div>
                </div>
                {inventoryReconciliationError && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {inventoryReconciliationError}
                  </div>
                )}
                {inventoryReconciliation && (
                  <div className="mt-3 space-y-2 text-xs text-gray-700">
                    <p className="text-gray-500">
                      Effective at: {formatSyncTimestamp(inventoryReconciliation.effectiveAt)}.
                      Planned actions: {inventoryReconciliation.summary.totalActions}.
                      Positive drift: {inventoryReconciliation.summary.totalPositiveDrift.toLocaleString('en-RW')} units.
                      Negative drift: {inventoryReconciliation.summary.totalNegativeDrift.toLocaleString('en-RW')} units.
                    </p>
                    {inventoryReconciliation.summary.totalActions === 0 ? (
                      <p className="text-green-700">No reconciliation actions are needed for the current station state.</p>
                    ) : (
                      <div className="space-y-1 text-amber-800">
                        {inventoryReconciliation.actions.slice(0, 3).map((action) => (
                          <p key={action.ingredientId}>
                            {action.ingredientName}: {action.direction === 'create-opening-layer' ? 'create opening layer for' : 'reduce open layers by'} {Math.abs(action.driftQuantity).toLocaleString('en-RW')} {action.unit}
                          </p>
                        ))}
                        {inventoryReconciliation.summary.totalActions > 3 && (
                          <p>More reconciliation actions exist beyond the first 3 shown here.</p>
                        )}
                      </div>
                    )}
                    {inventoryReconciliation.restaurant?.fifoCutoverAt && (
                      <p className="text-green-700">
                        Restaurant FIFO cutover recorded at {formatSyncTimestamp(inventoryReconciliation.restaurant.fifoCutoverAt)}.
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-4 border-t border-gray-200 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">Cutover validation</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Verifies layer drift and whether post-cutover sales and waste are writing FIFO usage ledger rows correctly.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshFifoValidation()}
                    disabled={loadingFifoValidation}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-gray-400 disabled:opacity-60"
                  >
                    {loadingFifoValidation ? 'Checking…' : 'Refresh validation'}
                  </button>
                </div>
                {loadingFifoValidation ? (
                  <p className="mt-3 text-xs text-gray-500">Checking station FIFO validation…</p>
                ) : fifoValidation ? (
                  <div className="mt-3 space-y-2 text-xs text-gray-700">
                    <p className={
                      fifoValidation.status === 'live'
                        ? 'text-green-700'
                        : fifoValidation.status === 'ready'
                          ? 'text-blue-700'
                          : fifoValidation.status === 'blocked'
                            ? 'text-amber-800'
                            : 'text-amber-800'
                    }>
                      Status: {fifoValidation.status === 'live'
                        ? 'Live and validated'
                        : fifoValidation.status === 'ready'
                          ? 'Ready for cutover'
                          : fifoValidation.status === 'blocked'
                            ? 'Unavailable'
                            : 'Needs attention'}.
                    </p>
                    <p>
                      Layer drift mismatches: {fifoValidation.summary.integrityMismatchCount}. Total drift: {fifoValidation.summary.integrityTotalAbsoluteDrift.toLocaleString('en-RW')} units.
                    </p>
                    <p>
                      Post-cutover dish sales checked: {fifoValidation.summary.salesChecked}. Missing usage rows: {fifoValidation.summary.salesMissingUsageCount}. Quantity mismatches: {fifoValidation.summary.salesQuantityMismatchCount}.
                    </p>
                    <p>
                      Post-cutover waste logs checked: {fifoValidation.summary.wasteLogsChecked}. Missing usage rows: {fifoValidation.summary.wasteMissingUsageCount}. Quantity mismatches: {fifoValidation.summary.wasteQuantityMismatchCount}.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-gray-500">Validation status is currently unavailable.</p>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <div className={`rounded-xl border px-4 py-4 text-sm ${rolloutStage.toneClassName}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold">{rolloutStage.label}</p>
                  {fifoCutoverAt ? (
                    <span className="rounded-full bg-green-600 px-2 py-0.5 text-[10px] font-bold text-white">Active</span>
                  ) : fifoAvailable ? (
                    <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">Required</span>
                  ) : (
                    <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">Blocked</span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-relaxed">{rolloutStage.detail}</p>
                {fifoConfiguredAt && !fifoCutoverAt && (
                  <p className="mt-2 text-[11px] opacity-80">
                    Rollout settings last saved: {formatSyncTimestamp(fifoConfiguredAt)}.
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 text-sm text-gray-700">
                <p className="font-bold text-gray-900">Next rollout step</p>
                <p className="mt-2 text-xs leading-relaxed">{rolloutNextStep}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {['Reconciliation', 'FIFO depletion', 'FIFO reports'].map(tag => (
                    <span key={tag} className="text-[10px] bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-2 py-0.5">Activation check: {tag}</span>
                  ))}
                  {!fifoCutoverAt && (
                    <span className="text-[10px] bg-gray-100 border border-gray-200 text-gray-600 rounded-full px-2 py-0.5">Strict FIFO cutover is pending until reconciliation and save are complete</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-gray-900">Guest Menu Access</h2>
            <p className="text-sm text-gray-500 mt-1">Choose whether guests can place orders themselves, only browse the menu, or whether this restaurant does not use QR guest access.</p>
          </div>

          <div className="space-y-3">
            <button type="button" onClick={() => setQrOrderingMode('disabled')}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                qrOrderingMode === 'disabled' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg flex-shrink-0 ${qrOrderingMode === 'disabled' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                  <Briefcase className={`h-5 w-5 ${qrOrderingMode === 'disabled' ? 'text-orange-600' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-sm font-bold ${qrOrderingMode === 'disabled' ? 'text-orange-700' : 'text-gray-800'}`}>We do not use QR code</p>
                    {qrOrderingMode === 'disabled' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Active</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Best for restaurants where staff handle service directly and table QR pages are not needed.
                  </p>
                </div>
              </div>
            </button>

            <button type="button" onClick={() => setQrOrderingMode('order')}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                qrOrderingMode === 'order' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg flex-shrink-0 ${qrOrderingMode === 'order' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                  <UtensilsCrossed className={`h-5 w-5 ${qrOrderingMode === 'order' ? 'text-orange-600' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-sm font-bold ${qrOrderingMode === 'order' ? 'text-orange-700' : 'text-gray-800'}`}>Guests can view menu and order</p>
                    {qrOrderingMode === 'order' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Active</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Best for table ordering. Guests can browse the menu, build a cart, and send orders directly to your order queue and kitchen display.
                  </p>
                </div>
              </div>
            </button>

            <button type="button" onClick={() => setQrOrderingMode('view_only')}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                qrOrderingMode === 'view_only' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg flex-shrink-0 ${qrOrderingMode === 'view_only' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                  <FileText className={`h-5 w-5 ${qrOrderingMode === 'view_only' ? 'text-orange-600' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-sm font-bold ${qrOrderingMode === 'view_only' ? 'text-orange-700' : 'text-gray-800'}`}>Guests can only view the menu</p>
                    {qrOrderingMode === 'view_only' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Active</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Best when staff still take orders manually. Guests can view pricing and browse categories, but the order button stays disabled.
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>

      <div className="xl:col-span-2">
        <button
          type="button"
          onClick={() => setShowAdvancedSettings(v => !v)}
          className="flex w-full items-center justify-center gap-3 rounded-2xl border border-dashed border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700 transition-colors hover:bg-orange-100"
        >
          <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${showAdvancedSettings ? 'rotate-180' : 'animate-bounce'}`} />
          {showAdvancedSettings ? 'Hide advanced settings' : 'More settings: cloud sync, startup logs, and backup'}
        </button>
      </div>

      {showAdvancedSettings && <>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4 xl:col-span-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-orange-500" />
          <h2 className="text-base font-bold text-gray-900">Owner cloud sync</h2>
        </div>
        <p className="text-sm text-gray-500">
          Use this on the restaurant desktop to push local transactions and daily summaries to your remote owner app. The restaurant can keep running locally, and sync catches up automatically whenever internet is available.
        </p>

        {syncConfiguredByServer ? (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            Sync target is auto-filled from this device's server settings. You only need to enable background sync here.
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-1.5 text-sm text-gray-600">
            <span className="font-medium">Remote app URL</span>
            <input
              value={syncConfig.targetUrl}
              onChange={e => setSyncConfig(current => ({ ...current, targetUrl: e.target.value }))}
              placeholder="https://magnify-app-tau.vercel.app"
              disabled={syncConfiguredByServer}
              className="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-orange-400"
            />
          </label>
          <label className="space-y-1.5 text-sm text-gray-600">
            <span className="font-medium">Remote station email</span>
            <input
              type="email"
              value={syncConfig.email}
              onChange={e => setSyncConfig(current => ({ ...current, email: e.target.value }))}
              placeholder="manager@example.com"
              disabled={syncConfiguredByServer}
              className="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-orange-400"
            />
          </label>
          {!syncConfiguredByServer ? (
            <label className="space-y-1.5 text-sm text-gray-600 md:col-span-2">
              <span className="font-medium">Remote station password</span>
              <input
                type="password"
                value={syncConfig.password}
                onChange={e => setSyncConfig(current => ({ ...current, password: e.target.value }))}
                placeholder="Enter the cloud account password for this station"
                className="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-orange-400"
              />
            </label>
          ) : null}
        </div>

        {/* Server sync shared secret — desktop-only, shown when the endpoint is available */}
        {secretConfigured !== null ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">Server sync shared secret</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  A shared secret lets this desktop authenticate to the owner cloud without entering a password each session.
                  It is stored securely on this device only and never sent to any server other than your configured sync target.
                </p>
              </div>
              {secretConfigured ? (
                <span className="shrink-0 inline-flex rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">Configured</span>
              ) : (
                <span className="shrink-0 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">Not set</span>
              )}
            </div>
            {!secretConfigured || syncSecretInput ? (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={syncSecretInput}
                  onChange={e => { setSyncSecretInput(e.target.value); setSecretError(null) }}
                  placeholder={secretConfigured ? 'Enter new secret to replace the current one' : 'Paste the shared secret from the owner cloud .env'}
                  className="flex-1 rounded-xl border border-gray-300 px-4 py-2 text-sm outline-none focus:border-orange-400"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => { void saveSyncSecret() }}
                  disabled={savingSecret || !syncSecretInput.trim()}
                  className="shrink-0 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-orange-600"
                >
                  {savingSecret ? 'Saving…' : savedSecret ? 'Saved!' : 'Save secret'}
                </button>
              </div>
            ) : null}
            {secretConfigured && !syncSecretInput ? (
              <button
                type="button"
                onClick={() => { void clearSyncSecret() }}
                disabled={clearingSecret}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                {clearingSecret ? 'Clearing…' : 'Remove saved secret'}
              </button>
            ) : null}
            {secretError ? (
              <p className="text-xs text-red-600">{secretError}</p>
            ) : null}
          </div>
        ) : null}

        <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={syncConfig.enabled}
            onChange={e => setSyncConfig(current => ({ ...current, enabled: e.target.checked }))}
            className="mt-1"
          />
          <span>
            <strong className="text-gray-900">Enable background sync on this device</strong>
            <span className="block text-xs text-gray-500 mt-1">
              While the manager app is open, it will retry automatically with backoff when the internet or cloud target is unavailable.
            </span>
          </span>
        </label>

        {syncStatus ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Pending outbox</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{syncStatus.pendingOutboxChanges}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Open conflicts</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{syncStatus.syncConflictCount}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Current status</p>
              <div className="mt-2">
                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${syncStatusBadge.className}`}>
                  {syncStatusBadge.label}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Last success</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{formatSyncTimestamp(syncStatus.lastSuccessAt)}</p>
            </div>
          </div>
        ) : null}

        {syncStatus ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className={`rounded-xl border px-4 py-3 ${syncStatus.readyOutboxChanges > 0 ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Ready to push</p>
              <p className={`mt-1 text-2xl font-bold ${syncStatus.readyOutboxChanges > 0 ? 'text-green-700' : 'text-gray-900'}`}>{syncStatus.readyOutboxChanges}</p>
            </div>
            <div className={`rounded-xl border px-4 py-3 ${syncStatus.stalledOutboxChanges > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Stalled outbox</p>
              <p className={`mt-1 text-2xl font-bold ${syncStatus.stalledOutboxChanges > 0 ? 'text-red-700' : 'text-gray-900'}`}>{syncStatus.stalledOutboxChanges}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Pending transactions</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{syncStatus.pendingTransactions}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Pending summaries</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{syncStatus.pendingSummaries}</p>
            </div>
          </div>
        ) : null}

        {syncStatus ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className={`rounded-xl border px-4 py-3 ${syncStatus.failedBatchCount > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Failed batches</p>
              <p className={`mt-1 text-2xl font-bold ${syncStatus.failedBatchCount > 0 ? 'text-red-700' : 'text-gray-900'}`}>{syncStatus.failedBatchCount}</p>
              <p className="mt-1 text-xs text-gray-500">Failed imports are replay-safe, but they still mean the owner cloud may be behind until the retry succeeds.</p>
            </div>
            <div className={`rounded-xl border px-4 py-3 ${syncStatus.processingBatchCount > 0 ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Batches awaiting confirmation</p>
              <p className={`mt-1 text-2xl font-bold ${syncStatus.processingBatchCount > 0 ? 'text-amber-700' : 'text-gray-900'}`}>{syncStatus.processingBatchCount}</p>
              <p className="mt-1 text-xs text-gray-500">These are safe to retry. They usually clear when the next sync receives a matching batch acknowledgement.</p>
            </div>
          </div>
        ) : null}

        {syncStatus ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span><strong className="font-semibold text-gray-900">Retry cadence:</strong> {Math.round(getOwnerSyncRetryDelayMs(syncStatus.consecutiveFailures) / 1000)} sec</span>
              <span><strong className="font-semibold text-gray-900">Next retry:</strong> {formatSyncTimestamp(syncStatus.nextRetryAt)}</span>
              <span><strong className="font-semibold text-gray-900">Current device:</strong> {syncStatus.currentDeviceId || 'Unknown'}</span>
            </div>
          </div>
        ) : null}

        <div className={`rounded-xl border px-4 py-3 text-sm ${
          syncReadiness.tone === 'success'
            ? 'border-green-200 bg-green-50 text-green-800'
            : syncReadiness.tone === 'warning'
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-gray-200 bg-gray-50 text-gray-700'
        }`}>
          <strong className="font-semibold">Sync readiness:</strong> {syncReadiness.label}
          <div className="mt-1 text-xs opacity-90">{syncReadiness.detail}</div>
        </div>

        {syncStatus?.lastErrorMessage ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <strong className="font-semibold">Latest sync issue:</strong> {syncStatus.lastErrorMessage}
            <div className="mt-1 text-xs text-amber-700">Last attempt: {formatSyncTimestamp(syncStatus.lastAttemptAt)}</div>
          </div>
        ) : null}

        {syncStatus && syncStatus.recentEvents.length > 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-gray-900">Recent sync history</h3>
                <p className="text-xs text-gray-500">Latest station-to-owner sync attempts for this restaurant.</p>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {syncStatus.recentEvents.map((event) => (
                <div key={event.id} className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${event.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {event.status}
                      </span>
                      <span className="font-medium text-gray-900">{event.message}</span>
                    </div>
                    <span className="text-xs text-gray-500">{formatSyncTimestamp(event.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Transactions: {event.syncedTransactions} · Summaries: {event.syncedSummaries} · Consecutive failures: {event.consecutiveFailures}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {syncStatus && syncStatus.recentBatches.length > 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-gray-900">Recovery batches</h3>
                <p className="text-xs text-gray-500">Deterministic batch replay history for partial failures, retries, and safe duplicate acknowledgements.</p>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {syncStatus.recentBatches.map((batch) => (
                <div key={batch.id} className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${batch.status === 'success' ? 'bg-green-100 text-green-700' : batch.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        {batch.status}
                      </span>
                      <span className="font-medium text-gray-900">{batch.batchId.slice(0, 12)}...</span>
                    </div>
                    <span className="text-xs text-gray-500">Updated {formatSyncTimestamp(batch.updatedAt)}</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Received: {formatSyncTimestamp(batch.receivedAt)} · Applied: {formatSyncTimestamp(batch.appliedAt)}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Transactions: {batch.syncedTransactions} · Summaries: {batch.syncedSummaries}
                  </div>
                  {batch.errorMessage ? (
                    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {batch.errorMessage}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {syncStatus && syncStatus.devices.length > 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-gray-900">Device outbox health</h3>
                <p className="text-xs text-gray-500">Pending, ready, and stalled sync changes grouped by device.</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {syncStatus.devices.map((device) => (
                <div key={device.deviceId} className={`rounded-xl border px-4 py-3 text-sm ${device.isCurrentDevice ? 'border-orange-200 bg-orange-50' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-gray-900">{device.isCurrentDevice ? 'This device' : device.deviceId}</div>
                      <div className="text-xs text-gray-500">App {device.appVersion} · Last seen {formatSyncTimestamp(device.lastSeenAt)}</div>
                    </div>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${device.stalledOutboxChanges > 0 ? 'bg-red-100 text-red-700' : device.readyOutboxChanges > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-700'}`}>
                      {device.status}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-600">
                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                      <div className="font-semibold text-gray-900">{device.pendingOutboxChanges}</div>
                      <div>Pending</div>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                      <div className="font-semibold text-gray-900">{device.readyOutboxChanges}</div>
                      <div>Ready</div>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                      <div className="font-semibold text-gray-900">{device.stalledOutboxChanges}</div>
                      <div>Stalled</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">Next retry: {formatSyncTimestamp(device.nextRetryAt)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-gray-900">Conflict resolution</h3>
              <p className="text-xs text-gray-500">Resolve entity-level sync conflicts by choosing whether the local or remote version wins.</p>
            </div>
            <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
              {syncConflicts.length} open
            </span>
          </div>

          {loadingConflicts ? (
            <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">Loading sync conflicts…</div>
          ) : syncConflicts.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">No open sync conflicts. Incoming changes are applying cleanly.</div>
          ) : (
            <div className="mt-3 space-y-3">
              {syncConflicts.map((conflict) => (
                <div key={conflict.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-gray-900">{conflict.entityType} · {conflict.entityId}</div>
                      <div className="text-xs text-gray-500">Detected {formatSyncTimestamp(conflict.createdAt)}</div>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Conflict
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-amber-900">{conflict.reason}</p>
                  <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
                    <div className="rounded-xl border border-gray-200 bg-white p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Local version</div>
                      <div className="mt-1 text-xs text-gray-500">Mutation: {conflict.localMutationId ?? 'Unavailable'} · Operation: {conflict.localChange?.operation ?? 'unknown'}</div>
                      <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-gray-950 px-3 py-2 text-xs text-gray-100">{formatConflictPayload(conflict.localChange?.payload)}</pre>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Remote version</div>
                      <div className="mt-1 text-xs text-gray-500">Mutation: {conflict.remoteMutationId ?? 'Unavailable'} · Operation: {conflict.remoteChange?.operation ?? 'unknown'}</div>
                      <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-gray-950 px-3 py-2 text-xs text-gray-100">{formatConflictPayload(conflict.remoteChange?.payload)}</pre>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => handleResolveConflict(conflict.id, 'accept_local')}
                      disabled={resolvingConflictId === conflict.id || !conflict.localChange}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
                    >
                      {resolvingConflictId === conflict.id ? 'Resolving…' : 'Accept local'}
                    </button>
                    <button
                      onClick={() => handleResolveConflict(conflict.id, 'accept_remote')}
                      disabled={resolvingConflictId === conflict.id || !conflict.remoteChange}
                      className="inline-flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700 transition-colors hover:bg-orange-100 disabled:opacity-60"
                    >
                      {resolvingConflictId === conflict.id ? 'Resolving…' : 'Accept remote'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {syncMessage ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">{syncMessage}</div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            onClick={saveSyncSettings}
            disabled={savingSync}
            className="inline-flex items-center gap-2 rounded-2xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-60"
          >
            {savedSync ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : <Save className="h-4 w-4" />}
            {savedSync ? 'Saved!' : savingSync ? 'Saving…' : 'Save sync preference'}
          </button>
          <button
            onClick={runSyncNow}
            disabled={syncingNow}
            className="inline-flex items-center gap-2 rounded-2xl border border-orange-200 bg-orange-50 px-5 py-3 text-sm font-semibold text-orange-700 transition-colors hover:bg-orange-100 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${syncingNow ? 'animate-spin' : ''}`} />
            {syncingNow ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            onClick={requeueStalledChanges}
            disabled={retryingOutbox || (syncStatus?.stalledOutboxChanges ?? 0) === 0}
            className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${retryingOutbox ? 'animate-spin' : ''}`} />
            {retryingOutbox ? 'Requeueing…' : 'Requeue stalled changes'}
          </button>
        </div>
      </div>

      <div className="xl:col-span-2 rounded-2xl border border-gray-200 bg-white p-6 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-orange-500" />
              <h2 className="text-base font-bold text-gray-900">Startup log</h2>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Desktop startup, migration, and local server boot output for this admin device. Use it when station login, sync, or startup errors need a first-pass trace.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { void refreshStartupLog({ silent: true }) }}
              disabled={loadingStartupLog || refreshingStartupLog}
              className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${refreshingStartupLog ? 'animate-spin' : ''}`} />
              {refreshingStartupLog ? 'Refreshing…' : 'Refresh log'}
            </button>
            <button
              onClick={() => { void downloadStartupLog() }}
              disabled={!startupLog?.available || downloadingStartupLog}
              className="inline-flex items-center gap-2 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm font-semibold text-orange-700 transition-colors hover:bg-orange-100 disabled:opacity-60"
            >
              <Download className="h-4 w-4" />
              {downloadingStartupLog ? 'Downloading…' : 'Download full log'}
            </button>
          </div>
        </div>

        {startupLogError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {startupLogError}
          </div>
        ) : null}

        {loadingStartupLog ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
            Loading startup log…
          </div>
        ) : startupLog?.available ? (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">File size</p>
                <p className="mt-1 text-sm font-semibold text-gray-900">{formatFileSize(startupLog.sizeBytes)}</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Last updated</p>
                <p className="mt-1 text-sm font-semibold text-gray-900">{formatSyncTimestamp(startupLog.updatedAt)}</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Log file</p>
                <p className="mt-1 break-all text-xs font-medium text-gray-700">{startupLog.path || 'Unavailable'}</p>
              </div>
            </div>

            {startupLog.message ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {startupLog.message}
              </div>
            ) : null}

            <div className="rounded-2xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Latest log output</h3>
                  <p className="text-xs text-gray-500">
                    {startupLog.truncated ? 'Showing the latest tail of startup.log.' : 'Showing the full current startup.log contents.'}
                  </p>
                </div>
              </div>
              <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-gray-950 px-4 py-3 text-xs leading-6 text-gray-100">{startupLog.content || 'startup.log exists but is currently empty.'}</pre>
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
            {startupLog?.message || 'Startup log is not available on this device yet.'}
          </div>
        )}
      </div>

      {/* ── Backup & Restore ── */}
      <div className="xl:col-span-2 bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-orange-500" />
          <h2 className="text-base font-bold text-gray-900">Backup &amp; Restore</h2>
        </div>
        <p className="text-sm text-gray-500">
          Download a full copy of your data (transactions, dishes, inventory, employees, sales, etc.) as a JSON file.
          You can restore it anytime to the same or a different account.
        </p>

        {restoreMessage && (
          <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
            restoreMessage.type === 'success'
              ? 'bg-green-50 border border-green-200 text-green-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}>
            {restoreMessage.text}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            onClick={downloadBackup}
            disabled={backingUp}
            className="inline-flex items-center gap-2 rounded-2xl bg-gray-900 hover:bg-gray-700 disabled:opacity-60 text-white font-semibold px-5 py-3 text-sm transition-colors shadow-sm"
          >
            <Download className="h-4 w-4" />
            {backingUp ? 'Preparing…' : 'Download backup'}
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring}
            className="inline-flex items-center gap-2 rounded-2xl border border-orange-200 bg-orange-50 hover:bg-orange-100 disabled:opacity-60 text-orange-700 font-semibold px-5 py-3 text-sm transition-colors"
          >
            <Upload className="h-4 w-4" />
            {restoring ? 'Restoring…' : 'Restore from backup'}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleRestoreFile}
          />
        </div>

        <p className="text-xs text-gray-400">
          Tip: Download a backup before making big changes. The file includes all transactions, dishes, inventory, employees, and sales — but not uploaded images or chat history.
        </p>
      </div>

      </>}

    </div>
  )
}
