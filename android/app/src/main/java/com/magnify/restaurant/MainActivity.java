package com.magnify.restaurant;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

	private static final String OFFLINE_PAGE_BASE_URL = "https://offline.magnify.local/";

	private ConnectivityManager connectivityManager;
	private ConnectivityManager.NetworkCallback networkCallback;
	private boolean showingOfflineFallback = false;
	private String lastRequestedUrl;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		if (getBridge() == null) {
			return;
		}

		connectivityManager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
		lastRequestedUrl = getBridge().getAppUrl();

		getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
			@Override
			public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
				if (url != null && !url.startsWith(OFFLINE_PAGE_BASE_URL)) {
					lastRequestedUrl = url;
					showingOfflineFallback = false;
				}
				super.onPageStarted(view, url, favicon);
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				super.onReceivedError(view, request, error);
				if (shouldShowOfflineFallback(request, error)) {
					showOfflineFallback(view, request.getUrl().toString());
				}
			}

			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
				super.onReceivedHttpError(view, request, errorResponse);
				if (request != null && request.isForMainFrame() && errorResponse != null) {
					int statusCode = errorResponse.getStatusCode();
					if (statusCode >= 500 && !isNetworkAvailable()) {
						showOfflineFallback(view, request.getUrl().toString());
					}
				}
			}
		});

		registerNetworkCallback();
	}

	@Override
	public void onResume() {
		super.onResume();
		reloadFromOfflineFallbackIfNeeded();
	}

	@Override
	public void onDestroy() {
		unregisterNetworkCallback();
		super.onDestroy();
	}

	private boolean shouldShowOfflineFallback(WebResourceRequest request, WebResourceError error) {
		if (request == null || error == null || !request.isForMainFrame()) {
			return false;
		}

		String url = request.getUrl() != null ? request.getUrl().toString() : "";
		if (url.startsWith(OFFLINE_PAGE_BASE_URL)) {
			return false;
		}

		int errorCode = error.getErrorCode();
		return errorCode == android.webkit.WebViewClient.ERROR_HOST_LOOKUP
			|| errorCode == android.webkit.WebViewClient.ERROR_CONNECT
			|| errorCode == android.webkit.WebViewClient.ERROR_TIMEOUT
			|| errorCode == android.webkit.WebViewClient.ERROR_IO
			|| errorCode == android.webkit.WebViewClient.ERROR_PROXY_AUTHENTICATION
			|| errorCode == android.webkit.WebViewClient.ERROR_UNKNOWN
			|| !isNetworkAvailable();
	}

	private void showOfflineFallback(WebView view, String failedUrl) {
		showingOfflineFallback = true;
		lastRequestedUrl = failedUrl != null && !failedUrl.isEmpty() ? failedUrl : getBridge().getAppUrl();
		view.stopLoading();
		view.loadDataWithBaseURL(
			OFFLINE_PAGE_BASE_URL,
			buildOfflineHtml(lastRequestedUrl),
			"text/html",
			"UTF-8",
			null
		);
	}

	private void reloadFromOfflineFallbackIfNeeded() {
		if (!showingOfflineFallback || !isNetworkAvailable() || getBridge() == null) {
			return;
		}

		WebView webView = getBridge().getWebView();
		if (webView == null) {
			return;
		}

		showingOfflineFallback = false;
		webView.loadUrl(lastRequestedUrl != null && !lastRequestedUrl.isEmpty() ? lastRequestedUrl : getBridge().getAppUrl());
	}

	private boolean isNetworkAvailable() {
		if (connectivityManager == null) {
			return true;
		}

		Network activeNetwork = connectivityManager.getActiveNetwork();
		if (activeNetwork == null) {
			return false;
		}

		NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(activeNetwork);
		return capabilities != null
			&& capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
			&& capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
	}

	private void registerNetworkCallback() {
		if (connectivityManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
			return;
		}

		networkCallback = new ConnectivityManager.NetworkCallback() {
			@Override
			public void onAvailable(Network network) {
				runOnUiThread(() -> reloadFromOfflineFallbackIfNeeded());
			}
		};

		NetworkRequest request = new NetworkRequest.Builder()
			.addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
			.build();
		connectivityManager.registerNetworkCallback(request, networkCallback);
	}

	private void unregisterNetworkCallback() {
		if (connectivityManager == null || networkCallback == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
			return;
		}

		try {
			connectivityManager.unregisterNetworkCallback(networkCallback);
		} catch (IllegalArgumentException ignored) {
		}
		networkCallback = null;
	}

	private String buildOfflineHtml(String retryUrl) {
		String safeRetryUrl = escapeJsString(retryUrl != null && !retryUrl.isEmpty() ? retryUrl : getBridge().getAppUrl());

		return "<!DOCTYPE html>"
			+ "<html lang=\"en\"><head><meta charset=\"utf-8\" />"
			+ "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1\" />"
			+ "<title>Magnify Offline</title>"
			+ "<style>"
			+ "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111827;color:#f9fafb;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;}"
			+ ".card{width:min(100%,420px);background:linear-gradient(180deg,#1f2937,#111827);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.35);}"
			+ ".badge{display:inline-flex;align-items:center;gap:8px;background:rgba(249,115,22,.14);color:#fdba74;border:1px solid rgba(249,115,22,.24);padding:8px 12px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}"
			+ "h1{font-size:30px;line-height:1.1;margin:18px 0 12px;}"
			+ "p{margin:0 0 12px;color:#d1d5db;font-size:15px;line-height:1.6;}"
			+ ".note{margin-top:16px;padding:14px 16px;border-radius:18px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);font-size:14px;color:#e5e7eb;}"
			+ ".actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px;}"
			+ "button{border:0;border-radius:16px;padding:14px 18px;font-size:15px;font-weight:700;cursor:pointer;}"
			+ ".primary{background:#f97316;color:#fff;box-shadow:0 12px 24px rgba(249,115,22,.28);}"
			+ ".secondary{background:transparent;color:#f9fafb;border:1px solid rgba(255,255,255,.15);}"
			+ "small{display:block;margin-top:14px;color:#9ca3af;font-size:12px;}"
			+ "</style></head><body>"
			+ "<div class=\"card\">"
			+ "<div class=\"badge\">Offline Mode</div>"
			+ "<h1>Connection required to reopen Magnify</h1>"
			+ "<p>This Android build still uses the live Magnify server for app startup. Your last synced restaurant data is preserved in the app after pages load, but the shell itself needs internet to reopen.</p>"
			+ "<div class=\"note\">Go back online, then tap retry. Once the app reconnects, your cached restaurant screens and queued changes will continue from where you left off.</div>"
			+ "<div class=\"actions\">"
			+ "<button class=\"primary\" onclick=\"window.location.href='" + safeRetryUrl + "'\">Retry Connection</button>"
			+ "<button class=\"secondary\" onclick=\"window.location.reload()\">Refresh</button>"
			+ "</div>"
			+ "<small>If you need true cold-start offline support, the mobile architecture must move beyond the current server-backed shell.</small>"
			+ "</div></body></html>";
	}

	private String escapeJsString(String value) {
		return value
			.replace("\\", "\\\\")
			.replace("'", "\\'")
			.replace("\n", "")
			.replace("\r", "");
	}
}
