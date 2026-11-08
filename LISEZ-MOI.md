# NEXA Music

Application de musique hors ligne (PWA) : noir profond, bleu électrique, violet néon, verre dépoli.

## Architecture (un fichier = une responsabilité)
- `app.js`   : noyau — base locale (IndexedDB), import, lecteur, file d'attente, routeur, Media Session (écran verrouillé / notifications)
- `meta.js`  : lecture des métadonnées (ID3, titre, artiste, album, genre, année, pochette)
- `intel.js` : intelligence locale sans IA externe — classement par genre, habitudes d'écoute, recommandations, titres similaires, mixes automatiques
- `eq.js`    : égaliseur 5 bandes + préréglages (Web Audio, créé seulement à l'activation → aucune batterie perdue sinon)
- `pages.js` : pages Accueil, Explorer, Profil, Genres, Mixes, Historique
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
