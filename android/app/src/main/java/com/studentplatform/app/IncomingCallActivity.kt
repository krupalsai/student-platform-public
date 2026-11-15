package com.studentplatform.app

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Full-screen incoming-call UI, launched by IncomingCallMessagingService's
 * full-screen-intent notification. This is the entire reason a native shell
 * exists: a browser tab cannot wake the device or draw over the lock screen
 * from a background push. Built with plain Views (no layout XML) since there
 * is no device in this environment to preview a layout against.
 */
class IncomingCallActivity : AppCompatActivity() {

    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        km.requestDismissKeyguard(this, null)

        renderFromIntent(intent)
        startRinging()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        renderFromIntent(intent)
    }

    private fun renderFromIntent(intent: Intent) {
        val callId = intent.getStringExtra("callId") ?: ""
        val callerName = intent.getStringExtra("callerName") ?: "Student Platform"
        val reason = intent.getStringExtra("reason")
        setContentView(buildUi(callerName, reason, callId))
    }

    private fun buildUi(callerName: String, reason: String?, callId: String): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0f172a"))
            setPadding(56, 220, 56, 120)
        }

        root.addView(TextView(this).apply {
            text = "Incoming call • Student Platform"
            setTextColor(Color.parseColor("#93c5fd"))
            textSize = 15f
        })
        root.addView(TextView(this).apply {
            text = callerName
            setTextColor(Color.WHITE)
            textSize = 30f
            setPadding(0, 28, 0, 0)
        })
        if (!reason.isNullOrBlank()) {
            root.addView(TextView(this).apply {
                text = reason
                setTextColor(Color.parseColor("#cbd5e1"))
                textSize = 15f
                setPadding(0, 14, 0, 0)
            })
        }

        root.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        })

        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 2f
        }
        buttonRow.addView(Button(this).apply {
            text = "Decline"
            setBackgroundColor(Color.parseColor("#dc2626"))
            setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = 16
            }
            setOnClickListener { respond(callId, "decline_call") }
        })
        buttonRow.addView(Button(this).apply {
            text = "Answer"
            setBackgroundColor(Color.parseColor("#16a34a"))
            setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = 16
            }
            setOnClickListener { respond(callId, "answer_call") }
        })
        root.addView(buttonRow)

        return root
    }

    /**
     * Hands off to MainActivity (the real WebView) rather than calling the
     * accept/decline API natively — the student's session token lives only in
     * that WebView's localStorage, not anywhere native code can read without
     * keeping a second, riskier copy of the credential. NativeCallBridge.tsx
     * (web side) listens for the resulting bridge event and performs the real
     * POST /api/calls/[id].
     */
    private fun respond(callId: String, action: String) {
        stopRinging()
        val i = Intent(this, MainActivity::class.java).apply {
            putExtra("nativeCallAction", action)
            putExtra("callId", callId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(i)
        finish()
    }

    private fun startRinging() {
        try {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
            mediaPlayer = MediaPlayer().apply {
                @Suppress("DEPRECATION")
                setAudioStreamType(AudioManager.STREAM_RING)
                setDataSource(this@IncomingCallActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) {
        }

        try {
            vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            val pattern = longArrayOf(0, 500, 500)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(pattern, 0)
            }
        } catch (_: Exception) {
        }
    }

    private fun stopRinging() {
        try {
            mediaPlayer?.stop()
            mediaPlayer?.release()
        } catch (_: Exception) {
        }
        mediaPlayer = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        stopRinging()
        super.onDestroy()
    }
}
