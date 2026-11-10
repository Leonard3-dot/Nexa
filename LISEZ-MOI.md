# NEXA Music

Application de musique hors ligne (PWA) : noir profond, bleu électrique, violet néon, verre dépoli.

## Architecture (un fichier = une responsabilité)
- `app.js`   : noyau — base locale (IndexedDB), import, lecteur, file d'attente, routeur, Media Session (écran verrouillé / notifications)
- `meta.js`  : lecture des métadonnées (ID3, titre, artiste, album, genre, année, pochette)
- `intel.js` : intelligence locale sans IA externe — classement par genre, habitudes d'écoute, recommandations, titres similaires, mixes automatiques
- `eq.js`    : égaliseur 5 bandes + préréglages (Web Audio, créé seulement à l'activation → aucune batterie perdue sinon)
- `pages.js` : pages Accueil, Explorer, Profil, Genres, Mixes, Historique, panneau Égaliseur
- `library.js` : Bibliothèque (8 onglets, tri, filtre, dossiers) et Recherche (récentes, suggestions)
- `player.js` : visualiseur audio réel, paroles (.lrc synchronisées ou texte), minuteur de sommeil, fondu entre les titres
- `sw.js`    : service worker (ouverture sans connexion) — augmentez `VERSION` à chaque mise à jour

Les données existantes (titres, playlists, favoris) de la version « Hors-Ligne Music » sont conservées.

## Mise en ligne sur GitHub Pages
1. Créez un dépôt public (ex. `nexa-music`) sur github.com.
2. « Add file » → « Upload files » : envoyez TOUS les fichiers de ce dossier, puis « Commit changes ».
3. Settings → Pages → « Deploy from a branch » → `main` / `/ (root)` → Save.
4. Ouvrez `https://VOTRE-NOM.github.io/nexa-music/` dans Chrome → menu ⋮ → « Installer l'application ».

## Permissions Android
Une application web ne scanne pas tout le téléphone : elle lit uniquement ce que vous choisissez
(« Ajouter de la musique » ou « Choisir un dossier »). Android demande l'accès au moment du choix, rien d'autre.
Pour un scan automatique du stockage, il faudrait une application native (APK) — possible comme étape suivante.

## Architecture visuelle (Phase 2)
Principes appliqués à tous les écrans :
- **Fond** : noir profond (`--bg`). **Accents** : bleu électrique (`--ac`, `--ac2`) et violet néon (`--vio`), réunis dans le dégradé `--grad`.
- **Verre dépoli** : réservé à la barre du bas, au mini-lecteur, aux boutons ronds et aux feuilles. Pas de flou sur les longues listes.
- **Animations** : uniquement `transform` et `opacity` (rapides, peu de batterie) ; coupées si le téléphone demande « réduire les animations ».
- **Navigation** : Accueil · Explorer · Bibliothèque · Recherche · Profil. Le mini-lecteur flotte au-dessus de la barre du bas ; le lecteur plein écran s'ouvre par-dessus.
- **Lecteur plein écran** : pochette, une seule barre d'ondes au centre, titre (2 lignes max), progression, commandes, puis File d'attente / Égaliseur / Similaires. L'écran défile si le téléphone est court : rien ne sort jamais de l'écran.
- **Notifications** : elles s'affichent en haut dans le lecteur pour ne jamais cacher le titre ni les boutons.

## Base de données
`hors-ligne-music` passe en **version 2** : ajout du magasin `lyrics` (paroles). Les titres, fichiers audio, pochettes et playlists existants ne sont pas touchés. Chaque titre importé depuis un dossier mémorise maintenant son dossier d'origine.

## Fonctions du lecteur (Phases 4 à 6)
- **Visualiseur** : les barres lisent le vrai spectre du son (AnalyserNode). Elles se figent si rien ne joue.
- **Paroles** : importez un fichier `.lrc` (défilement synchronisé) ou `.txt`, ou collez le texte. Les paroles intégrées aux fichiers MP3 sont lues automatiquement.
- **Minuteur de sommeil** : 5 min à 1 h 30, ou à la fin du titre. Le volume baisse doucement les 20 dernières secondes.
- **Fondu** : le volume baisse en fin de titre et remonte au début du suivant. Ce n'est **pas** un vrai chevauchement (crossfade) : le navigateur ne lit qu'un fichier à la fois.
- **Égaliseur** : 5 fréquences réelles (60 Hz à 14 kHz), préréglages Bass Booster, Rock, Pop, Jazz, Classical, Hip-Hop, Électro, Voix, Aigus+, Acoustique, et un réglage personnalisé mémorisé.
- **Pochettes** : lues dans MP3, M4A et FLAC. Sinon : menu « ⋯ » d'un titre → « Changer la pochette » (ou sur un album entier). Conservées après fermeture ; vos fichiers audio ne sont jamais modifiés.
- **Étiquettes** : MP3 (ID3), M4A, FLAC, OGG Vorbis et Opus.


## Thèmes (themes.css + themes.js)
- `style.css` n'utilise que des variables (`--bg`, `--ac`, `--glow`, `--glass-bg`, `--hero-bg`…). Les valeurs par défaut = « NEXA Nuit ».
- `themes.css` : un bloc `:root[data-theme="frozen"]` etc. par palette (Frozen Cyan, Cloud & Ocean, Electric Arctic, Sapphire & Cloud, Northern Lights).
- `themes.js` : liste des palettes + sélecteur (Profil → Apparence et thèmes). Choix mémorisé (`hlm:theme`), appliqué avant l'affichage par le petit script de `index.html`.
- Ajouter une palette : 1 bloc dans `themes.css` + 1 ligne dans `THEMES` de `themes.js`.

## Lecture en arrière-plan (APK Android)
Architecture : la musique est jouée par la page (`<audio>`, car vos fichiers sont dans IndexedDB). Android ne fait que l'entourer :
```
Page (native.js) ──updateState──▶ NexaMediaPlugin ──▶ MediaPlaybackService (service de premier plan « mediaPlayback »)
      ▲                                                  │ MediaSession + notification MediaStyle (écran verrouillé)
      └────────── événement « mediaAction » ◀────────────┘ focus audio, casque débranché, boutons
```
- `MediaPlaybackService.java` : notification, MediaSession, focus audio (appel = pause puis reprise auto ; notification sonore = volume réduit ; autre lecteur = pause), casque débranché = pause.
- `NexaMediaPlugin.java` : permissions, état de lecture, scan MediaStore.
- `MainActivity.java` : enregistre le plugin, empêche la WebView de se mettre en pause écran éteint.
- `patch-manifest.py` : ajoute au manifeste INTERNET, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK, POST_NOTIFICATIONS, READ_MEDIA_AUDIO, READ_EXTERNAL_STORAGE (≤ Android 12), WAKE_LOCK + la déclaration du service. (MANAGE_EXTERNAL_STORAGE n'est volontairement pas utilisé : inutile ici et refusé par Google Play.)
- `native.js` : pont côté page + écran Profil → « Autorisations et arrière-plan ». Dans un navigateur, il ne fait rien.
- Le workflow `.github/workflows/build-apk.yml` copie ces fichiers dans le projet Android avant la compilation.

## iOS (non compilable sans Mac)
Dans `Info.plist` : `UIBackgroundModes` = `audio` ; `NSAppleMusicUsageDescription` si accès à la médiathèque. Lecture + écran verrouillé passent alors par la MediaSession web de la page.

## Palettes sobres (noir, blanc, bleus) et pochettes en ligne
- 8 palettes ajoutées dans `themes.css` / `themes.js` : Cyberpunk Mât, Deep Ice, Dark Navy Executive, Midnight Aurora, Monochrome & Cyan Soft, Stealth Tech, Frosty Slate (clair), Polar Light (clair). Le sélecteur les range sous « Noir, blanc & bleus » ; NEXA Nuit et Northern Lights (violet / menthe) sont sous « Colorés ».
- `covers.js` : recherche FACULTATIVE des pochettes manquantes (Profil → Pochettes en ligne). Désactivée par défaut. Source : iTunes Search API ; seuls artiste + album/titre sont envoyés ; une requête par album, une toutes les 3,2 s ; la pochette n'est acceptée que si l'artiste correspond ; l'image est ensuite enregistrée dans l'application (hors ligne). Jamais appliquée à un titre qui a déjà une pochette.
