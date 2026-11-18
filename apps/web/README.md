# Web app (local)

Application React + TypeScript + Vite qui exécute le cœur Rust en WebAssembly.
Elle présente un éditeur inspiré de POD Go Edit : listes Factory/User, chaîne
de signal, inspecteur de paramètres, et lecture du **preset actif** ou d'une
setlist depuis un POD Go branché en **WebUSB**.

- **Utilisable sans pédalier** : au chargement, la page remplit les noms
  Factory depuis la capture `factory_setlist_fw250.bin` et crée un preset User
  neutre `New Preset` en `01A`. Un bandeau `No POD Go connected` l'indique. On
  peut éditer ce preset, en créer d'autres, les déplacer et les exporter en
  `.pgp` ; **Save** affiche alors une erreur explicite qui renvoie vers
  l'export, puisque le corps JSON n'est pas le `l6-helix` du pédalier.
- **Édition en brouillon** : les paramètres continus s'éditent directement,
  en faisant glisser la barre sous le nom ou en cliquant sur la valeur à son
  extrémité droite. Les brouillons hors ligne sont conservés par emplacement :
  changer de preset ne les perd plus, et revenir dessus réaffiche les valeurs
  avec le badge `unsaved changes` jusqu'à l'export. Seuls les brouillons en
  RAM du pédalier demandent confirmation avant d'être abandonnés. Les valeurs
  ne partent vers le pédalier qu'avec **Save** ou **Ctrl+S**, après une seule
  confirmation (op 30, RAM seulement).
