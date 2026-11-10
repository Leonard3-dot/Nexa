package com.leonard.nexamusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

/**
 * Service de premier plan « lecture multimédia ».
 *
 * La musique est jouée par la page web (élément <audio>) ; ce service ne joue rien lui-même.
 * Il sert à : garder l'application en vie écran éteint, afficher la notification de lecture
 * (contrôles sur l'écran verrouillé), gérer le focus audio (appels, autres applications)
 * et le débranchement du casque. Chaque commande est renvoyée à la page via {@link Listener}.
 */
public class MediaPlaybackService extends Service {

    public interface Listener { void onAction(String action, String reason, double value); }

    public static volatile Listener listener;
    public static volatile MediaPlaybackService instance;

    static final String CHANNEL = "nexa_playback";
    static final int NOTIF_ID = 4242;
    static final String A_UPDATE = "com.leonard.nexamusic.UPDATE";
    static final String A_PLAY = "com.leonard.nexamusic.PLAY";
    static final String A_PAUSE = "com.leonard.nexamusic.PAUSE";
    static final String A_NEXT = "com.leonard.nexamusic.NEXT";
    static final String A_PREV = "com.leonard.nexamusic.PREV";
    static final String A_CLOSE = "com.leonard.nexamusic.CLOSE";

    private MediaSession session;
    private AudioManager audio;
    private AudioFocusRequest focusRequest;
    private boolean hasFocus = false;
    private boolean resumeOnGain = false;
    private boolean foreground = false;

    private String title = "NEXA Music", artist = "", album = "";
    private Bitmap art;
    private boolean playing = false;
    private long positionMs = 0, durationMs = 0;
    private long positionStamp = SystemClock.elapsedRealtime();

