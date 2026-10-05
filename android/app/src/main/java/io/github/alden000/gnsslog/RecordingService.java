package io.github.alden000.gnsslog;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * GNSS Log's own foreground service of type "location", running while a recording is active.
 *
 * It owns what must survive the screen being off: the GNSS location requests, a partial wake lock
 * and the "recording" notification. Android grants background location reliably to a location
 * foreground service the app starts itself while it is on screen; owning it here (rather than
 * relying on a third-party plugin's service) keeps that guarantee in our hands.
 *
 * Fixes go to {@link #sink} (VesselSensorsPlugin's native log). The sensor frames are logged by the
 * plugin in the same process, which this service keeps alive.
 */
public class RecordingService extends Service {

    /** Receives every fix while the service runs (set by VesselSensorsPlugin). */
    public interface FixSink {
        void onFix(Location l);
    }

    public static volatile FixSink sink;
    /** Fast GPS test: the GNSS chip itself (GPS_PROVIDER) asked for a fix every 100 ms. */
    public static volatile boolean fast = false;

    // Diagnostics, read by VesselSensorsPlugin.drain().
    public static volatile boolean running = false;
    public static volatile boolean gnssOn = false;
    public static volatile String provider = null;
    public static volatile String error = null;
    public static volatile long lastFixWall = 0;
    public static volatile int fixes = 0;

    private static final String CHANNEL = "recording";
    private static final int NOTIFICATION_ID = 4711;

    private HandlerThread thread;
    private Handler handler;
    private LocationManager lm;
    private PowerManager.WakeLock wakeLock;

    private final LocationListener listener = new LocationListener() {
        @Override
        public void onLocationChanged(Location l) {
            lastFixWall = System.currentTimeMillis();
            fixes++;
            FixSink s = sink;
            if (s != null) s.onFix(l);
        }

        @Override
        public void onProviderEnabled(String p) {}

        @Override
        public void onProviderDisabled(String p) {}

        @Override
        public void onStatusChanged(String p, int status, Bundle extras) {}
    };

    public static void start(Context c) {
        Intent i = new Intent(c, RecordingService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, RecordingService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION_ID, n);
        } catch (Exception e) {
            // e.g. location permission revoked: Android refuses a location foreground service.
            error = "startForeground: " + e.getClass().getSimpleName() + ": " + e.getMessage();
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        acquireWakeLock();
        startGnss();
        // Without the WebView there is nothing to record into, so do not restart on our own.
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while GNSS Log is recording");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("GNSS Log is recording")
            .setContentText("Logging position and heading. Open the app to stop.")
            .setSmallIcon(R.drawable.ic_stat_recording)
            .setContentIntent(pi)
            .setOngoing(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setUsesChronometer(true);
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void startGnss() {
        if (gnssOn) return;
        if (thread == null) {
            thread = new HandlerThread("RecordingService");
            thread.start();
            handler = new Handler(thread.getLooper());
        }
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        String p = LocationManager.GPS_PROVIDER;
        if (!fast && Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)) p = LocationManager.FUSED_PROVIDER;
        try {
            lm.requestLocationUpdates(p, fast ? 100L : 1000L, 0f, listener, handler.getLooper());
            gnssOn = true;
            provider = p;
            error = null;
        } catch (SecurityException | IllegalArgumentException e) {
            gnssOn = false;
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gnsslog:recording");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire(12 * 60 * 60 * 1000L); // safety timeout: 12 h
    }

    @Override
    public void onDestroy() {
        if (lm != null) {
            try {
                lm.removeUpdates(listener);
            } catch (Exception ignore) {}
        }
        gnssOn = false;
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
