package com.studentplatform.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Subclasses Capacitor's own push-notifications MessagingService instead of
 * declaring a second FirebaseMessagingService — see AndroidManifest.xml's
 * tools:node="remove" for why there can only be one. super.onMessageReceived()
 * runs first, so every ordinary push (chat/announcement/payment) still reaches
 * Capacitor's JS bridge exactly as before. Only data.type == "incoming_call"
 * gets the extra handling below.
 *
 * The backend (src/lib/push/native.ts) MUST send this as a data-only message
 * (no `notification` block) — a message with a `notification` payload is
 * displayed by the OS directly and never reaches onMessageReceived at all
 * once the app is backgrounded/killed, which would skip this full-screen path
 * entirely and defeat the whole point.
 */
class IncomingCallMessagingService : MessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        val data = remoteMessage.data
        if (data["type"] != "incoming_call") return

        val callId = data["callId"] ?: return
        val callerName = data["callerName"]?.takeIf { it.isNotBlank() } ?: "Student Platform"
        val reason = data["reason"]

        showFullScreenIncomingCall(callId, callerName, reason)
    }

    private fun showFullScreenIncomingCall(callId: String, callerName: String, reason: String?) {
        val context: Context = applicationContext
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val channelId = "incoming_calls"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(channelId) == null) {
                val channel = NotificationChannel(channelId, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
                channel.description = "Admin or student voice calls inside Student Platform"
                channel.setBypassDnd(true)
                channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                nm.createNotificationChannel(channel)
            }
        }

        val fullScreenIntent = Intent(context, IncomingCallActivity::class.java).apply {
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("reason", reason)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_NO_USER_ACTION or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(
            context,
            callId.hashCode(),
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("$callerName is calling")
            .setContentText(reason ?: "Tap to answer")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(fullScreenPendingIntent)
            .setAutoCancel(true)
            .setOngoing(true)
            .build()

        nm.notify(callId.hashCode(), notification)

        // Belt-and-suspenders: on many OEMs/foreground states this beats the
        // notification to the screen. A no-op if the OS defers it (background
        // activity start restrictions) since the full-screen-intent notification
        // above is the guaranteed path — this can only help, never break it.
        try {
            context.startActivity(fullScreenIntent)
        } catch (_: Exception) {
        }
    }
}
