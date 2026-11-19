package dev.openpodgo.edit

import android.annotation.SuppressLint
import androidx.activity.ComponentActivity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import dev.openpodgo.edit.R
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebViewAssetLoader

/**
 * WebView shell around the bundled web editor.
 *
 * Assets are served by [WebViewAssetLoader] under a virtual HTTPS origin, so
 * WASM, module scripts and `crypto.subtle` get a secure context while nothing
 * is downloaded. Off-origin links open in the system browser.
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var usbBridge: PodgoUsbBridge
    private lateinit var fileBridge: PodgoFileBridge
    private lateinit var assetLoader: WebViewAssetLoader

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val background = Color.parseColor("#18191b")

        val root = FrameLayout(this).apply { setBackgroundColor(background) }
        webView = WebView(this).apply {
            setBackgroundColor(background)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = AssetClient()
        }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        usbBridge = PodgoUsbBridge(this)
        webView.addJavascriptInterface(usbBridge, PodgoUsbBridge.JS_NAME)
        fileBridge = PodgoFileBridge(this)
        webView.addJavascriptInterface(fileBridge, PodgoFileBridge.JS_NAME)
        onUsbIntent(intent)

        // The page dismisses its own UI (the preset drawer) first; the app
        // exits only when the page reports nothing to close.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript(
                        "window.__podgoBack ? window.__podgoBack() : false",
                    ) { handled ->
                        if (handled != "true") {
                            finishAfterTransition()
                        }
                    }
                }
            },
        )

        if (savedInstanceState == null) {
            webView.loadUrl(INDEX_URL)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        onUsbIntent(intent)
    }

    override fun onDestroy() {
        usbBridge.close()
        webView.removeJavascriptInterface(PodgoUsbBridge.JS_NAME)
        webView.removeJavascriptInterface(PodgoFileBridge.JS_NAME)
        webView.destroy()
        super.onDestroy()
    }

    /** Shown after an export lands in the app's Downloads folder. */
    fun notifySaved(path: String) {
        runOnUiThread {
            Toast.makeText(
                this,
                getString(R.string.saved_to, path),
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    /** A POD Go plugged in while the app runs re-uses the granted permission. */
    private fun onUsbIntent(intent: Intent?) {
        if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            usbBridge.onUsbAttached(intent)
        }
    }

    private inner class AssetClient : WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean {
            val url = request.url
            if (url.scheme == "https" && url.host == APP_HOST) {
                return false
            }
            openExternally(url)
            return true
        }
    }

    private fun openExternally(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.link_unavailable, Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        /** Virtual origin served from `assets/`; nothing hits the network. */
        const val APP_HOST = "appassets.androidplatform.net"
        const val INDEX_URL = "https://$APP_HOST/www/index.html"
    }
}