- **Changement de modèle et ordre de la chaîne** : sur un preset hors ligne,
  l'onglet **Models** charge le modèle cliqué dans le bloc sélectionné (ou dans
  un emplacement vide) avec les valeurs par défaut du catalogue, puis exporte
  le tout dans le `.pgp`. Amp, Cab, Vol, Wah, Send/Return et Looper sont des
  blocs uniques : un emplacement vide peut donc devenir un Wah, une pédale de
  volume, une boucle d'effets ou le Looper, mais un seul de chaque. Les modèles
  incompatibles sont grisés et l'onglet est désactivé pour Input/Output. Les
  blocs se réordonnent par glisser-déposer dans la chaîne (le déplacement
  emporte l'affectation footswitch et les snapshots). Sur un preset lu du
  pédalier, le premier changement de modèle propose de créer une **copie hors
  ligne éditable** (bouton **Edit copy**) : elle se modifie et s'exporte en
  `.pgp`, mais l'écriture d'un modèle par le corps de chaîne (op 40) n'est pas
  implémentée, donc elle ne repart pas vers le pédalier.
- **Repères visuels** : le nom d'un preset qui n'existe que dans le navigateur
  (copie hors ligne ou brouillon non exporté) est en italique, dans le titre et
  dans la liste, pour montrer qu'il n'est pas encore sur le pédalier.
- **Snapshots** : un clic sur une puce choisit le snapshot actif enregistré
  avec le preset (`@current_snapshot`) et un double-clic sur son nom ouvre un
  champ de saisie (Entrée valide, Échap ou perte de focus annule). Un clic
  droit sur une puce ouvre le même menu d'actions : renommer, activer,
  effacer le nom personnalisé et choisir la couleur de LED. Le nom est limité
  aux 10 caractères ASCII imprimables documentés par le manuel du POD Go ; un
  nom vide revient à `SNAPSHOT n`. La caméra à gauche d'un paramètre
  l'assigne au contrôleur Snapshots (`@controller: 10`, **ITM** pour POD Go) :
  chaque snapshot garde alors sa propre valeur, et un paramètre déjà piloté par
  une pédale d'expression ne peut pas être converti (la caméra est désactivée).
  La pastille Active/Bypass de l'en-tête change l'état du bloc dans le snapshot
  chargé. Une palette sur la ligne des snapshots règle `@ledcolor` (Auto,
  White, Red, Dark Orange, Light Orange, Yellow, Green, Turquoise, Blue,
  Violet, Pink, Off). Comme le reste du brouillon, ces changements restent
  dans le navigateur et partent avec **Save** (pédalier) ou **Export .pgp**.
- **Menus et glisser-déposer** : un clic droit sur un preset ouvre
  ouvrir/créer, **Save to Pedal**, renommer, copier, coller, déplacer, exporter
  `.pgp` et importer. **Save to Pedal** est grisé sans pédalier ou sans
  *Enable writing*. Les presets User se réorganisent par glisser-déposer dans
  la liste locale.
- **Outils de développement repliés** : lectures Factory/User, lecture du
  preset actif, sauvegarde complète ou partielle/restauration `.pgbak`, actions
  avancées (op 5/71), téléchargement `.bin`, journal de diagnostic et rapports
  bruts vivent sous **Developer tools**.
- **Lecture toujours disponible** ; **écriture opt-in** : la case **Enable
  writing**, affichée uniquement quand le pédalier est connecté, est le seul
  garde-fou. **Save**, **Ctrl+S** et **Save to Pedal** restent inactifs sans
  elle ; **Export .pgp** n'en a jamais besoin. Le canal `0x1080 → 0x03ED` sert à
  `set_param` (op 30, preset actif) et à `save_preset` (op 71, métadonnées
  seulement, slot User, sauvegarde préalable du slot destination). Une
  sauvegarde `.pgbak` peut couvrir les deux setlists, un seul setlist ou une
  sélection de slots. Une restauration destructive a **un seul garde-fou** : le
  fichier est vérifié en Rust, les entrées à restaurer sont cochées, le diff des
  destinations est affiché, puis un clic sur **Restore N preset(s)** et une
  confirmation `window.confirm`. Voir
  [docs/protocol/writes.md](../../docs/protocol/writes.md).
- **Import POD Go Edit et export `.pgp`/`.pgb` hors ligne** : **Import…** ouvre
  un export de preset `.pgp` ou une sauvegarde complète `.pgb` (conteneur `AF6L`
  avec membres zlib et répertoire `IDGP`), liste les setlists Factory/User et
  affiche la chaîne, les paramètres, les snapshots et les affectations de
  footswitch. Le fichier est lu dans l'onglet, jamais envoyé ni enregistré. Un
  preset importé devient une **copie hors ligne** : il peut être renommé,
  édité, puis téléchargé avec **Export .pgp** ; l'export conserve tous les
  champs du document, y compris ceux que ce build ne comprend pas. **Export
  .pgb** reconstruit la sauvegarde d'origine avec ce preset dans son slot :
  les membres non modifiés (réponses d'impulsion, `UMDS`, …) gardent leurs
  octets exacts et seule la setlist éditée est recompressée.
- **Hors ligne** : aucune requête sortante après l'installation. Les fichiers
  restent dans le navigateur.
- **Pas encore l'application finale** : pas de stockage persistant, pas
  d'export `.hlx`.
- **Validation matérielle** : le flux WebUSB est couvert par un appareil
  simulé (`ITM`) et par une lecture User réelle sur un **POD Go Wireless**,
  firmware **2.50 (build `6e984472`)** — `ITH` pour la lecture Web Chromium
  (Factory et User) et pour l'écriture `set_param` (amp Drive réglé à `9.0`,
  appliqué et relu sur le pédalier le 2026-11-13). La sauvegarde (op 71) et la
  restauration complète restent **`ITM`** : non validées sur matériel.

Adresse locale : **[http://127.0.0.1:5173](http://127.0.0.1:5173)**

## Prérequis

- Rust ≥ 1.80.
- La cible WASM :

  ```sh
  rustup target add wasm32-unknown-unknown
  ```

- `wasm-bindgen` **0.2.130**, la même version que la dépendance du crate :

  ```sh
  cargo install wasm-bindgen-cli --version 0.2.130
  ```

  Une archive précompilée est aussi disponible dans les releases
  `wasm-bindgen` (plus rapide que la compilation).

- Node.js ≥ 20.19 (testé avec Node 24).
- Pour l'USB : Chrome ou Edge récent. WebUSB exige un contexte sécurisé
  (`http://127.0.0.1`, `http://localhost` ou HTTPS) et un clic utilisateur.

## Installation et lancement

```sh
cd apps/web
npm install
npm run dev
```

`npm run dev` compile d'abord le crate `apps/web/wasm`, génère les bindings
dans `src/wasm/`, copie les fixtures dans `public/fixtures/`, puis démarre Vite
sur `127.0.0.1:5173`.

Ouvre ensuite <http://127.0.0.1:5173>. Sans pédalier, la barre latérale montre
les 128 noms Factory et le preset User `New Preset` ; l'éditeur affiche son
ampli et son baffle, prêts à être modifiés et exportés.

Pour rejouer les fixtures brutes (`user_setlist.bin`, `spec02_obj22_blob.bin`),
ouvre **Developer tools → Offline reports & files** : **Load fixture** et
**Open a file…** y chargent un `.bin`. `spec02_obj22_blob.bin` affiche
`round-trip: byte-identical` dans le rapport.

## Lire une setlist depuis le POD Go (WebUSB)

1. Branche le POD Go, allume-le, et ferme **POD Go Edit** ainsi que les autres
   applications qui pourraient déjà utiliser l'interface vendeur.
2. Ouvre la page dans Chrome ou Edge sur `127.0.0.1:5173`.
3. Clique **Connect**. Le sélecteur WebUSB doit proposer un
   appareil Line 6 (`0e41:4247`, ou `0e41:424b` pour la version Wireless). Le
   badge et l'adresse `OUT 0x01 / IN 0x81` sont dans **Developer tools**.
4. Ouvre **Developer tools**, puis clique **Read User** ou **Read Factory**.
5. Attendu : le rapport replié affiche `setlist:   128 entries`, les slots de 0
   à 127, et le nombre de blocs lus (13 pour le fixture User). La liste des
   presets est remplie dans la barre latérale. Sur matériel réel, la taille et
   le nombre de blocs dépendent des noms de presets.
6. **Download .bin** enregistre la setlist brute reassemblée, utile comme
   preuve de capture.

### Lire le preset actif

Le bouton **Read active preset** lit l'objet 23 (état actif) puis l'objet 22
(le preset en cours d'édition sur le pédalier), chacun avec un handshake neuf.
Le pédalier ignore souvent le premier handshake qui suit un objet : la
séquence est alors rejouée sur place, sans perdre l'état actif déjà lu.

La page affiche alors la chaîne de signal et l'inspecteur de paramètres comme
POD Go Edit : nom d'effet, catégorie colorée, état bypass, affectations
footswitch/`EXP Toe`, et valeurs formatées à partir du catalogue
(`src/catalog/catalog.json`, 571 modèles). Les réglages continus 0..1 suivent
l'échelle **0–10** du pédalier (un `0.76` stocké affiche `7.6`), y compris les
paramètres que POD Go Edit présente en pourcentage. Le rapport `podgo-probe`
reste disponible dans la section repliée, avec `round-trip: byte-identical`.

Les identifiants de modèle et les valeurs brutes viennent du cœur Rust ; la
résolution `id → nom` et le formatage se font en TypeScript, pour que le cœur
reste sans dépendance. Voir
[docs/protocol/model-catalog.md](../../docs/protocol/model-catalog.md).

Si le pédalier ne répond pas à l'objet 23, la lecture bascule sur l'objet 22
seul, avec la même requête d'ouverture que le flux à deux objets
(`{107: 0, 101: 2}`). Le corps est alors affiché avec le libellé
`Active preset` : sans objet 23, le slot et le nom actifs ne sont pas connus.

Le dernier bloc d'un objet peut arriver à taille pleine, suivi de zéros de
bourrage. Le décodeur ne lit que la première valeur MessagePack ; la longueur
de la clé 104 reste autoritaire, donc le blob `l6-helix` est exact.

### Journal de diagnostic

Chaque connexion, phase de handshake, lecture et erreur USB est horodatée dans
le panneau replié **Diagnostics log** sous la carte de connexion. Le bouton
**Copy log** copie tout le journal (jusqu'à 500 lignes) pour le joindre à un
rapport ; les erreurs sont aussi envoyées à la console du navigateur.

### Ouvrir un preset depuis la liste

Une fois une setlist lue, chaque ligne de la barre latérale est un bouton. Un
clic envoie une opération 4 avec `{107: setlist, 108: slot, 101: 2}` et lit le
corps `l6-helix` **de ce slot**, sans changer le preset actif du pédalier. Le
nom vient de l'entrée de setlist, puisque l'objet 23 n'est pas lu.

C'est la même requête que l'éditeur officiel utilise pendant une sauvegarde
(134 lectures dans la capture `podgo-full-backup.pcapng`). Le flux est couvert
par un faux appareil ; il reste à le revalider sur matériel. Sans pédalier, les
lignes User ouvrent leur copie locale et les lignes Factory rappellent que leur
corps n'est pas embarqué.

Flux envoyé :

1. handshake en 5 paquets ;
2. `OPEN_PRESETS` ;
3. ouverture de l'objet 23 puis requêtes de blocs, arrêt sur payload vide ;
4. handshake neuf puis ouverture de l'objet 22
   (`{102: 1002, 100: 22, 101: {107: 0, 101: 2}}`) et requêtes de blocs ;
5. extraction de la clé 104 (blob `l6-helix`) puis vue structurée
   (`structure_json`) et rapport `podgo-domain`.

**Download .bin** enregistre alors le blob `l6-helix` brut.

### Flux envoyé pour une setlist

1. handshake en 5 paquets, avec un timeout court de 300 ms et jusqu'à 5
   tentatives (le POD Go ignore souvent la première) ;
2. `OPEN_PRESETS` ;
3. `OPEN_STREAM` avec l'octet de setlist (0 = Factory, 1 = User) ;
4. requêtes de blocs de 256 octets à partir de `0x1000`, réassemblage par
   offset absolu, arrêt sur payload vide ou après 128 entrées ;
5. rapport produit par `podgo-domain::preset_list`.

Les réponses sont filtrées par le couple source/destination miroir du paquet
de requête, car l'endpoint IN est partagé entre plusieurs canaux logiques. Les
trames d'événements (`0x03F0 → 0x1002`) sont mises en file et ignorées : elles
ne peuvent jamais tenir lieu de réponse, même si elles saturent la file.

### Ce qu'il faut noter pendant le test matériel

- modèle et firmware du POD Go ;
- PID observé dans le sélecteur ;
- résultat exact des lectures Factory et User ;
- résultat de **Read active preset** (chaîne affichée et, dans le rapport,
  `round-trip: byte-identical`) ;
- message d'erreur complet en cas d'échec ;
- éventuel `.bin` téléchargé et son empreinte.

Ces éléments complètent le journal de preuves matérielles
([platform-support-matrix](../../docs/architecture/platform-support-matrix.md#5-hardware-evidence-log)).

## Build de production et prévisualisation

```sh
npm run build
npm run preview
```

La prévisualisation écoute sur <http://127.0.0.1:4173>. Le build est statique
dans `apps/web/dist/` et ne contient que des fichiers locaux.

## Docker

Le dépôt fournit un `Dockerfile` multi-étapes (Rust → WASM → Node → nginx) et
un `docker-compose.yml` à la racine. Aucun accès au pédalier ni backend n'est
nécessaire pour lancer l'interface ; WebUSB reste fourni par le navigateur de
l'hôte.

```sh
docker compose up --build
```

L'interface écoute sur <http://127.0.0.1:8080>. Le conteneur sert des fichiers
statiques uniquement ; le port `80` interne peut être publié ailleurs via
`ports:`.

## GitHub Pages

Le workflow [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml)
construit la page à chaque push sur `main` et la publie avec GitHub Pages.
Dans **Settings → Pages**, choisir **GitHub Actions** comme source. Le build
utilise `VITE_BASE=./` pour rester valide sous `/<dépôt>/`.

## Tests

```sh
# Tests Rust du binding WASM, exécutés sur l'hôte (36 tests)
npm run test:wasm

# Instancie le WASM généré dans Node et vérifie les rapports
npm run test:smoke

# Tests navigateur automatisés (Playwright + Chromium, 16 tests)
npx playwright install chromium
npm run test:browser
```

`test:browser` réutilise le serveur déjà lancé sur `127.0.0.1:5173`, ou en
démarre un. Il vérifie :

- le chargement hors ligne (noms Factory, `New Preset` en `01A`, bandeau
  `No POD Go connected`, absence de requête externe) ;
- l'édition d'un brouillon, l'erreur de **Save** sans pédalier et l'export
  `.pgp` qui conserve la valeur modifiée ;
- le menu contextuel (copier, coller, renommer, déplacer) et le
  glisser-déposer ;
- le rejet d'un preset invalide ;
- une lecture User complète à travers un **faux appareil WebUSB** en page, avec
  le vrai WASM (handshake, `OPEN_PRESETS`, `OPEN_STREAM`, 13 blocs, 128
  entrées) ;
- une lecture du preset actif et le repli sur l'objet 22 seul ;
- l'ouverture d'un slot depuis la barre latérale (opération 4 ciblée) ;
- une sauvegarde par lot `set_param` déclenchée par **Ctrl+S**, une sauvegarde
  `save_preset`, une sauvegarde complète ou limitée (setlist ou slots choisis)
  et une restauration op-5 des seules entrées cochées avec **une seule**
  confirmation ;
- le collage et le renommage sur le pédalier sans sauvegarde préalable ;
- l'import `.pgp`/`.pgb` sans écriture vers le pédalier, l'édition hors ligne
  d'un paramètre et d'un nom, l'export `.pgp` (y compris depuis un `.pgb`) et
  l'export `.pgb` qui laisse les membres non modifiés identiques octet pour
  octet ;
- le message hors ligne quand WebUSB est absent.

Le faux appareil ne remplace pas une validation matérielle : il prouve le
câblage et le protocole, pas le comportement du firmware.

## Structure

```text
apps/web/
  wasm/            crate cdylib (wasm-bindgen), hors workspace racine
  src/             React + TypeScript
  src/usb/         transport WebUSB et orchestration de lecture
  src/wasm/        bindings générés, ignorés par git
  scripts/         copie des fixtures, smoke test WASM
  public/fixtures/ généré, ignoré par git
  tests/           tests Playwright
```

Le crate `apps/web/wasm` est volontairement **hors du workspace racine** : les
crates du cœur restent sans dépendance externe et `cargo test --workspace
--offline` continue de fonctionner sans `wasm-bindgen`.

L'automate `ReadFlow` vit dans le crate WASM : il construit les paquets et
interprète les réponses avec `podgo-protocol`. Le TypeScript ne fait que
transporter les octets ; il ne réimplémente ni les offsets ni le MessagePack.

## Limitations

- Lecture seule sur le pédalier : pas d'écriture de chaîne ni de
  remplacement de modèle sur l'appareil. Un modèle changé devient un
  brouillon local exportable en `.pgp`.
- Import `.pgp`/`.pgb` et export `.pgp`/`.pgb` hors ligne uniquement ; pas
  d'export `.hlx`, et un preset importé ne peut pas être envoyé au pédalier.
- Pas de stockage persistant (IndexedDB).
- Firefox et Safari n'ont pas WebUSB ; ils restent en mode hors ligne.
- Windows : WebUSB dépend du pilote WinUSB. Si Chrome refuse l'accès, c'est
  souvent que l'interface vendeur est réservée par un pilote ou une autre
  application. **Ne remplace pas le pilote Line 6 sans sauvegarde** ; note le
  message exact et la version de Chrome.
- Lectures Factory et User validées sur un POD Go Wireless (fw 2.50) ;
  l'écriture de paramètres (op 30) est validée sur matériel, la sauvegarde
  (op 71) et la restauration restent à valider. Le flux actuel à deux objets
  (23 puis 22) n'est couvert que par le faux appareil.
- 743 des 4978 paramètres ont des libellés officiels ; les autres s'affichent
  en valeur numérique.

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `wasm-bindgen: command not found` | CLI absente du `PATH` | `cargo install wasm-bindgen-cli --version 0.2.130` |
| `can't find crate for core` / cible inconnue | cible WASM absente | `rustup target add wasm32-unknown-unknown` |
| `Port 5173 is already in use` | un autre serveur tourne | arrêter l'autre processus ou changer `server.port` |
| badge rouge « WASM indisponible » | bindings non générés | `npm run wasm` puis recharger |
| version `wasm-bindgen` incompatible | CLI ≠ crate | aligner sur `0.2.130` |
| « WebUSB indisponible » | Firefox/Safari, ou page non sécurisée | Chrome/Edge sur `127.0.0.1` ou HTTPS |
| Le sélecteur ne montre pas le POD Go | appareil éteint, PID inattendu, câble | vérifier l'alimentation et le câble ; mode bootloader = autre PID |
| `Access denied` / `NetworkError` à la connexion | interface déjà réservée | fermer POD Go Edit et les autres clients USB ; redémarrer Chrome |
| `aucune réponse sur le canal attendu après 300 ms` répété | appareil occupé ou flux désynchronisé | débrancher/rebrancher, fermer les autres applications, relancer la page |
| `interface vendeur introuvable` | descripteurs inattendus / mauvais mode | vérifier le PID ; ne pas insister en mode bootloader |
| `setlist: 0 entries` | flux vide ou firmware différent | télécharger le `.bin` et le conserver comme preuve |
