package dev.openpodgo.edit

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.webkit.JavascriptInterface
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.concurrent.thread

/**
 * USB host transport for the POD Go, exposed to the page as
 * `window.podgoAndroidUsb`.
 *
 * This is transport only: it claims the Line 6 vendor interface and moves bulk
 * packets, exactly like the browser's WebUSB code. The protocol lives in the
 * web app's WASM flows, so reads and gated writes keep the same rules.
 *
 * Methods are `@JavascriptInterface`, called on a WebView background thread.
 * A single reader thread owns the IN endpoint and appends packets to one
 * queue; `read()` pulls from it, `write()` sends on the OUT endpoint.
 */
class PodgoUsbBridge(private val activity: MainActivity) {
    private val usbManager =
        activity.getSystemService(Context.USB_SERVICE) as UsbManager

    private val packets = ArrayBlockingQueue<String>(MAX_QUEUED_PACKETS)
    private val permissionResult = CompletableDeferred<Boolean>()

    @Volatile private var connection: UsbDeviceConnection? = null
    @Volatile private var interfaceClaimed: UsbInterface? = null
    @Volatile private var endpointIn: UsbEndpoint? = null
    @Volatile private var endpointOut: UsbEndpoint? = null
    @Volatile private var reader: Thread? = null
    @Volatile private var running = AtomicBoolean(false)

    /** Opens the first POD Go on the bus; returns `name (0xPID)`. */
    @JavascriptInterface
    @Synchronized
    fun open(): String {
        if (connection != null) {
            return describe(requireDevice())
        }
        val device = findPedal() ?: throw IllegalStateException(
            "No POD Go found on the USB bus. Plug the pedal in with a data cable.",
        )
        if (!usbManager.hasPermission(device)) {
            requestPermission(device)
        }
        val target = vendorInterface(device) ?: throw IllegalStateException(
            "The POD Go exposes no vendor interface with bulk endpoints.",
        )
        val handle = usbManager.openDevice(device) ?: throw IllegalStateException(
            "Android refused to open the POD Go device.",
        )
        if (!handle.claimInterface(target, /* force = */ true)) {
            handle.close()
            throw IllegalStateException("Could not claim the POD Go vendor interface.")
        }
        val out = firstBulk(target, UsbConstants.USB_DIR_OUT) ?: run {
            handle.releaseInterface(target)
            handle.close()
            throw IllegalStateException("No bulk OUT endpoint on the POD Go interface.")
        }
        val input = firstBulk(target, UsbConstants.USB_DIR_IN) ?: run {
            handle.releaseInterface(target)
            handle.close()
            throw IllegalStateException("No bulk IN endpoint on the POD Go interface.")
        }
        packets.clear()
        connection = handle
        interfaceClaimed = target
        endpointIn = input
        endpointOut = out
        running.set(true)
        reader = thread(name = "podgo-usb-reader", isDaemon = true) { readLoop(handle, input) }
        return describe(device)
    }

    @Synchronized
    fun close() {
        running.set(false)
        reader?.join(500)
        reader = null
        interfaceClaimed?.let { usbInterface ->
            runCatching { connection?.releaseInterface(usbInterface) }
        }
        runCatching { connection?.close() }
        connection = null
        interfaceClaimed = null
        endpointIn = null
        endpointOut = null
        packets.clear()
    }

    @JavascriptInterface
    fun discard() {
        packets.clear()
    }

    @JavascriptInterface
    fun write(data: String): String {
        val handle = connection ?: throw IllegalStateException("USB link is closed.")
        val out = endpointOut ?: throw IllegalStateException("USB link is closed.")
        val bytes = Base64.decode(data, Base64.DEFAULT)
        var offset = 0
        while (offset < bytes.size) {
            val sent = handle.bulkTransfer(
                out,
                bytes,
                offset,
                bytes.size - offset,
                WRITE_TIMEOUT_MS,
            )
            if (sent < 0) {
                throw IllegalStateException("USB write failed (bulk transfer rejected).")
            }
            offset += sent
        }
        return "ok"
    }

    /**
     * Next packet as base64, or `null` on timeout.
     *
     * Event frames (`0x03F0 → 0x1002`) are dropped here so they can never be
     * returned in place of a pending reply. Packets that arrived together are
     * returned newline-joined.
     */
    @JavascriptInterface
    fun read(timeoutMs: Long): String? {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs.coerceIn(0, MAX_READ_WAIT_MS)
        var first = poll(deadline) ?: return null
        val batch = StringBuilder(first)
        while (true) {
            val extra = packets.poll() ?: break
            if (isReply(extra)) {
                batch.append('\n').append(extra)
            }
        }
        return batch.toString()
    }

    /** True when the Android app injected this bridge. */
    @JavascriptInterface
    fun present(): Boolean = true

    /** A device was attached while the app is running: re-open on request. */
    fun onUsbAttached(intent: Intent) {
        val device = attachedDevice(intent) ?: return
        if (usbManager.hasPermission(device)) {
            // Nothing to do: `open()` finds the device and the grant is kept.
        }
    }

