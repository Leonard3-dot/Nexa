package com.leonard.nexamusic;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NexaMediaPlugin.class);   // doit précéder super.onCreate
        super.onCreate(savedInstanceState);
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
