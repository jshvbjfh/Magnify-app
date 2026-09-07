import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CIS_DESIGNATION, MAGNIFY_VERSION } from '@/lib/fiscalContext'

// §7.7 — the software version prints on every receipt and must be verifiable by
// Authority personnel. It is hard-coded in lib/fiscalContext because
// npm_package_version does not exist at runtime in a packaged app.
//
// Hard-coding is only safe if it cannot drift, which is what this file is for.
// Bumping the version in package.json and forgetting the constant would print
// last release's version on every receipt of the new one — a discrepancy an
// auditor would find before we did.
describe('the printed software version', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }

  it('matches package.json', () => {
    expect(MAGNIFY_VERSION).toBe(pkg.version)
  })

  it('names the product as well as the number', () => {
    // §18.1.4 prints this beside the MRC, where a bare "1.1.50" would identify
    // nothing to someone holding receipts from several systems.
    expect(CIS_DESIGNATION).toBe(`Magnify ${pkg.version}`)
  })
})
