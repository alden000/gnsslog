package io.github.alden000.gnsslog;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
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
 *
 * While recording (setBackground true) it also keeps a native log of the last ~4 hours: sensor
 * frames at 10 Hz and GNSS fixes. Android can freeze the app's WebView with the screen off even
 * though this service keeps running; when JavaScript wakes up it calls drain() to fetch what it
 * missed and replays it at the original timestamps, so the recording has no hole. If JavaScript
 * has not called ack() for 90 s, live events are held back (they would only queue up in the
 * frozen WebView) until it does.
 */
@CapacitorPlugin(name = "VesselSensors")
public class VesselSensorsPlugin extends Plugin implements SensorEventListener {

    private static final int EMIT_MS = 40;
    private static final int BUF_MS = 100; // 10 Hz native log while recording
    private static final int BUF_FRAMES = 4 * 3600 * 10; // ~4 h
    private static final int BUF_FIXES = 4 * 3600 * 2; // ~4 h at up to 2 Hz
    private static final long ACK_TIMEOUT_MS = 90_000;

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

    // Native log (ring buffers), allocated on the first recording.
    private long[] fT;
    private float[] fR; // 9 per frame
    private boolean[] fHasR;
    private float[] fG; // 3 per frame, deg/s
    private boolean[] fHasG;
    private float[] fHA;
    private byte[] fMA;
    private int fHead = 0, fCount = 0;
    private double bx, by, bz;
    private int bn = 0;
    private double[] xData; // per fix: t, fixT, lat, lon, acc, alt, altAcc, speed, bearing
    private int xHead = 0, xCount = 0;
    private static final int XF = 9;
    private LocationManager locationManager;
    private boolean gnssOn = false;
    private volatile long lastAck = 0;

