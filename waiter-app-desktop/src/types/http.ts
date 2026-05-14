// Desktop type shim — mirrors the relevant subset of @capacitor/core types
// that the waiter-app services depend on.

export type HttpHeaders = Record<string, string>

export interface HttpResponse {
  status: number
  data: unknown
  headers: HttpHeaders
  url?: string
}
