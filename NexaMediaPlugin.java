package com.leonard.nexamusic;

import android.Manifest;
import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Pont JavaScript ⇄ Android (« NexaMedia »).
 *  - permissions : fichiers audio, notifications, optimisation de batterie
 *  - lecture : état envoyé au service de premier plan, commandes renvoyées sous forme d'événement « mediaAction »
 *  - scan : liste des musiques du téléphone (MediaStore)
 */
@CapacitorPlugin(
    name = "NexaMedia",
    permissions = {
        @Permission(alias = "audio13", strings = { "android.permission.READ_MEDIA_AUDIO" }),
        @Permission(alias = "audio12", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notif", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class NexaMediaPlugin extends Plugin {

    @Override public void load() {
        MediaPlaybackService.listener = (action, reason, value) -> {
            JSObject o = new JSObject();
            o.put("action", action); o.put("reason", reason); o.put("value", value);
            notifyListeners("mediaAction", o);
        };
    }

    @Override protected void handleOnDestroy() {
        MediaPlaybackService.listener = null;
        MediaPlaybackService.stop(getContext());
    }

    /* ---------------- Permissions ---------------- */
    private String audioAlias() { return Build.VERSION.SDK_INT >= 33 ? "audio13" : "audio12"; }

    private String stateOf(String alias) {
        PermissionState s = getPermissionState(alias);
        return s == null ? "denied" : s.toString();
    }

    private JSObject status() {
        JSObject o = new JSObject();
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("audio", stateOf(audioAlias()));
        // avant Android 13, les notifications n'ont pas de permission d'exécution
        o.put("notifications", Build.VERSION.SDK_INT >= 33 ? stateOf("notif") : "granted");
        PowerManager pm = (PowerManager) getContext().getSystemService(Activity.POWER_SERVICE);
        o.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        return o;
    }

    @PluginMethod public void getStatus(PluginCall call) { call.resolve(status()); }

    @PluginMethod public void request(PluginCall call) {
        String kind = call.getString("kind", "audio");
        if ("notifications".equals(kind)) {
            if (Build.VERSION.SDK_INT < 33) { call.resolve(status()); return; }
            requestPermissionForAlias("notif", call, "permResult");
        } else {
            requestPermissionForAlias(audioAlias(), call, "permResult");
        }
    }

    @PermissionCallback private void permResult(PluginCall call) { call.resolve(status()); }

    @PluginMethod public void openBatterySettings(PluginCall call) {
        startSettings(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        call.resolve();
    }

    @PluginMethod public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        startSettings(i);
        call.resolve();
    }

    private void startSettings(Intent i) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
    }

    /* ---------------- Lecture ---------------- */
    @PluginMethod public void updateState(PluginCall call) {
        String title = call.getString("title", "NEXA Music");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        long pos = (long) (call.getDouble("position", 0.0) * 1000);
        long dur = (long) (call.getDouble("duration", 0.0) * 1000);
        Bitmap art = decodeArt(call.getString("artwork"));
        MediaPlaybackService.update(getContext(), title, artist, album, art, playing, pos, dur);
        call.resolve();
    }

    @PluginMethod public void stopService(PluginCall call) {
        MediaPlaybackService.stop(getContext());
        call.resolve();
    }

    private Bitmap decodeArt(String dataUrl) {
        if (dataUrl == null || dataUrl.isEmpty()) return null;
        try {
            int comma = dataUrl.indexOf(',');
            byte[] raw = Base64.decode(comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(raw, 0, raw.length);
        } catch (Exception e) { return null; }
    }

    /* ---------------- Scan des musiques du téléphone ---------------- */
    @PluginMethod public void scanAudio(PluginCall call) {
        if (getPermissionState(audioAlias()) != PermissionState.GRANTED) { call.reject("permission", "permission"); return; }
        JSArray out = new JSArray();
        String[] cols = { MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.SIZE,
                          MediaStore.Audio.Media.DATA, MediaStore.Audio.Media.MIME_TYPE };
        String sel = MediaStore.Audio.Media.IS_MUSIC + " != 0 AND " + MediaStore.Audio.Media.DURATION + " > 30000";
        try (Cursor c = getContext().getContentResolver().query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cols, sel, null,
                MediaStore.Audio.Media.DATE_ADDED + " DESC")) {
            if (c != null) while (c.moveToNext()) {
                JSObject o = new JSObject();
                o.put("name", c.getString(1)); o.put("size", c.getLong(2));
                o.put("path", c.getString(3)); o.put("mime", c.getString(4));
                out.put(o);
            }
        } catch (Exception e) { call.reject("Lecture de la médiathèque impossible : " + e.getMessage()); return; }
        JSObject r = new JSObject(); r.put("files", out);
        call.resolve(r);
    }
}
