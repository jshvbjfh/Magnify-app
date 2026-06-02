/**
 * Fixes broken qrMenuHeroImageUrl records that point to local /api/uploads/... paths.
 * Reads the PNG files from disk, converts to base64 data URLs, and writes to the DB.
 *
 * Run: node scripts/fix-qr-image-paths.mjs
 */
import { PrismaClient } from '@prisma/client'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const prisma = new PrismaClient()

async function toDataUrl(filePath) {
  const bytes = await readFile(filePath)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

async function main() {
  // 1. Find all branches whose qrMenuHeroImageUrl is a local /api/uploads/... path
  const branches = await prisma.branch.findMany({
    where: { qrMenuHeroImageUrl: { startsWith: '/api/uploads/' } },
    select: { id: true, name: true, qrMenuHeroImageUrl: true },
  })

  if (branches.length === 0) {
    console.log('No branches with broken local-path image URLs found. Nothing to do.')
    return
  }

  console.log(`Found ${branches.length} branch(es) with broken image paths:\n`)

  for (const branch of branches) {
    const urlPath = branch.qrMenuHeroImageUrl  // e.g. /api/uploads/qr-menu/qr-menu-....png
    // The file lives at public/<rest of path stripped of /api/>
    // /api/uploads/qr-menu/file.png → public/uploads/qr-menu/file.png
    const relativePath = urlPath.replace(/^\/api\//, 'public/')
    const absPath = path.join(ROOT, relativePath)
    const filename = path.basename(absPath)

    console.log(`Branch: ${branch.name} (${branch.id})`)
    console.log(`  Broken path: ${urlPath}`)
    console.log(`  Looking for: ${absPath}`)

    let dataUrl
    try {
      dataUrl = await toDataUrl(absPath)
      console.log(`  File found — size: ${Math.round(dataUrl.length / 1024)} KB as data URL`)
    } catch {
      // File not found on disk — check if there's another file for the same branch
      const uploadsDir = path.join(ROOT, 'public', 'uploads', 'qr-menu')
      const { readdir } = await import('node:fs/promises')
      let candidates
      try {
        candidates = await readdir(uploadsDir)
      } catch {
        candidates = []
      }

      // Match by branch ID embedded in filename
      const matching = candidates.filter(f => f.includes(branch.id) && f.endsWith('.png'))
      if (matching.length > 0) {
        // Use the most recent one (largest timestamp)
        matching.sort()
        const candidate = path.join(uploadsDir, matching[matching.length - 1])
        console.log(`  Original file not found; using candidate: ${matching[matching.length - 1]}`)
        try {
          dataUrl = await toDataUrl(candidate)
          console.log(`  Candidate file found — size: ${Math.round(dataUrl.length / 1024)} KB as data URL`)
        } catch {
          console.log(`  SKIP: could not read candidate file either.`)
          continue
        }
      } else {
        console.log(`  SKIP: no local file found for this branch.`)
        continue
      }
    }

    await prisma.branch.update({
      where: { id: branch.id },
      data: { qrMenuHeroImageUrl: dataUrl },
    })
    console.log(`  ✓ Updated DB record.\n`)
  }

  // Also check for the second local-path pattern: /uploads/... (without /api prefix)
  const branches2 = await prisma.branch.findMany({
    where: {
      qrMenuHeroImageUrl: { startsWith: '/uploads/' },
    },
    select: { id: true, name: true, qrMenuHeroImageUrl: true },
  })

  for (const branch of branches2) {
    const urlPath = branch.qrMenuHeroImageUrl
    const absPath = path.join(ROOT, 'public', urlPath)
    console.log(`Branch: ${branch.name} (${branch.id})`)
    console.log(`  Broken path: ${urlPath}`)
    let dataUrl
    try {
      dataUrl = await toDataUrl(absPath)
    } catch {
      console.log(`  SKIP: file not found at ${absPath}`)
      continue
    }
    await prisma.branch.update({
      where: { id: branch.id },
      data: { qrMenuHeroImageUrl: dataUrl },
    })
    console.log(`  ✓ Updated DB record.\n`)
  }

  console.log('Done.')
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
