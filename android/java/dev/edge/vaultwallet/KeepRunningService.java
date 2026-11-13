package dev.edge.vaultwallet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

/**
 * Keeps the wallet's process running while it is unlocked and out of sight, so Android doesn't end it and Tor, the
 * engines and the lookups carry on. The notification says only that the wallet is running: no amounts, no coins.
 */
public class KeepRunningService extends Service {
    static final String CHANNEL = "running";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null ? intent.getStringExtra(EXTRA_TITLE) : "Kusari Wallet";
        String text = intent != null && intent.getStringExtra(EXTRA_TEXT) != null ? intent.getStringExtra(EXTRA_TEXT) : "Running in the background";
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentIntent(tap)
            .setOngoing(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build();
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        // Not restarted on its own after Android ends it: the wallet is locked then, and nothing should run.
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
