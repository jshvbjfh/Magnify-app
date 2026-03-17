const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const os = require('os')

// Resolve icon path — works both in dev and packaged
function getIconPath() {
	const candidates = [
		path.join(__dirname, '..', 'public', 'icon.ico'),
		path.join(__dirname, '..', 'public', 'icon.png'),
		path.join(process.resourcesPath || '', 'app', 'public', 'icon.ico'),
	]
	for (const p of candidates) {
		if (fs.existsSync(p)) return p
	}
	return undefined
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
	app.quit()
}

let mainWindow
let loadingWindow

function getLocalIP() {
	const interfaces = os.networkInterfaces()
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === 'IPv4' && !iface.internal) {
				return iface.address
			}
		}
	}
	return 'localhost'
}

function createLoadingWindow() {
	loadingWindow = new BrowserWindow({
		width: 420,
		height: 320,
		frame: false,
		transparent: false,
		resizable: false,
		center: true,
		alwaysOnTop: true,
		icon: getIconPath(),
		webPreferences: { nodeIntegration: true, contextIsolation: false }
	})
	loadingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
		<html>
		<body style="margin:0;background:#111827;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:white;">
			<div style="font-size:48px;margin-bottom:16px">🍽️</div>
			<div style="font-size:22px;font-weight:bold;margin-bottom:4px">Magnify</div>
			<div style="font-size:13px;color:#f97316;font-weight:600;margin-bottom:16px">Restaurant</div>
			<div style="font-size:13px;color:#9ca3af;margin-bottom:24px">Starting server, please wait...</div>
			<div style="width:200px;height:4px;background:#374151;border-radius:4px;overflow:hidden">
				<div style="width:40%;height:100%;background:linear-gradient(to right,#f97316,#dc2626);border-radius:4px;animation:slide 1.2s ease-in-out infinite" id="bar"></div>
			</div>
			<style>@keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}</style>
		</body>
		</html>
	`))
}

function createWindow(localIP) {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		show: false,
		icon: getIconPath(),
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true
		},
		title: 'Magnify — Restaurant',
		autoHideMenuBar: true
	})

	mainWindow.loadURL('http://localhost:3001')
	mainWindow.maximize()

	mainWindow.once('ready-to-show', () => {
		if (loadingWindow) {
			loadingWindow.close()
			loadingWindow = null
		}
		mainWindow.show()

		// Show the LAN address so the manager knows what to tell waiters
		if (localIP && localIP !== 'localhost') {
			dialog.showMessageBox(mainWindow, {
				type: 'info',
				title: 'Waiter Access URL',
				message: `Server is running on your network.\n\nWaiters can connect from any device on the same WiFi:\n\nhttp://${localIP}:3001\n\nShare this address with your waiters.`,
				buttons: ['Got it']
			})
		}
	})

	mainWindow.on('closed', () => {
		mainWindow = null
	})
}

