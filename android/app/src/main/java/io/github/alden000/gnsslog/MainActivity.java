package io.github.alden000.gnsslog;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VesselSensorsPlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the WebView's renderer process at "important" priority even when it is not
        // visible (screen off), so Android is less inclined to freeze the recorder. The native
        // log in VesselSensorsPlugin covers the times it freezes anyway.
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null && Build.VERSION.SDK_INT >= 26) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }
}
