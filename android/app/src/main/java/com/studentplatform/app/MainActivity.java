package com.studentplatform.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleNativeCallIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleNativeCallIntent(intent);
    }

    /**
     * IncomingCallActivity hands Answer/Decline off here rather than acting on
     * them natively, since the student's session token lives only in this
     * WebView's localStorage. src/components/NativeCallBridge.tsx (web side)
     * listens for this exact event name/shape and performs the real
     * POST /api/calls/[id] using that stored token.
     *
     * triggerWindowJSEvent's data string is spliced RAW into a JS object
     * literal (see Capacitor's Bridge.java), so a JSONObject's toString() —
     * already valid JS object syntax — is exactly what it expects; do not
     * wrap it in an extra pair of quotes.
     */
    private void handleNativeCallIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra("nativeCallAction");
        String callId = intent.getStringExtra("callId");
        if (action == null || callId == null) return;
        intent.removeExtra("nativeCallAction"); // don't re-fire on rotation/recreate

        try {
            JSONObject data = new JSONObject();
            data.put("action", action);
            data.put("callId", callId);
            getBridge().triggerWindowJSEvent("nativeCallAction", data.toString());
        } catch (Exception ignored) {
        }
    }
}