app.whenReady().then(async () => {
	createLoadingWindow()

	const appDir = path.join(__dirname, '..')
	process.env.NODE_ENV = 'production'

	// Load .env file manually
	const envPath = path.join(appDir, '.env')
	if (fs.existsSync(envPath)) {
		const envContent = fs.readFileSync(envPath, 'utf8')
		for (const line of envContent.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const eqIdx = trimmed.indexOf('=')
			if (eqIdx === -1) continue
			const key = trimmed.slice(0, eqIdx).trim()
			const val = trimmed.slice(eqIdx + 1).trim().replace(/^"|"$/g, '')
			if (!process.env[key]) process.env[key] = val
		}
	}

	// Detect local IP and set NEXTAUTH_URL dynamically so session cookies work on LAN
	const localIP = getLocalIP()
	process.env.NEXTAUTH_URL = `http://${localIP}:3001`

	if (app.isPackaged) {
		const bundledDbCandidates = [
			path.join(appDir, 'dev.db'),
			path.join(appDir, 'prisma', 'dev.db')
		]
		const bundledDbPath = bundledDbCandidates.find((dbPath) => fs.existsSync(dbPath))

		const runtimeDbDir = path.join(app.getPath('userData'), 'data')
		const runtimeDbPath = path.join(runtimeDbDir, 'dev.db')
		fs.mkdirSync(runtimeDbDir, { recursive: true })

		if (!fs.existsSync(runtimeDbPath) && bundledDbPath) {
			fs.copyFileSync(bundledDbPath, runtimeDbPath)
		}

		const absoluteDbPath = runtimeDbPath.replace(/\\/g, '/')
		process.env.DATABASE_URL = `file:${absoluteDbPath}`
		console.log('Using DATABASE_URL:', process.env.DATABASE_URL)
	}

	// Run database migrations
	try {
		const { execSync } = require('child_process')
		const userDataDir = app.getPath('userData')
		const prismaBin = path.join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
		const prismaJsEntrypoint = path.join(appDir, 'node_modules', 'prisma', 'build', 'index.js')
		const schemaPath = path.join(appDir, 'prisma', 'schema.prisma')
		const migrationLogPath = path.join(app.getPath('userData'), 'migration.log')
		fs.mkdirSync(userDataDir, { recursive: true })

		if (fs.existsSync(schemaPath)) {
			const hasPrismaBin = fs.existsSync(prismaBin)
			const hasPrismaJsEntrypoint = fs.existsSync(prismaJsEntrypoint)
			const prismaCommand = hasPrismaBin
				? `"${prismaBin}"`
				: hasPrismaJsEntrypoint
					? `"${process.execPath}" "${prismaJsEntrypoint}"`
					: null

			if (prismaCommand) {
				const crypto = require('crypto')
				const schemaContent = fs.readFileSync(schemaPath)
				const schemaHash = crypto.createHash('md5').update(schemaContent).digest('hex')
				const hashCachePath = path.join(userDataDir, 'schema.hash')
				const cachedHash = fs.existsSync(hashCachePath) ? fs.readFileSync(hashCachePath, 'utf8').trim() : null

				if (schemaHash === cachedHash) {
					console.log('Schema unchanged, skipping migrations')
				} else {
					const migrationOutput = execSync(`${prismaCommand} migrate deploy --schema "${schemaPath}"`, {
						cwd: userDataDir,
						env: hasPrismaBin ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
						stdio: 'pipe',
						timeout: 20000
					}).toString()

					fs.writeFileSync(hashCachePath, schemaHash, 'utf8')
					fs.writeFileSync(
						migrationLogPath,
						`[${new Date().toISOString()}] Migration succeeded\n${migrationOutput}`,
						'utf8'
					)
					console.log('Database migrations applied successfully')
				}
			}
		}
	} catch (migrationErr) {
		const migrationLogPath = path.join(app.getPath('userData'), 'migration.log')
		const stderr = migrationErr?.stderr ? migrationErr.stderr.toString() : ''
		const stdout = migrationErr?.stdout ? migrationErr.stdout.toString() : ''
		const details = `${migrationErr?.message || 'Unknown migration error'}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
		fs.writeFileSync(
			migrationLogPath,
			`[${new Date().toISOString()}] Migration failed\n${details}`,
			'utf8'
		)
		console.error('Migration failed (non-fatal):', details)
		// Non-fatal — continue startup
	}

	// Watchdog: if the server hasn't started within 60 s, show a clear error
	const startupTimeout = setTimeout(() => {
		if (loadingWindow) {
			loadingWindow.close()
			loadingWindow = null
		}
		dialog.showErrorBox(
			'Startup Timeout',
			'The server took too long to start.\n\nPossible causes:\n• Another copy of the app is already running\n• Port 3001 is in use by another program\n• The database configuration is missing\n\nClose any other instances and try again.'
		)
		app.quit()
	}, 60000)

	// Resolve the standalone server — must be outside asar when packaged
	const standaloneDir = app.isPackaged
		? path.join(process.resourcesPath, 'app.asar.unpacked', '.next', 'standalone')
		: path.join(appDir, '.next', 'standalone')
	const standaloneServer = path.join(standaloneDir, 'server.js')

	if (!fs.existsSync(standaloneServer)) {
		clearTimeout(startupTimeout)
		if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
		dialog.showErrorBox('Startup Error', `Standalone server not found at:\n${standaloneServer}\n\nPlease rebuild the application.`)
		app.quit()
		return
	}

	const { spawn } = require('child_process')
	const serverEnv = {
		...process.env,
		PORT: '3001',
		HOSTNAME: '0.0.0.0',
		NODE_ENV: 'production',
		ELECTRON_RUN_AS_NODE: '1',
	}

	const serverProcess = spawn(process.execPath, [standaloneServer], {
		cwd: standaloneDir,
		env: serverEnv,
		stdio: 'pipe'
	})

	let serverStarted = false
	let serverDied = false
	let serverStdoutTail = ''
	let serverStderrTail = ''

	serverProcess.stdout.on('data', (data) => {
		const chunk = data.toString()
		serverStdoutTail = (serverStdoutTail + chunk).slice(-3000)
		console.log('[server]', chunk.trim())
	})
	serverProcess.stderr.on('data', (data) => {
		const chunk = data.toString()
		serverStderrTail = (serverStderrTail + chunk).slice(-3000)
		console.error('[server-err]', chunk.trim())
	})
	serverProcess.on('error', (err) => {
		if (!serverStarted) {
			serverDied = true
			clearTimeout(startupTimeout)
			if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
			dialog.showErrorBox('Server Error', err.message)
			app.quit()
		}
	})
	serverProcess.on('exit', (code) => {
		if (!serverStarted) {
			serverDied = true
			clearTimeout(startupTimeout)
			if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
			const stderr = serverStderrTail.trim()
			const stdout = serverStdoutTail.trim()
			const outputTail = stderr || stdout
			let hint = code === null
				? 'Server process was killed before it could start.'
				: `Server process exited with code ${code}.`

			if (outputTail) {
				hint += `\n\nServer output:\n${outputTail}`
			} else {
				hint += '\n\nPort 3001 may already be in use.'
			}
			dialog.showErrorBox('Server Error', hint)
			app.quit()
		}
	})

	app.on('before-quit', () => {
		if (serverProcess && !serverProcess.killed) serverProcess.kill()
	})

	function waitForServer() {
		if (serverDied) return
		http.get('http://localhost:3001', () => {
			if (serverStarted) return
			serverStarted = true
			clearTimeout(startupTimeout)
			console.log(`Next.js server running — local: http://localhost:3001 | LAN: http://${localIP}:3001`)
			createWindow(localIP)
		}).on('error', () => {
			if (!serverDied) setTimeout(waitForServer, 300)
		})
	}
	waitForServer()
})

app.on('window-all-closed', () => {
	app.quit()
})