    private fun poll(deadline: Long): String? {
        while (SystemClock.elapsedRealtime() < deadline) {
            val remaining = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1)
            val packet = packets.poll(remaining, TimeUnit.MILLISECONDS) ?: continue
            if (isReply(packet)) {
                return packet
            }
        }
        return null
    }

    private fun readLoop(handle: UsbDeviceConnection, endpoint: UsbEndpoint) {
        val buffer = ByteArray(BULK_IN_BUFFER)
        while (running.get()) {
            val count = try {
                handle.bulkTransfer(endpoint, buffer, buffer.size, READ_TIMEOUT_MS)
            } catch (_: Exception) {
                -1
            }
            if (count > 0) {
                val packet = Base64.encodeToString(buffer.copyOf(count), Base64.NO_WRAP)
                if (isReply(packet)) {
                    if (!packets.offer(packet)) {
                        // Keep the newest reply; a dropped event frame is safe.
                        packets.poll()
                        packets.offer(packet)
                    }
                }
            }
        }
    }

    /** Event-channel frames are notifications, never a response. */
    private fun isReply(base64: String): Boolean {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        if (bytes.size < 8) {
            return true
        }
        val isEvent = bytes[4] == 0xF0.toByte() && bytes[5] == 0x03.toByte() &&
            bytes[6] == 0x02.toByte() && bytes[7] == 0x10.toByte()
        return !isEvent
    }

    private fun findPedal(): UsbDevice? =
        usbManager.deviceList.values.firstOrNull {
            it.vendorId == LINE6_VENDOR_ID && it.productId in PODGO_PRODUCT_IDS
        }

    private fun vendorInterface(device: UsbDevice): UsbInterface? {
        val candidates = (0 until device.interfaceCount).map { device.getInterface(it) }
        fun hasBulkPair(iface: UsbInterface): Boolean =
            firstBulk(iface, UsbConstants.USB_DIR_OUT) != null &&
                firstBulk(iface, UsbConstants.USB_DIR_IN) != null
        return candidates.firstOrNull {
            it.interfaceClass == UsbConstants.USB_CLASS_VENDOR_SPEC && hasBulkPair(it)
        } ?: candidates.firstOrNull(::hasBulkPair)
    }

    /** First bulk endpoint in `direction`, via the individual-`UsbEndpoint` API. */
    private fun firstBulk(iface: UsbInterface, direction: Int): UsbEndpoint? {
        for (index in 0 until iface.endpointCount) {
            val endpoint = iface.getEndpoint(index)
            if (endpoint.direction == direction && endpoint.type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                return endpoint
            }
        }
        return null
    }

    private fun requestPermission(device: UsbDevice) {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        val intent = PendingIntent.getBroadcast(
            activity,
            0,
            Intent(ACTION_USB_PERMISSION).setPackage(activity.packageName),
            flags,
        )
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, received: Intent) {
                if (received.action != ACTION_USB_PERMISSION) {
                    return
                }
                context.unregisterReceiver(this)
                permissionResult.complete(
                    received.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false),
                )
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, IntentFilter(ACTION_USB_PERMISSION), Context.RECEIVER_NOT_EXPORTED)
        } else {
            activity.registerReceiver(receiver, IntentFilter(ACTION_USB_PERMISSION))
        }
        usbManager.requestPermission(device, intent)
        // The page is waiting in one bridge call; ask in `open()` only when
        // the system does not already hold a grant.
        val granted = runBlocking {
            withTimeoutOrNull(PERMISSION_WAIT_MS) { permissionResult.await() }
        }
        if (granted != true && !usbManager.hasPermission(device)) {
            throw IllegalStateException("USB access was not granted.")
        }
    }

    private fun requireDevice(): UsbDevice = findPedal()
        ?: throw IllegalStateException("The POD Go is no longer connected.")

    private fun describe(device: UsbDevice): String {
        val name = device.productName ?: "POD Go"
        return "$name (0x${device.productId.toString(16).padStart(4, '0')})"
    }

    private fun attachedDevice(intent: Intent): UsbDevice? = when (Build.VERSION.SDK_INT) {
        Build.VERSION_CODES.TIRAMISU ->
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else -> @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
    }

    companion object {
        const val JS_NAME = "podgoAndroidUsb"
        const val ACTION_USB_PERMISSION = "dev.openpodgo.edit.USB_PERMISSION"

        /** Line 6 vendor id and POD Go / POD Go Wireless product ids. */
        const val LINE6_VENDOR_ID = 0x0e41
        val PODGO_PRODUCT_IDS = setOf(0x4247, 0x424b)

        private const val BULK_IN_BUFFER = 512
        private const val MAX_QUEUED_PACKETS = 64
        private const val MAX_READ_WAIT_MS = 5_000L
        private const val PERMISSION_WAIT_MS = 30_000L
        private const val WRITE_TIMEOUT_MS = 2_000
        private const val READ_TIMEOUT_MS = 200
    }
}
