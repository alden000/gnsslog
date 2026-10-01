package io.github.alden000.gnsslog;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

/**
 * Attitude and gyroscope for GNSS Log, delivered from native code so they keep flowing while the
 * app is in the background (web DeviceOrientation/DeviceMotion events stop when the page is hidden).
 *
 * Emits "motion" every 40 ms (25 Hz) on a background thread:
 *   { t, R: [9] | null, gyro: [x, y, z] deg/s | null, headingAcc: deg | null, magAccuracy: 0-3 | null }
 * R is Android's rotation matrix (row-major) from TYPE_ROTATION_VECTOR, mapping device axes to
 * East/North/Up — the same convention as the W3C DeviceOrientation rotation matrix. gyro is the
 * mean angular velocity over the 40 ms window in device axes. The event doubles as a steady clock
 * for the JavaScript logger, whose timers may be throttled while the app is hidden.
 */
@CapacitorPlugin(name = "VesselSensors")
public class VesselSensorsPlugin extends Plugin implements SensorEventListener {

    private static final int EMIT_MS = 40;

    private SensorManager sensorManager;
    private HandlerThread thread;
    private Handler handler;
    private boolean running = false;
    private boolean background = false; // keep sensors + CPU alive while the activity is paused
    private PowerManager.WakeLock wakeLock;

    private final Object lock = new Object();
    private final float[] rotation = new float[9];
    private boolean hasRotation = false;
    private float headingAccDeg = Float.NaN;
    private int magAccuracy = -1;
    private double gx, gy, gz;
    private int gn = 0;

    private final Runnable emitter = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            emit();
            handler.postDelayed(this, EMIT_MS);
        }
    };

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("rotation", sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null);
        ret.put("gyro", sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null);
        startSensors();
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSensors();
        call.resolve();
    }

    /** While recording: keep sensors registered and hold a partial wake lock in the background. */
    @PluginMethod
    public void setBackground(PluginCall call) {
        background = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        if (background) acquireWakeLock();
        else releaseWakeLock();
        if (background && !running) startSensors();
        call.resolve();
    }

    /** Whether Android exempts the app from battery optimisation (Samsung: "Unrestricted"). */
    @PluginMethod
    public void batteryStatus(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject ret = new JSObject();
        ret.put("unrestricted", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(ret);
    }

    /** Ask the user to exempt the app from battery optimisation so recordings are not killed. */
    @PluginMethod
    public void requestUnrestrictedBattery(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    private void startSensors() {
        if (running) return;
        if (thread == null) {
            thread = new HandlerThread("VesselSensors");
            thread.start();
            handler = new Handler(thread.getLooper());
        }
        Sensor rv = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        Sensor gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        Sensor mag = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        if (rv != null) sensorManager.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME, handler);
        if (gyro != null) sensorManager.registerListener(this, gyro, SensorManager.SENSOR_DELAY_GAME, handler);
        // Registered only to receive calibration-accuracy callbacks for the compass.
        if (mag != null) sensorManager.registerListener(this, mag, SensorManager.SENSOR_DELAY_UI, handler);
        running = true;
        handler.postDelayed(emitter, EMIT_MS);
    }

    private void stopSensors() {
        if (!running) return;
        running = false;
        sensorManager.unregisterListener(this);
        if (handler != null) handler.removeCallbacks(emitter);
        synchronized (lock) {
            hasRotation = false;
            gn = 0;
            gx = gy = gz = 0;
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        synchronized (lock) {
            switch (event.sensor.getType()) {
                case Sensor.TYPE_ROTATION_VECTOR:
                    SensorManager.getRotationMatrixFromVector(rotation, event.values);
                    hasRotation = true;
                    if (event.values.length > 4 && event.values[4] >= 0) {
                        headingAccDeg = (float) Math.toDegrees(event.values[4]);
                    }
                    break;
                case Sensor.TYPE_GYROSCOPE:
                    gx += event.values[0];
                    gy += event.values[1];
                    gz += event.values[2];
                    gn++;
                    break;
                default:
                    break;
            }
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        if (sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) {
            synchronized (lock) {
                magAccuracy = accuracy;
            }
        }
    }

    private void emit() {
        JSObject data = new JSObject();
        try {
            fill(data);
        } catch (JSONException e) {
            return; // non-finite value from a sensor glitch: skip this frame
        }
        notifyListeners("motion", data);
    }

    private void fill(JSObject data) throws JSONException {
        synchronized (lock) {
            data.put("t", System.currentTimeMillis());
            if (hasRotation) {
                JSArray r = new JSArray();
                for (float v : rotation) r.put((double) v);
                data.put("R", r);
            } else {
                data.put("R", null);
            }
            if (gn > 0) {
                double k = 180.0 / Math.PI / gn;
                JSArray g = new JSArray();
                g.put(gx * k);
                g.put(gy * k);
                g.put(gz * k);
                data.put("gyro", g);
                gx = gy = gz = 0;
                gn = 0;
            } else {
                data.put("gyro", null);
            }
            data.put("headingAcc", Float.isNaN(headingAccDeg) ? null : (double) headingAccDeg);
            data.put("magAccuracy", magAccuracy >= 0 ? magAccuracy : null);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gnsslog:recording");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire(12 * 60 * 60 * 1000L); // safety timeout: 12 h
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    @Override
    protected void handleOnPause() {
        if (!background) stopSensors(); // not recording: save battery while hidden
    }

    @Override
    protected void handleOnResume() {
        if (hasListeners("motion")) startSensors();
    }

    @Override
    protected void handleOnDestroy() {
        stopSensors();
        releaseWakeLock();
        if (thread != null) thread.quitSafely();
    }
}
