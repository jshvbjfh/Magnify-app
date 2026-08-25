// Renders an HTML document to PDF via the Chromium that ships with Playwright.
//
// Usage: node render-pdf.mjs <input.html> <output.pdf> "<footer title>"

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const projectRequire = createRequire(resolve(process.cwd(), 'package.json'))
const { chromium } = projectRequire('playwright')

const [input, output, footerTitle = ''] = process.argv.slice(2)

if (!input || !output) {
  console.error('Usage: node render-pdf.mjs <input.html> <output.pdf> "<footer title>"')
  process.exit(1)
}

const browser = await chromium.launch()

try {
  const page = await browser.newPage()

  // Light explicitly: a machine set to dark mode must not emit a black-page PDF.
  await page.emulateMedia({ media: 'print', colorScheme: 'light' })

  await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'load' })

  // Google Fonts are linked, not inlined. Without this the PDF renders in the
  // fallback stack and the typography silently differs from the screen version.
  await page.evaluate(() => document.fonts.ready)

  await page.pdf({
    path: resolve(output),
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `
      <div style="width:100%;font-family:Arial,sans-serif;font-size:7.5pt;color:#85817A;
                  padding:0 14mm;display:flex;justify-content:space-between;">
        <span>${footerTitle}</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`,
  })

  console.log(`Wrote ${resolve(output)}`)
} finally {
  await browser.close()
}
