const token = String(process.env.GH_TOKEN || '').trim()

if (!token) {
	console.error('Missing GH_TOKEN. Set a GitHub Personal Access Token before running electron:publish.')
	console.error('PowerShell example: $env:GH_TOKEN="github_pat_..."; npm run electron:publish')
	process.exit(1)
}

console.log('GH_TOKEN detected. Continuing with Electron publish.')