    /* ---- Point d'entrée statique utilisé par le plugin ---- */
    public static void update(Context ctx, String title, String artist, String album, Bitmap art,
                              boolean playing, long positionMs, long durationMs) {
        MediaPlaybackService s = instance;
        if (s != null) { s.apply(title, artist, album, art, playing, positionMs, durationMs); return; }
        if (!playing) return; // rien à afficher si le service n'existe pas et que rien ne joue
        PendingState.set(title, artist, album, art, playing, positionMs, durationMs);
        Intent i = new Intent(ctx, MediaPlaybackService.class).setAction(A_UPDATE);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
        } catch (Exception e) { /* démarrage refusé en arrière-plan : la lecture continue sans notification */ }
    }

    public static void stop(Context ctx) {
        MediaPlaybackService s = instance;
        if (s != null) s.shutdown();
        else ctx.stopService(new Intent(ctx, MediaPlaybackService.class));
    }

    /** État transmis au service pendant son démarrage (un Intent ne peut pas porter un Bitmap volumineux). */
    static final class PendingState {
        static String title, artist, album; static Bitmap art; static boolean playing; static long pos, dur; static boolean set;
        static synchronized void set(String t, String a, String al, Bitmap b, boolean p, long po, long d) {
            title = t; artist = a; album = al; art = b; playing = p; pos = po; dur = d; set = true;
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        createChannel();

        session = new MediaSession(this, "NexaMusic");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { emit("play", "user", 0); }
            @Override public void onPause() { resumeOnGain = false; emit("pause", "user", 0); }
            @Override public void onSkipToNext() { emit("next", "user", 0); }
            @Override public void onSkipToPrevious() { emit("previous", "user", 0); }
            @Override public void onSeekTo(long pos) { emit("seekTo", "user", pos / 1000.0); }
            @Override public void onStop() { emit("pause", "user", 0); shutdown(); }
        });
        session.setActive(true);

        IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(noisy, f);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (A_PLAY.equals(a)) emit("play", "user", 0);
        else if (A_PAUSE.equals(a)) { resumeOnGain = false; emit("pause", "user", 0); }
        else if (A_NEXT.equals(a)) emit("next", "user", 0);
        else if (A_PREV.equals(a)) emit("previous", "user", 0);
        else if (A_CLOSE.equals(a)) { emit("pause", "user", 0); shutdown(); return START_NOT_STICKY; }
        else if (PendingState.set) {
            PendingState.set = false;
            apply(PendingState.title, PendingState.artist, PendingState.album, PendingState.art,
                  PendingState.playing, PendingState.pos, PendingState.dur);
        } else if (!foreground) {
            // démarré sans état : on doit quand même appeler startForeground dans les 5 s
            publish();
        }
        return START_NOT_STICKY;
    }

    /* ---- État de lecture ---- */
    void apply(String t, String a, String al, Bitmap b, boolean isPlaying, long pos, long dur) {
        if (t != null) title = t;
        if (a != null) artist = a;
        if (al != null) album = al;
        if (b != null) art = b;
        playing = isPlaying; positionMs = pos; durationMs = dur;
        positionStamp = SystemClock.elapsedRealtime();

        if (playing) {
            if (!requestFocus()) { playing = false; emit("pause", "focus-denied", 0); }
        } else if (!resumeOnGain) {
            abandonFocus();
        }
        publish();
    }

    private void publish() {
        MediaMetadata.Builder m = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(m.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, playing ? 1f : 0f, positionStamp)
            .build());

        Notification n = buildNotification();
        if (!foreground) {
            try {
                if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                else startForeground(NOTIF_ID, n);
                foreground = true;
            } catch (Exception e) { /* refus système : on continue sans premier plan */ }
        } else {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIF_ID, n);
        }
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_media_play)
         .setContentTitle(title).setContentText(artist).setSubText(album.isEmpty() ? null : album)
         .setLargeIcon(art)
         .setContentIntent(openAppIntent())
         .setVisibility(Notification.VISIBILITY_PUBLIC)
         .setOnlyAlertOnce(true).setShowWhen(false).setOngoing(playing)
         .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Précédent", svc(A_PREV, 1)).build())
         .addAction(playing
             ? new Notification.Action.Builder(android.R.drawable.ic_media_pause, "Pause", svc(A_PAUSE, 2)).build()
             : new Notification.Action.Builder(android.R.drawable.ic_media_play, "Lecture", svc(A_PLAY, 3)).build())
         .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Suivant", svc(A_NEXT, 4)).build())
         .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Fermer", svc(A_CLOSE, 5)).build())
         .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private PendingIntent svc(String action, int code) {
        Intent i = new Intent(this, MediaPlaybackService.class).setAction(action);
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, code, i, fl) : PendingIntent.getService(this, code, i, fl);
    }

    private PendingIntent openAppIntent() {
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i != null) i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel c = new NotificationChannel(CHANNEL, "Lecture en cours", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Contrôles de lecture NEXA Music");
        c.setShowBadge(false);
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
    }

    /* ---- Focus audio : appels, autres lecteurs, assistants ---- */
    private final AudioManager.OnAudioFocusChangeListener focusListener = (change) -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:                    // un autre lecteur prend la main durablement
                resumeOnGain = false; hasFocus = false;
                emit("pause", "focus-loss", 0);
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:          // appel, alarme : on reprendra ensuite
                resumeOnGain = playing; 
                emit("pause", "focus-transient", 0);
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: // notification sonore : volume réduit
                emit("duck", "focus-duck", 1);
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                emit("duck", "focus-gain", 0);
                if (resumeOnGain) { resumeOnGain = false; emit("play", "focus-gain", 0); }
                break;
        }
    };

    private boolean requestFocus() {
        if (hasFocus) return true;
        int r;
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs).setOnAudioFocusChangeListener(focusListener).setWillPauseWhenDucked(false).build();
            r = audio.requestAudioFocus(focusRequest);
        } else {
            r = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        return hasFocus;
    }

    private void abandonFocus() {
        if (!hasFocus) return;
        if (Build.VERSION.SDK_INT >= 26) { if (focusRequest != null) audio.abandonAudioFocusRequest(focusRequest); }
        else audio.abandonAudioFocus(focusListener);
        hasFocus = false;
    }

    /* ---- Casque débranché / Bluetooth coupé ---- */
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) { resumeOnGain = false; emit("pause", "noisy", 0); }
        }
    };

    private void emit(String action, String reason, double value) {
        Listener l = listener;
        if (l != null) l.onAction(action, reason, value);
    }

    void shutdown() {
        abandonFocus();
        stopForeground(true);
        foreground = false;
        stopSelf();
    }

    @Override public void onTaskRemoved(Intent rootIntent) { // l'utilisateur a fermé l'app depuis les récents
        emit("pause", "task-removed", 0);
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy() {
        try { unregisterReceiver(noisy); } catch (Exception ignored) { }
        abandonFocus();
        if (session != null) { session.setActive(false); session.release(); }
        instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
