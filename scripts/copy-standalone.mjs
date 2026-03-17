// Copies public/ and .next/static/ into .next/standalone/ after a Next.js standalone build.
// Required so the standalone server can serve static assets correctly.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const copies = [
	[path.join(root, 'public'), path.join(root, '.next', 'standalone', 'public')],
	[path.join(root, '.next', 'static'), path.join(root, '.next', 'standalone', '.next', 'static')],
]

for (const [src, dest] of copies) {
	if (fs.existsSync(src)) {
		fs.cpSync(src, dest, { recursive: true })
		console.log(`Copied: ${path.relative(root, src)} → ${path.relative(root, dest)}`)
	}
}
