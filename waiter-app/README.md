# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  # Magnify Waiter App

  The waiter APK must be built with an explicit `VITE_API_BASE_URL`.
  Production/native builds now fail fast if that variable is missing so the bundle never bakes in a stale default host.

  ## Build

  PowerShell:

  ```powershell
  $env:VITE_API_BASE_URL = 'https://your-api-host.example.com'
  npm run build
  npx cap sync android
  ```

  Bash:

  ```bash
  VITE_API_BASE_URL=https://your-api-host.example.com npm run build
  npx cap sync android
  ```

  ## Notes

  - Use the exact deployed app/API origin the waiter app should call.
  - Hosted web builds can still fall back to the serving origin when the app is loaded from a real HTTPS host.
  - Localhost WebView origins are intentionally ignored for API resolution inside native Capacitor builds.