    private final Runnable bufferer = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            bufferFrame();
            handler.postDelayed(this, BUF_MS);
        }
    };

    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location l) {
            bufferFix(l);
        }

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}

        @Override
        public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}
    };

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
        lastAck = System.currentTimeMillis();
        if (background) startLog();
        else stopLog();
        call.resolve();
    }

    /** JavaScript is alive (called about once a second); live events flow while it keeps calling. */
    @PluginMethod
    public void ack(PluginCall call) {
        lastAck = System.currentTimeMillis();
        call.resolve();
    }

    /**
     * Native log entries with sinceT < t <= untilT, oldest first, at most `max` frames per call:
     *   { frames: [[t, R0..R8 | null x9, gx, gy, gz | null x3, headingAcc|null, magAccuracy|null]],
     *     fixes:  [[t, fixT, lat, lon, acc, alt, altAcc, speed, bearing]], more: bool, oldestT }
     * NaN fields are sent as null. Fixes are only returned up to the last frame sent when `more`.
     */
    @PluginMethod
    public void drain(PluginCall call) {
        lastAck = System.currentTimeMillis();
        long sinceT = call.getLong("sinceT", 0L);
        long untilT = call.getLong("untilT", Long.MAX_VALUE);
        int max = Math.max(100, call.getInt("max", 3000));
        JSObject ret = new JSObject();
        JSArray frames = new JSArray();
        JSArray fixes = new JSArray();
        boolean more = false;
        long lastFrameT = untilT;
        long oldest = -1;
        try {
            synchronized (lock) {
                int n = 0;
                for (int k = 0; k < fCount; k++) {
                    int i = (fHead - fCount + k + BUF_FRAMES) % BUF_FRAMES;
                    if (k == 0) oldest = fT[i];
                    long t = fT[i];
                    if (t <= sinceT || t > untilT) continue;
                    if (n >= max) {
                        more = true;
                        break;
                    }
                    JSArray f = new JSArray();
                    f.put(t);
                    for (int j = 0; j < 9; j++) f.put(fHasR[i] ? (Object) (double) fR[i * 9 + j] : JSObject.NULL);
                    for (int j = 0; j < 3; j++) f.put(fHasG[i] ? (Object) (double) fG[i * 3 + j] : JSObject.NULL);
                    f.put(Float.isNaN(fHA[i]) ? JSObject.NULL : (Object) (double) fHA[i]);
                    f.put(fMA[i] < 0 ? JSObject.NULL : (Object) (int) fMA[i]);
                    frames.put(f);
                    lastFrameT = t;
                    n++;
                }
                long fixUntil = more ? lastFrameT : untilT;
                for (int k = 0; k < xCount; k++) {
                    int i = (xHead - xCount + k + BUF_FIXES) % BUF_FIXES;
                    long t = (long) xData[i * XF];
                    if (t <= sinceT || t > fixUntil) continue;
                    JSArray f = new JSArray();
                    for (int j = 0; j < XF; j++) {
                        double v = xData[i * XF + j];
                        f.put(Double.isNaN(v) ? JSObject.NULL : (Object) v);
                    }
                    fixes.put(f);
                }
            }
            ret.put("frames", frames);
            ret.put("fixes", fixes);
            ret.put("more", more);
            ret.put("oldestT", oldest);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("drain failed: " + e.getMessage());
        }
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
        if (background && fT != null) {
            handler.postDelayed(bufferer, BUF_MS);
            startGnss();
        }
    }

    private void stopSensors() {
        if (!running) return;
        running = false;
        sensorManager.unregisterListener(this);
        if (handler != null) {
            handler.removeCallbacks(emitter);
            handler.removeCallbacks(bufferer);
        }
        stopGnss();
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
                    bx += event.values[0];
                    by += event.values[1];
                    bz += event.values[2];
                    bn++;
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
        if (background && System.currentTimeMillis() - lastAck > ACK_TIMEOUT_MS) {
            // JavaScript is frozen: do not pile events up in the WebView. The native log has them.
            synchronized (lock) {
                gx = gy = gz = 0;
                gn = 0;
            }
            return;
        }
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

    // ---------------------------------------------------------------- native log

    private void startLog() {
        synchronized (lock) {
            if (fT == null) {
                fT = new long[BUF_FRAMES];
                fR = new float[BUF_FRAMES * 9];
                fHasR = new boolean[BUF_FRAMES];
                fG = new float[BUF_FRAMES * 3];
                fHasG = new boolean[BUF_FRAMES];
                fHA = new float[BUF_FRAMES];
                fMA = new byte[BUF_FRAMES];
                xData = new double[BUF_FIXES * XF];
            }
            fHead = fCount = 0;
            xHead = xCount = 0;
            bx = by = bz = 0;
            bn = 0;
        }
        if (handler != null) {
            handler.removeCallbacks(bufferer);
            handler.postDelayed(bufferer, BUF_MS);
        }
        startGnss();
    }

    private void stopLog() {
        if (handler != null) handler.removeCallbacks(bufferer);
        stopGnss();
    }

    private void bufferFrame() {
        if (!background || fT == null) return;
        synchronized (lock) {
            int i = fHead;
            fT[i] = System.currentTimeMillis();
            fHasR[i] = hasRotation;
            if (hasRotation) System.arraycopy(rotation, 0, fR, i * 9, 9);
            fHasG[i] = bn > 0;
            if (bn > 0) {
                double k = 180.0 / Math.PI / bn;
                fG[i * 3] = (float) (bx * k);
                fG[i * 3 + 1] = (float) (by * k);
                fG[i * 3 + 2] = (float) (bz * k);
            }
            bx = by = bz = 0;
            bn = 0;
            fHA[i] = headingAccDeg;
            fMA[i] = (byte) magAccuracy;
            fHead = (fHead + 1) % BUF_FRAMES;
            if (fCount < BUF_FRAMES) fCount++;
        }
    }

    private void bufferFix(Location l) {
        if (!background || xData == null) return;
        synchronized (lock) {
            int o = xHead * XF;
            xData[o] = System.currentTimeMillis();
            xData[o + 1] = l.getTime();
            xData[o + 2] = l.getLatitude();
            xData[o + 3] = l.getLongitude();
            xData[o + 4] = l.hasAccuracy() ? l.getAccuracy() : Double.NaN;
            xData[o + 5] = l.hasAltitude() ? l.getAltitude() : Double.NaN;
            xData[o + 6] = Build.VERSION.SDK_INT >= 26 && l.hasVerticalAccuracy() ? l.getVerticalAccuracyMeters() : Double.NaN;
            xData[o + 7] = l.hasSpeed() ? l.getSpeed() : Double.NaN;
            xData[o + 8] = l.hasBearing() ? l.getBearing() : Double.NaN;
            xHead = (xHead + 1) % BUF_FIXES;
            if (xCount < BUF_FIXES) xCount++;
        }
    }

    /** GNSS for the native log (the live fixes come from the background-geolocation plugin). */
    private void startGnss() {
        if (gnssOn || handler == null) return;
        if (locationManager == null) locationManager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        String provider = LocationManager.GPS_PROVIDER;
        if (Build.VERSION.SDK_INT >= 31 && locationManager.hasProvider(LocationManager.FUSED_PROVIDER)) provider = LocationManager.FUSED_PROVIDER;
        try {
            locationManager.requestLocationUpdates(provider, 1000L, 0f, locationListener, handler.getLooper());
            gnssOn = true;
        } catch (SecurityException | IllegalArgumentException e) {
            gnssOn = false; // no permission yet: frames are still logged
        }
    }

    private void stopGnss() {
        if (!gnssOn || locationManager == null) return;
        try {
            locationManager.removeUpdates(locationListener);
        } catch (Exception ignore) {}
        gnssOn = false;
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
