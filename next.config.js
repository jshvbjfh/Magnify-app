/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone output is only needed for Electron packaging
  ...(process.env.BUILD_TARGET === 'electron' ? { output: 'standalone' } : {}),
}
module.exports = nextConfig
