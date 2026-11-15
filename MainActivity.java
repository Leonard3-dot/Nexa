package com.leonard.nexamusic;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NexaMediaPlugin.class);   // doit précéder super.onCreate
        super.onCreate(savedInstanceState);
    }

    /** Les boutons de la notification (lecture/pause) doivent pouvoir relancer l'audio sans toucher l'écran. */
    @Override public void onStart() {
        super.onStart();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    /** Écran éteint / application en arrière-plan : on ne laisse pas la WebView se mettre en pause,
     *  sinon la musique (jouée par la page) s'arrêterait. */
    @Override public void onPause() {
        super.onPause();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
        }
    }
}
