import { useState, useEffect } from 'react'
import { getStoredUser, logout } from '../services/auth'
import type { WaiterUser } from '../services/auth'

interface AuthState {
  user: WaiterUser | null
  isLoading: boolean
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, isLoading: true })

  useEffect(() => {
    getStoredUser()
      .then(user => setState({ user, isLoading: false }))
      .catch(() => setState({ user: null, isLoading: false }))
  }, [])

  async function signOut() {
    await logout()
    setState({ user: null, isLoading: false })
  }

  return { user: state.user, isLoading: state.isLoading, signOut }
}
