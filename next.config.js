/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone output is only needed for Electron packaging
  ...(process.env.BUILD_TARGET === 'electron' ? { output: 'standalone' } : {}),

  images: {
    remotePatterns: [
      // Allow any public HTTPS image (Vercel Blob, Imgur, Cloudinary, etc.)
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
}
module.exports = nextConfig
