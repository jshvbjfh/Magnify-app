/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone output is only needed for Electron packaging
  ...(process.env.BUILD_TARGET === 'electron' ? { output: 'standalone' } : {}),

  images: {
    remotePatterns: [
      // Vercel Blob CDN — used for QR menu hero images in production
      {
        protocol: 'https',
        hostname: '**.vercel-storage.com',
      },
      {
        protocol: 'https',
        hostname: '**.public.blob.vercel-storage.com',
      },
    ],
  },
}
module.exports = nextConfig
