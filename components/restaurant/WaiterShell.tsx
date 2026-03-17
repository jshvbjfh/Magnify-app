'use client'

import { useState } from 'react'
import { UtensilsCrossed, ArrowLeftRight, Layout, ChefHat, LogOut } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import RestaurantOrders from '@/components/restaurant/RestaurantOrders'
import RestaurantTables from '@/components/restaurant/RestaurantTables'
import RestaurantKitchen from '@/components/restaurant/RestaurantKitchen'

type TabId = 'menu' | 'transactions' | 'tables' | 'kitchen'

const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'menu',         label: 'Menu',         icon: <UtensilsCrossed className="h-4 w-4" /> },
  { id: 'transactions', label: 'Transactions', icon: <ArrowLeftRight className="h-4 w-4" /> },
  { id: 'tables',       label: 'Tables',       icon: <Layout className="h-4 w-4" /> },
  { id: 'kitchen',      label: 'Kitchen',      icon: <ChefHat className="h-4 w-4" /> },
]

export default function WaiterShell() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<TabId>('menu')
  const [pendingCount, setPendingCount] = useState(0)

  const waiterName = (session?.user as any)?.name ?? 'Waiter'
  const initials   = waiterName.split(' ').slice(0, 2).map((w: string) => w[0]).join('').toUpperCase()

  // POS (menu) tab fills the entire remaining height; others scroll normally
  const isPOS = activeTab === 'menu'

  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">

      {/* ── Top navigation bar ── */}
      <header className="bg-gray-900 text-white shadow-md flex-shrink-0 z-30">
        <div className="px-4 flex items-center justify-between h-14">

          {/* Brand */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg bg-orange-500 flex items-center justify-center text-white font-black text-xs select-none">
              {initials || 'W'}
            </div>
            <span className="text-sm font-bold text-white leading-none hidden sm:block">{waiterName}</span>
          </div>

          {/* Tab navigation */}
          <nav className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`relative flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === t.id
                    ? 'bg-white/10 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {t.icon}
                <span className="hidden sm:inline">{t.label}</span>
                {/* badge for active orders on menu tab */}
                {t.id === 'menu' && pendingCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] bg-orange-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Sign out */}
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {/* ── Content ── */}
      <main className={isPOS ? 'flex-1 overflow-hidden' : 'flex-1 overflow-y-auto'}>
        {activeTab === 'menu' && (
          <RestaurantOrders
            mode="pos"
            onAskJesse={() => {}}
            onPendingCountChange={setPendingCount}
          />
        )}
        {activeTab === 'transactions' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantOrders mode="history" onAskJesse={() => {}} />
          </div>
        )}
        {activeTab === 'tables'  && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantTables onAskJesse={() => {}} />
          </div>
        )}
        {activeTab === 'kitchen' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantKitchen onAskJesse={() => {}} />
          </div>
        )}
      </main>
    </div>
  )
}
