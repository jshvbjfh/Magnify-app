import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBaseUrl = String(env.VITE_API_BASE_URL ?? '').trim()

  if (command === 'build' && !apiBaseUrl) {
    throw new Error(
      'waiter-app build requires VITE_API_BASE_URL. Set it to the exact deployed API base URL before running npm run build.'
    )
  }

  return {
    plugins: [react()],
  }
})
