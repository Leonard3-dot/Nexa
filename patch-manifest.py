#!/usr/bin/env python3
"""Ajoute au AndroidManifest.xml généré par Capacitor les permissions et le service de lecture.
Usage : python3 patch-manifest.py android/app/src/main/AndroidManifest.xml"""
import re, sys
p = sys.argv[1]
x = open(p, encoding='utf-8').read()

PERMS = [
    'android.permission.INTERNET',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',   # Android 14+
    'android.permission.POST_NOTIFICATIONS',                  # Android 13+
    'android.permission.READ_MEDIA_AUDIO',                    # Android 13+
    'android.permission.WAKE_LOCK',
]
add = ''
for q in PERMS:
    if q not in x: add += f'    <uses-permission android:name="{q}" />\n'
if 'READ_EXTERNAL_STORAGE' not in x:
    add += '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n'
x = x.replace('</manifest>', add + '</manifest>', 1)

if 'MediaPlaybackService' not in x:
    svc = ('        <service android:name=".MediaPlaybackService" android:exported="false"\n'
           '                 android:foregroundServiceType="mediaPlayback" />\n')
    x = x.replace('</application>', svc + '    </application>', 1)

# sécurité : la page doit pouvoir lire les fichiers locaux servis par Capacitor, rien d'autre à changer
open(p, 'w', encoding='utf-8').write(x)
print('Manifeste mis à jour')
