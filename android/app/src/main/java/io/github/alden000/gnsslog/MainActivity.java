package io.github.alden000.gnsslog;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VesselSensorsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
