import Link from 'next/link'
import { SearchX } from 'lucide-react'

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-10 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-orange-100 rounded-2xl mb-5">
          <SearchX className="h-8 w-8 text-orange-500" />
        </div>
        <h1 className="text-5xl font-extrabold text-gray-900 mb-2">404</h1>
        <h2 className="text-xl font-semibold text-gray-700 mb-2">Page Not Found</h2>
        <p className="text-sm text-gray-500 mb-6">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/login"
          className="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
        >
          Go to Login
        </Link>
      </div>
    </main>
  )
}
