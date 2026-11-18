# Tests manuels — TODO

> **But :** checklist actionnable pour valider le projet sur ta machine.
> **État actuel :** cœur Rust read-only, CLI hors ligne, tests automatiques et
> application web locale (`apps/web`, `127.0.0.1:5173`). Il n'y a **pas encore** de
> transport USB Rust ni d'application desktop. Les sections marquées `P2`/`P3`
> sont donc des préparatifs, pas des tests exécutables aujourd'hui.

Légende :

| Priorité | Sens |
|---|---|
| `P0` | Exécutable maintenant, sans matériel. |
| `P1` | Nécessite le POD Go, mais seulement pour **capturer** du trafic. |
| `P2` | Bloqué jusqu'à l'implémentation du transport USB. |
| `P3` | Bloqué jusqu'à l'interface web/desktop (Phase 4/5). |

Coche `[x]` au fur et à mesure et note la date + le résultat dans le
[journal](#6-journal-de-validation).

---

## 1. Tests locaux (`P0`)

### 1.1 Prérequis

- [ ] Rust ≥ 1.80 (`rustup show`, `rustc --version`).
- [ ] Le dépôt est cloné et `Cargo.lock` est présent.
- [ ] Aucun câble USB nécessaire.

> Les crates du cœur n'ont **aucune dépendance externe** : tout doit
> fonctionner avec `--offline`.

### 1.2 Formatage, lint, tests

Depuis la racine du dépôt :

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Attendu :

- [ ] `fmt` ne produit aucune sortie (code déjà formaté).
- [ ] `clippy` termine sans warning.
- [ ] `cargo test` : tous les tests passent. Au moment de la rédaction :
      **80 tests** hors WASM, dont 4 tests de robustesse (génération aléatoire,
      troncatures, mutations d'octets) et les tests du conteneur `.pgbak`.
      Ajouter `--features device-write` pour les encodeurs d'écriture, et
      `cargo test` dans `apps/web/wasm` pour les flows (36 tests).

Vérifie aussi le mode hors ligne :

```sh
cargo test --workspace --offline
```

- [ ] Le mode `--offline` passe (preuve qu'aucune dépendance réseau n'est
      requise).

### 1.3 Sonde preset (`podgo-probe`)

```sh
cargo run -p podgo-cli -- fixtures/spec02_obj22_blob.bin
echo "exit=$?"
```

Attendu :

- [ ] `container: l6-helix`
- [ ] `product:   P34`
- [ ] `firmware:  v2.00-5-g665e64e`
- [ ] `chain:     12 entries` (input + 9 blocs + slot vide + output)
- [ ] `round-trip: byte-identical (3823 -> 3823 bytes)`
- [ ] `exit=0`

### 1.4 Sonde setlist

```sh
cargo run -p podgo-cli -- --setlist fixtures/user_setlist.bin
echo "exit=$?"
```

Attendu :

- [ ] `setlist:   128 entries (3332 B)`
- [ ] premières lignes : `slot   0  id 128  Preset 000`,
      `slot   1  id 130  Preset 001`
- [ ] `slot 127` présent
- [ ] `exit=0`

> `id` est l'identifiant stable encodé ; `slot` est la position dans le flux
> (numéro de program change). Ils peuvent différer après réordonnancement.

### 1.5 Cas d'erreur de la CLI

Fichier invalide :

```sh
printf 'not a preset' > /tmp/opg-bad.bin
cargo run -p podgo-cli -- /tmp/opg-bad.bin
echo "exit=$?"
```

- [ ] Message `error: invalid container: ...`
- [ ] `exit=1`

Arguments invalides :

```sh
cargo run -p podgo-cli -- 2>/dev/null
echo "exit=$?"
cargo run -p podgo-cli -- a b 2>/dev/null
echo "exit=$?"
```

- [ ] Les deux commandes affichent l'usage et retournent `exit=2`.

Setlist invalide :

```sh
printf 'no entries' > /tmp/opg-bad-setlist.bin
cargo run -p podgo-cli -- --setlist /tmp/opg-bad-setlist.bin
echo "exit=$?"
```

- [ ] `error: invalid container: no preset entries found in the stream`
- [ ] `exit=1`

### 1.6 Compilation WASM du cœur (optionnel mais utile)

Il n'y a pas encore de binding `wasm-bindgen` ni d'interface. Cette étape prouve
seulement que le cœur compile pour le navigateur.

```sh
rustup target add wasm32-unknown-unknown
cargo check -p podgo-domain -p podgo-protocol -p podgo-transport -p podgo-session \
  --target wasm32-unknown-unknown
```

- [ ] `cargo check` passe.
- [ ] Noter la version de Rust utilisée.

> Ne lance pas `cargo build --workspace --target wasm32-unknown-unknown` :
> `apps/podgo-cli` utilise le système de fichiers et n'est pas destiné au
> navigateur.

### 1.7 Test sous Docker (optionnel)

Docker n'est pas installé dans l'environnement de développement actuel. Sur ta
machine, après installation de Docker :

```sh
docker run --rm \
  -e CARGO_TARGET_DIR=/tmp/target \
  -v "$PWD":/work -w /work \
  rust:1.80-bookworm \
  cargo test --workspace --offline
```

- [ ] L'image se télécharge.
- [ ] Les tests passent avec la version minimale supportée (1.80).
- [ ] Le dossier `target/` de l'hôte n'est pas modifié
      (`CARGO_TARGET_DIR=/tmp/target`).

Pour inclure `fmt` et `clippy` (nécessite le réseau dans le conteneur) :

```sh
docker run --rm \
  -e CARGO_TARGET_DIR=/tmp/target \
  -v "$PWD":/work -w /work \
  rust:1.80-bookworm \
  sh -c 'rustup component add rustfmt clippy \
    && cargo fmt --all -- --check \
    && cargo clippy --workspace --all-targets -- -D warnings \
    && cargo test --workspace --offline'
```

- [ ] Les trois étapes passent.

> Ces commandes utilisent l'image officielle `rust:1.80-bookworm` pour les
> tests du cœur. Le dépôt fournit aussi un `Dockerfile` et un
> `docker-compose.yml` pour servir l'interface web :
>
> ```sh
> docker compose up --build   # http://127.0.0.1:8080
> ```
>
> Le workflow `.github/workflows/pages.yml` publie le même build sur GitHub
> Pages.

---

## 2. Tests navigateur (`P0` pour l’application web, `ITH` lecture WebUSB)

**Statut :** une application web locale existe dans `apps/web/` (React + Vite
+ WASM). Elle lit les setlists et le preset actif en WebUSB, et propose les
écritures **derrière armement** : `set_param` (op 30, validé matériellement),
`save_preset` (op 71), `set_model` (op 40, **non validé matériellement**), et
sauvegarde/restauration complète (`.pgbak` + op 5,
**non validée matériellement**).
Le flux WebUSB est couvert par un faux appareil dans Playwright (`ITM`) et a
été validé sur un POD Go Wireless en firmware 2.50 (`ITH` pour la lecture User
et pour `set_param`).

### 2.1 Prérequis

- [x] `rustup target add wasm32-unknown-unknown`
- [x] `cargo install wasm-bindgen-cli --version 0.2.130`
- [x] Node.js ≥ 20.19 (`node --version`)
- [ ] Chrome ou Edge pour WebUSB (Firefox/Safari resteront hors ligne).

### 2.2 Lancer l’application web

```sh
cd apps/web
npm install
npm run dev
```

Puis ouvrir **<http://127.0.0.1:5173>**.

Attendu :

- [ ] Le badge affiche **WASM ready · v0.1.0**.
- [ ] La section repliée **Offline reports & files** montre, pour le preset,
      `product: P34`, `chain: 12 entries` et
      `round-trip: byte-identical (3823 -> 3823 bytes)`.
- [ ] La même section montre, pour la setlist,
      `setlist: 128 entries (3332 B)` et `slot 127`.
- [ ] La barre latérale liste les 128 presets avec les étiquettes `01A`…`32D`.
- [ ] Le bouton **Open a file…** accepte un `.bin` local et l'éditeur affiche
      la chaîne avec les noms d'effets et les valeurs formatées.
- [ ] Les réglages continus 0..1 sont affichés sur l'échelle **0–10** du
      pédalier, pas 0–100 : un `Drive` stocké à `0.76` affiche `7.6`, et les
      bornes du curseur affichent `0` et `10`.
- [ ] Un fichier invalide affiche une erreur, pas un crash.
- [ ] L'onglet **Network** ne contient que des requêtes vers `127.0.0.1:5173`.
- [ ] La liste **Model Select** affiche les catégories et permet de rechercher
      un modèle (lecture seule : cliquer ne modifie rien).

### 2.3 Tests automatisés de l’application

```sh
cd apps/web
npm run test:wasm    # binding Rust testé sur l'hôte (36 tests)
npm run test:smoke   # WASM instancié dans Node
npx playwright install chromium
npm run test:browser # navigateur headless, 14 tests
```

- [ ] Les trois commandes passent.
- [ ] `test:browser` affiche `14 passed`.

`test:browser` couvre une lecture User complète, une lecture du preset actif
(objets 23 puis 22), une écriture `set_param`, une sauvegarde `save_preset`, une
sauvegarde/restauration complète avec un faux appareil WebUSB (handshake,
`OPEN_PRESETS`, `OPEN_STREAM`, 13 blocs, 128 entrées, fenêtre de flux op-5), les
actions de bibliothèque locales (copie, collage, déplacement, renommage,
marqueurs de modifications en attente), l'import `.pgp`/`.pgb` construit à
partir de fichiers synthétiques aux noms inventés (aucun backup personnel),
et l'édition hors ligne (nom, paramètre) suivie d'un export `.pgp` rouvert et
relu.
Ces tests prouvent le câblage, pas le firmware.

### 2.4 Build de production

```sh
cd apps/web
npm run build
npm run preview
```

- [ ] Le build passe sans erreur TypeScript.
- [ ] <http://127.0.0.1:4173> affiche les mêmes rapports.
- [ ] `dist/` ne contient aucun appel réseau externe.

### 2.5 Lecture WebUSB sur matériel (`ITH` Factory + User)

**Session du 2026-11-11 :** POD Go **Wireless**, firmware **2.50 (build
`6e984472`)**, PID `0e41:424b`, interface vendeur 0, bulk OUT `0x01` / IN
`0x81`, page servie sur `http://127.0.0.1:5173`. Les lectures **Factory** et
**User** ont réussi : 128 entrées chacune, noms réels affichés. Aucune écriture.
Détails et empreintes :
[platform-support-matrix](../architecture/platform-support-matrix.md#5-hardware-evidence-log).

Prérequis :

- [x] POD Go allumé, câble USB **data**.
- [x] POD Go Edit et tout autre client USB fermés.
- [x] Chrome ou Edge à jour : Brave **1.99.56** (moteur Chromium), client
      Windows, serveur Vite sous Linux.
- [x] Page servie sur `http://127.0.0.1:5173` (contexte sécurisé).

Étapes :

- [x] Le bouton **Connect POD Go** ouvre le sélecteur WebUSB et montre
      `POD Go` (`0e41:4247`, ou `0e41:424b` pour la version Wireless).
- [ ] Le refus du sélecteur (`NotFoundError`) revient à l'état « Aucun
      appareil » sans crash.
- [x] Le badge appareil affiche le nom et le PID après connexion
      (`POD Go — 0x0e41:0x424b`).
- [x] **Read User** affiche les presets de l'utilisateur (noms réels observés).
- [x] **Read Factory** affiche aussi 128 entrées (noms d'usine observés).
- [x] **Download .bin** produit un fichier non vide :
      Factory 3668 B, User 3416 B.
- [x] Plusieurs lectures sur la même connexion fonctionnent (le handshake est
      refait à chaque lecture).
- [ ] **Déconnecter** puis **Connecter** fonctionne sans recharger la page.
- [ ] Firefox/Safari affichent clairement le mode hors ligne et désactivent le
      bouton de connexion.

Preuves à consigner :

- [x] Modèle et firmware (**POD Go Wireless**, **2.50 / `6e984472`**).
- [x] PID observé (`0x424b`).
- [x] OS et navigateur : serveur Linux, client Windows, Brave 1.99.56.
- [x] Rapport texte des lectures Factory et User (128 entrées chacune).
- [x] Fichiers `.bin` téléchargés :
      Factory `1caa7b705647d9b8b275389e19d9bbaeb2082396423461bc3a387a90886acb96`,
      User `b8fe30b00405f903f2625f3ec2e26a446efca5e1ca2051719d80c57ebba20e74`.
- [ ] Message d'erreur complet en cas d'échec.

> WebUSB exige un contexte sécurisé : `https://`, `http://localhost` ou
> `http://127.0.0.1`. L'accès à l'appareil doit être déclenché par un geste
> utilisateur.
>
> Sur Windows, WebUSB dépend de WinUSB. Si Chrome renvoie `Access denied`,
> l'interface vendeur est probablement réservée par le pilote Line 6 ou un
> autre logiciel. Ne remplace pas le pilote sans sauvegarde : note le message
> exact et la version de Chrome avant toute manipulation.

---

## 3. Tests matériel POD Go

### 3.1 Prérequis

- [X] POD Go avec firmware à jour.
- [X] Câble USB **data** (pas charge seule).
- [X] Éditeur officiel POD Go Edit **fermé** pendant les tests.
- [X] Sauvegarde `.pgb` complète faite avec l'éditeur officiel (par prudence).
- [X] Noter : modèle exact, version de firmware, OS, PID observé.

> **Important :** le projet n'a pas encore de transport USB Rust natif
> (`libusb`). Le banc web dispose maintenant d'un transport WebUSB lecture
> seule, validé avec un faux appareil (`ITM`) puis sur un POD Go Wireless
> (firmware 2.50) pour la lecture User (`ITH`). Aujourd'hui, le matériel sert à
> **capturer** le trafic de l'éditeur officiel, à vérifier l'énumération USB et
> à valider la lecture WebUSB. Les tests de lecture native par notre code
> restent `P2`.

### 3.2 Détection Linux (`P1`)

```sh
lsusb -d 0e41:4247
lsusb -d 0e41:424b
```

- [ ] Le POD Go apparaît en `0e41:4247` (ou `0e41:424b` pour la version
      Wireless).
- [ ] Le périphérique disparaît quand on débranche.

Installer la règle udev fournie :

```sh
sudo cp 99-podgo.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

- [ ] Débrancher/rebrancher.
- [ ] `ls -l /dev/bus/usb/<bus>/<dev>` montre le groupe `plugdev`.
- [ ] L'utilisateur est membre de `plugdev` (`groups`).

### 3.3 Capture USB (`P1`)

#### Linux (`usbmon` + Wireshark/tshark)

```sh
sudo modprobe usbmon
sudo ls /sys/kernel/debug/usb/usbmon/
```

Repérer le bus du POD Go (`lsusb`), puis :

```sh
sudo tshark -i usbmon1 -w podgo-connect.pcapng
```

Remplacer `usbmon1` par le bus correct. Si `tshark` n'est pas installé, on peut
utiliser `cat` :

```sh
sudo cat /sys/kernel/debug/usb/usbmon/1u > podgo-connect.txt
```

- [ ] La capture démarre sans erreur.
- [ ] Elle contient l'énumération et les transferts bulk.

#### Windows (`USBPcap` + Wireshark)

1. Installer USBPcap et Wireshark.
2. Démarrer une capture sur le hub racine concerné.
3. Ouvrir POD Go Edit, connecter le pédalier, lire la liste des presets.
4. Arrêter la capture et enregistrer `podgo-connect.pcapng`.

- [ ] La capture contient les paquets d'initialisation.
- [ ] Le fichier est conservé avec la version de firmware dans le nom.

#### macOS

- [ ] Utiliser Wireshark avec l'interface USB si disponible, sinon noter
      « capture non réalisée » et ne pas inventer de résultat.

### 3.4 Capture des événements (`P1`) — session guidée

**Déjà couvert** par `podgo-connect.pcapng` : énumération, handshake lecture,
`OPEN_PRESETS`, `OPEN_STREAM` Factory et User, requêtes de chunks, lecture de
l'objet 22, et le polling du canal événements.

**But :** associer chaque opcode d'événement à une action connue. La capture
précédente (`podgo-connect.pcapng`) n'a couvert que `4`, `8`, `20`, `22`, `39`.
Il manque `21` (chaîne modifiée), `30` (paramètre), `31` (assignation
footswitch), `34` (contrôleur), `42`/`46` (snapshot), `49` (état de bypass).

**Préparation (obligatoire) :**

1. Fermer toute autre application qui utilise le POD Go, **sauf POD Go Edit**.
   L'éditeur doit rester **ouvert et connecté** : c'est lui qui interroge le
   canal événements. Sans lui, le pédalier n'envoie aucune notification.
2. Brancher le POD Go, l'allumer, attendre que POD Go Edit affiche le preset
   actif.
3. Lancer la capture Wireshark/USBPcap sur le hub racine du POD Go (même
   méthode que pour `podgo-connect.pcapng`). Vérifier que des paquets arrivent
   (le polling passe environ une fois par seconde).
4. Ne **rien sauvegarder** pendant la session : les actions ci-dessous modifient
   le buffer de travail, pas la mémoire du pédalier. Pas de bouton **Save**.

**Déroulé :** faire les actions **dans cet ordre**, une seule à la fois, avec
**au moins 5 secondes de pause** entre deux. Noter l'heure de la première
action (ou simplement confirmer que l'ordre a été respecté).

| # | Action exacte | Opcode attendu |
|---|---|---|
| # | Action exacte | Opcode attendu |
|---|---|---|
| 1 | Sur le pédalier, changer de preset au pied (footswitch ou molette de preset) | `8` ; `20` éventuel |
| 2 | Dans POD Go Edit, double-cliquer un autre preset dans la liste | `20` puis `8` (à confirmer) |
| 3 | Sur le pédalier, tourner lentement un knob de paramètre (ex. Drive de l'ampli), plusieurs crans | `30` |
| 4 | Sur le pédalier, appuyer sur un footswitch qui active/désactive un bloc | `39` ou `49` |
| 5 | Sur le pédalier, appuyer sur le switch du pédalier d'expression (toe switch), ou basculer un second bloc | l'autre de `39`/`49` |
| 6 | Sur le pédalier, changer de snapshot (mode snapshot au pied) | `42` ou `46` |
| 7 | Sur le pédalier, taper le tempo (bouton Tap) | `22` (contrôle, déjà connu) |
| 8 | Dans POD Go Edit, déplacer/réordonner un bloc dans la chaîne (glisser-déposer) | `21` |
| 9 | Dans POD Go Edit, assigner un footswitch à un bloc (bypass assign) | `31` |
| 10 | Dans POD Go Edit, assigner le pédalier d'expression à un paramètre (contrôleur) | `34` |
| 11 | Dans POD Go Edit, revenir à la disposition d'origine sans sauvegarder | — |
| 12 | Sur le pédalier, appuyer sur le switch du pédalier d'expression (toe switch), ou basculer un second bloc | `40` (modèle changé) |
| 13 | Sur le pédalier, appuyer sur un footswitch qui active/désactive un bloc | `41` (état du footswitch) |

**Si une action est impossible** (par exemple pas de pédalier d'expression),
l'indiquer : mieux vaut un opcode manquant qu'une action approximative.

**Après la capture :**

- Arrêter la capture et enregistrer `podgo-events.pcapng`.
- Noter : firmware, PID, version de POD Go Edit, OS, navigateur non concerné.
- Calculer le SHA-256 et déposer le fichier dans `reverse/exports/`.
- Signaler toute action qui n'a pas produit l'effet attendu à l'écran.

L'analyse extraira les trames du canal événements et produira un tableau
`opcode → action → données`, puis un fixture de régression par opcode.

> Ne pas confondre avec la capture de connexion : ici on veut surtout les
> notifications (`0x03F0 → 0x1002`), donc l'éditeur doit rester en marche
> pendant toute la session.

### 3.5 Lecture du preset actif depuis le Web (`P1`)

Le bouton **Read active preset** de `apps/web` lit en lecture seule l'objet 23
(état actif) puis l'objet 22 (preset en cours sur le pédalier) et affiche la
chaîne dans l'éditeur, plus le rapport `podgo-probe` dans la section repliée.
L'ancienne lecture mono-objet a été validée sur matériel ; le flux actuel à
deux objets est couvert par les tests à faux appareil et reste à revalider.

Si l'objet 23 ne répond pas, le flux bascule automatiquement sur l'objet 22
seul : la chaîne s'affiche, mais le slot et le nom restent inconnus
(`Active preset`). Ce repli doit aussi être confirmé sur matériel.

Le handshake qui suit un objet est rejoué **sur place**. Le journal doit donc
montrer au plus une ligne `Handshake tentative 1/5 échouée` puis la suite de la
lecture, sans relire l'objet 23 ni repasser par cinq tentatives complètes.

- [x] POD Go Edit fermé, page ouverte dans Brave/Chrome sur `127.0.0.1:5173`.
- [x] Brancher le POD Go, puis **Read active preset** (ancien flux mono-objet).
- [x] Le rapport commence par `container: l6-helix` et affiche
      `round-trip: byte-identical`.
- [x] Le nombre d'entrées de chaîne correspond au preset affiché sur le
      pédalier.
- [x] **Download .bin** : conserver le blob et son SHA-256.
- [x] Noter le nom du preset actif (ou simplement confirmer qu'il correspond à
      l'écran) ; ne pas publier de nom personnel sans accord.
- [ ] Revalider le flux actuel (objet 23 puis 22) : nom `01x` et nom de preset
      cohérents avec l'écran du pédalier.
- [ ] Provoquer ou constater l'absence de réponse à l'objet 23, puis vérifier
      que le repli objet 22 affiche `Active preset` sans erreur.

Si la lecture échoue, noter le message exact : les cas attendus sont un
handshake refusé (réessayé 5 fois), un statut non nul (`status N, code M`) ou
un payload vide immédiat. Le panneau **Diagnostics log** conserve la séquence
horodatée ; utiliser **Copy log** pour joindre la trace complète au rapport.

### 3.6 Capture dirigée du catalogue (`P3`) — faite le 2026-11-12

**But :** associer chaque `model_id` et `param_id` à un nom et une unité, afin de
pouvoir afficher la chaîne comme dans POD Go Edit.

**Préparation :**
- Fermer POD Go Edit, garder le pédalier allumé.
- Ouvrir `apps/web` dans Brave sur `127.0.0.1:5173`.
- Brancher le POD Go (WebUSB).

**Déroulé :** faire les actions **dans cet ordre**, une seule à la fois, avec
**au moins 5 secondes de pause** entre deux. Noter l'heure de la première
action (ou simplement confirmer que l'ordre a été respecté).

| # | Action exacte | Ce qu'on note |
|---|---|---|
| 1 | **Sur le pédalier** : passer en preset Factory 0 (US Deluxe Nrm) | Le preset actif affiché doit être `US Deluxe Nrm` |
| 2 | **Dans POD Go Edit** : double-cliquer le preset **US Deluxe Tight** (slot 1) | Le preset actif devient `US Deluxe Tight` |
| 3 | **Sur le pédalier** : tourner lentement le **knob Drive** du premier bloc (Amp) | Noter `model_id` et `param_id` de chaque cran, ainsi que la valeur affichée à l'écran |
| 4 | **Sur le pédalier** : appuyer sur le **footswitch** du premier bloc (bypass) | Noter `model_id` et la valeur affichée |
| 5 | **Dans POD Go Edit** : glisser-déposer le premier bloc **après le second** | Noter les `model_id` des deux blocs et l'ordre final |
| 6 | **Dans POD Go Edit** : assigner le **pédalier d'expression** au paramètre **Drive** du premier bloc | Noter `model_id`, `param_id`, et le contrôleur |
| 7 | **Dans POD Go Edit** : revenir à la disposition d'origine **sans sauvegarder** | — |

**Si une action est impossible** (par exemple pas de pédalier d'expression),
l'indiquer : mieux vaut un catalogue incomplet qu'une action approximative.

**Après la capture :**
- [x] Arrêter la capture et enregistrer `podgo-catalog.pcapng`
      (`reverse/exports/`, 1896 transferts, SHA-256
      `c664ba86d883357f8916bdc21598e0d33b00360f13d35e957a5747556d2193e2`).
- [ ] Refaire une capture dédiée aux **objets 22/23** (voir ci-dessous).
- [x] Signaler les actions qui n'ont pas produit l'effet attendu.

**Résultat observé (USBPcap, POD Go Edit 2.50) :**

La capture contient d'abord deux lectures de setlist (User 3415 B, Factory
3660 B), puis les actions d'édition. Les notifications décodées montrent :

- passage du preset actif de Factory 01A (slot 0) à Factory 01D (slot 3) ;
- op 30 sur le bloc 6 (ampli `HD2_AmpCaliRectifire`) : `param 0` (Drive) passe
  de `0.57` à `0.80` (soit environ 5.7 → 8.0 sur l'échelle 0–10 du pédalier),
  avec un premier petit mouvement `0.30 → 0.32` ;
- op 49 sur le bloc 9 (`HD2_PhaserScriptModPhaseStereo`) : bypass activé puis
  désactivé ;
- op 31 : affectations footswitch (blocs 1/2 → FS8, 3 → FS1, 4 → FS3,
  8 → FS2, 9 → FS4) ;
- op 34 : contrôleurs 1 et 2 (EXP1/EXP2) sur le paramètre 4 des blocs 1 (wah)
  et 2 (volume), puis contrôleur 1 sur le paramètre 0 du bloc 6.

Cette capture **ne contient pas de lecture d'objet 22/23** : elle documente des
`param_id` et des actions, pas les corps de preset. Le catalogue n'en est donc
pas dérivé. Il vient des données factuelles du projet MIT `openpodgo` et a été
validé séparément sur `podgo-full-backup.pcapng` : 125 presets complets,
1199 blocs, tous les `model_id` résolus (206 modèles distincts), avec seulement
trois écarts de nombre de paramètres (looper et deux cab IR) et trois écarts de
catégorie on-wire. Voir `docs/protocol/model-catalog.md`.

**Prochaine étape :** la page web affiche déjà la chaîne avec les noms
d'effets/paramètres et les valeurs formatées. Une capture dédiée aux objets
22/23 permettrait de confirmer les ids de paramètres par cran sur le matériel.

### 3.7 Preuves à consigner

Pour chaque test :

- date et heure ;
- OS et version ;
- firmware et PID ;
- commande exacte ;
- résultat observé (sortie, code de retour) ;
- fichier de capture et son SHA-256 (`sha256sum fichier`) ;
- toute différence avec ce document.

### 3.8 Tests de lecture par notre code (`P2`)

**À faire dans la WebUI** (`apps/web`, `127.0.0.1:5173`, Chrome/Brave), avec le
POD Go allumé et **POD Go Edit fermé** : deux processus ne peuvent pas tenir
l'interface vendor en même temps. POD Go Edit ne sert ici qu'à produire les
captures des §3.4 et §3.6, pas à exécuter ces tests.

Le transport WebUSB est implémenté ; le handshake et les deux setlists sont
couverts par les tests automatisés (faux appareil) et par le test matériel de
§2.5. Les cases restantes attendent une session matérielle :

- [x] Handshake complet, session `Ready` (matériel, §2.5).
- [x] Lire les 128 noms de la setlist Factory et les comparer à l'écran.
- [x] Lire les 128 noms de la setlist User et comparer.
- [x] Lire le preset actif, le parser, le réencoder localement et comparer les
      octets (procédure §3.5, validée sur matériel).
- [ ] Revalider sur matériel le flux actuel à deux objets (23 puis 22) ; il
      n'est couvert que par le faux appareil.
- [ ] Vérifier le repli objet 22 quand l'objet 23 reste silencieux : la chaîne
      doit s'afficher sous le libellé `Active preset`, sans erreur.
- [ ] Ouvrir un slot Factory et un slot User depuis la barre latérale, puis
      comparer la chaîne à l'écran du pédalier (opération 4 ciblée). Le clic ne
      doit plus échouer sur « MessagePack string is not valid UTF-8 ».
- [ ] Tourner un bouton et vérifier que les événements sont décodés —
      **non exécutable aujourd'hui** : la WebUI ne sonde pas le canal
      événements. À faire via une capture (§3.4), ou après ajout du flux
      d'événements à l'application.
- [ ] Débrancher pendant une lecture : erreur propre, pas de panique, reconnexion
      possible.

### 3.9 Sécurité

- [ ] **Aucune écriture** sur l'appareil pendant cette phase, sauf la section
      3.10 ci-dessous.
- [ ] Pas de mise à jour de firmware via ce projet.
- [ ] Ne pas lancer deux clients qui possèdent l'interface vendor en même temps.
- [ ] En cas de doute, débrancher et reconnecter ; ne pas insister.

### 3.10 Écriture d'un paramètre (`set_param`, op 30)

Préparer un preset **dédié** (User, copie d'un preset dont on accepte de perdre
la modification), le rappeler sur le pédalier, puis :

- [X] Connecter, **Read active preset**, puis cliquer **Download .bin** et
      archiver le fichier (copie octet-exacte avant écriture).
- [X] Vérifier que *Enable device writes* est désactivé tant que le preset
      actif n'a pas été lu, et qu'il se décoche après une lecture de slot.
- [X] Cocher *Enable device writes* ; le badge passe à `writes armed`.
- [X] Sélectionner un effet (ex. Tube Drive), saisir une valeur (ex. `5`),
      cliquer **Set**, refuser la confirmation : rien ne doit partir.
- [X] Refaire l'opération et accepter : le journal doit afficher `Write
      accepted … frame …` et l'écran du pédalier doit montrer la nouvelle
      valeur.
- [X] Vérifier la valeur sur le pédalier (molette), puis **Read active preset**
      et comparer : la nouvelle valeur doit revenir du pédalier.
- [X] Changer de preset puis revenir : la valeur d'origine doit réapparaître
      (rien n'a été sauvegardé).
- [X] Archiver le journal (**Copy log**) et la trame hexadécimale envoyée.

**Résultat du 2026-11-13** — POD Go Wireless `0x424b`, fw 2.50 : US Double Nrm
Drive `2.5 → 9.0` appliqué, relu `9.0` sur le pédalier et dans *Read active
preset*. Le premier handshake d'écriture après une lecture a été ignoré ; le
pilote rejoue maintenant les quatre paquets sur place. `ITH` pour `set_param`
sur Web Chromium.

Reste ouvert après cette phase : la validation matérielle de la sauvegarde
(op 71) sur un slot User dédié (§3.11), puis la restauration de backup.

### 3.11 Sauvegarde d'un preset (`save_preset`, op 71)

Utiliser un **slot User dédié** dont on a noté le contenu, et garder le
pédalier connecté. La sauvegarde écrit les métadonnées du preset actif
(contenu, nom) dans ce slot ; elle n'envoie pas le corps du preset.

- [ ] Connecter, **Read active preset**, armer les écritures, puis vérifier
      que **Save to slot…** est actif.
- [ ] Cliquer **Save to slot…**, choisir le slot User dédié et un nom de 1 à
      16 caractères ASCII.
- [ ] Cliquer **Read destination slot** : le journal doit afficher la taille,
      la SHA-256 et le téléchargement de
      `podgo-user-<slot>-backup.bin`. Vérifier que **Save to pedal** reste
      désactivé sans la case d'acquittement.
- [ ] Cocher l'acquittement, cliquer **Save to pedal** : le journal doit
      afficher `Save accepted … frame …`, puis `Save verified: User … now
      reads "<nom>"`.
- [ ] Rappeler le slot sur le pédalier : le preset doit porter le nouveau nom
      et le son actif.
- [ ] Refaire un **Read User** et vérifier la liste ; archiver le journal et
      la trame hexadécimale.
- [ ] En cas d'échec de la vérification, **ne pas** réessayer en boucle :
      archiver le journal, relire le slot et restaurer la sauvegarde
      téléchargée avant toute autre écriture.

**Résultat :** à compléter (date, firmware, slot, nom, SHA-256, trame).

### 3.11bis Changement de modèle (`set_model`, op 40) — **non validée matériellement**

> Aucune trame op 40 de ce build n'a encore été envoyée. Le format vient de la
> référence MIT (`change-pedal-from-app.pcapng`, paquet 35) : le pédalier
> devrait charger le modèle avec ses valeurs par défaut. Commencer par un slot
> User dédié, sur un preset dont on a une sauvegarde.

- [ ] Connecter, **Read active preset**, armer les écritures, ouvrir l'onglet
      **Models** sur un bloc existant (ex. l'ampli) et choisir un autre modèle
      du même rôle : le bloc doit afficher le nouveau modèle et le badge
      `unsaved changes`, sans dialogue ni copie hors ligne.
- [ ] Cliquer **Save** : le journal doit afficher
      `Save: 1 model(s) and 0 parameter(s) applied in RAM`, puis
      `stored` et la vérification du nom.
- [ ] Vérifier sur le pédalier (et via **Read active preset**) que le bloc
      porte le nouveau modèle et des valeurs par défaut ; puis rappeler un
      autre preset et revenir pour confirmer que le changement est stocké.
- [ ] Refaire le test dans un **emplacement vide** : si le pédalier refuse
      l'op 40, le journal doit afficher le statut et le brouillon rester en
      attente. Archiver le journal et la trame hexadécimale dans les deux cas.
- [ ] Ne pas réessayer en boucle après un refus : relire le preset et restaurer
      la sauvegarde si le son a changé.

**Résultat :** à compléter (date, firmware, bloc, modèle, trame, statut).

### 3.12 Restauration complète (`.pgbak`, op 5) — **non validée matériellement**

> **C'est le test le plus risqué du projet.** La restauration réécrit des corps
> de preset sur le pédalier. Aucune restauration issue de ce build n'a encore
> été appliquée. Commence par un fichier de **2–3 presets** sur des slots User
> dédiés, jamais par une sauvegarde complète.

Préparation :

- [ ] POD Go allumé, POD Go Edit fermé, un seul client USB.
- [ ] Slots User dédiés identifiés (contenu noté) et acceptés comme perdables.
- [ ] Sauvegarde `.pgb` complète faite avec l'éditeur officiel, en plus de la
      sauvegarde ci-dessous.

Déroulé :

- [ ] Connecter, **Read active preset**, puis armer les écritures.
- [ ] Ouvrir **Full backup / restore** : **Restore** doit être désactivé et la
      ligne d'aide doit demander d'ouvrir un `.pgbak`.
- [ ] **Download full backup** (recommandé, non obligatoire) : le fichier
      `podgo-full-backup-<horodatage>.pgbak` se télécharge et sa SHA-256
      s'affiche.
- [ ] Vérifier hors ligne que le fichier se rouvre dans le dialogue, que Rust
      l'accepte et que le diff liste Factory et User.
- [ ] Modifier un octet du fichier et confirmer qu'il est **refusé** avec un
      message explicite (test négatif, à faire sur une copie).
- [ ] Sélectionner le petit fichier de 2–3 presets : **Restore** s'active
      immédiatement (aucun mot à taper, aucune case à cocher, aucune sauvegarde
      préalable exigée).
- [ ] Cliquer **Restore** et accepter l'unique confirmation `window.confirm`
      (nombre de presets et SHA-256) : le journal doit afficher la progression
      par preset, puis `Restore: N preset(s) streamed; verifying setlist names…`
      et `Restore verified: N name(s) match the backup.`
- [ ] Rappeler les slots restaurés sur le pédalier : nom **et** son doivent
      correspondre à l'original.
- [ ] Refaire **Read User** et **Read Factory** : aucun nom inattendu.
- [ ] Faire une nouvelle sauvegarde complète et vérifier que la SHA-256 diffère
      de celle d'avant restauration (le contenu a bien changé).
- [ ] Archiver le journal (**Copy log**), les SHA-256 et les noms de fichiers.

En cas d'échec :

- [ ] **Ne pas** relancer en boucle : une fenêtre refusée peut laisser les
      presets précédents déjà écrits (état partiel).
- [ ] Débrancher, archiver le journal, puis restaurer la sauvegarde `.pgb` de
      l'éditeur officiel.
- [ ] Noter le message exact, la fenêtre où l'échec est survenu et le nombre de
      presets déjà écrits.

**Résultat :** à compléter (date, firmware, fichier, SHA-256, nombre de presets,
écarts observés).

### 3.13 Copier / coller / déplacer / renommer un preset

Les opérations locales ne touchent pas au pédalier ; les deux écritures
(op 5 pour un corps, op 71 pour un renommage) demandent seulement les écritures
armées et **une** confirmation. Une sauvegarde complète est recommandée mais
n'est pas exigée.

- [ ] Lire la setlist User, ouvrir un preset, cliquer **Actions…**.
- [ ] **Copy** : le clipboard affiche le nom et le slot d'origine.
- [ ] **Apply paste locally** vers un slot User libre : la liste latérale change
      et **Local changes** affiche `paste → <nom>`.
- [ ] **Apply rename locally** : `rename → <nom>` apparaît.
- [ ] **Apply move locally** vers un autre slot : `move → <nom>` et
      `cleared locally (not written)` apparaissent.
- [ ] Relire la setlist User : les changements locaux disparaissent (le
      pédalier n'a pas changé).
- [ ] **Write paste to pedal** sur un slot User dédié, sans sauvegarde
      préalable : une seule confirmation s'affiche, le journal montre le flux
      op-5, puis la relecture User. Vérifier si le nom du slot a changé ; un
      avertissement est normal (op 9 non envoyée).
- [ ] Rappeler le slot sur le pédalier : le son doit être celui du preset copié.
- [ ] **Write rename to pedal** uniquement pour le preset User **actif**, sans
      sauvegarde préalable : une seule confirmation, puis vérifier le nom dans
      la liste et sur le pédalier.
- [ ] Archiver le journal et, si une sauvegarde a été prise, sa SHA-256.

**Résultat :** à compléter (date, firmware, slots, noms, écarts).

### 3.14 Import POD Go Edit `.pgp` / `.pgb`

Aucune écriture, aucun accès réseau : le fichier est lu dans l'onglet et n'est
ni envoyé ni stocké. Ne pas utiliser un backup contenant des données
personnelles dans les fixtures du dépôt.

- [ ] Cliquer **Import .pgp / .pgb…**.
- [ ] Ouvrir un export `.pgp` : le nom, le produit/firmware, les blocs, les
      footswitches et les contrôleurs s'affichent.
- [ ] Cliquer **Open in editor** : la chaîne et l'inspecteur sont rendus ;
      *Enable device writes*, **Save to slot**, **Actions…** et
      **Download .bin** sont désactivés, le badge indique `offline copy`.
- [ ] Modifier un paramètre continu d'un bloc (**Apply**) : le journal affiche
      `Local edit`, le badge passe à `offline copy · edited`, aucune requête ni
      écriture USB n'a lieu.
- [ ] Cliquer **Rename…** et saisir un nom ASCII : le titre et le badge
      changent ; un nom trop long ou accentué est refusé.
- [ ] Cliquer **Export .pgp** : le fichier `<nom>.pgp` est téléchargé.
- [ ] Rouvrir le `.pgp` exporté : le nom et la valeur modifiée sont présents,
      les autres paramètres et les champs inconnus sont inchangés.
- [ ] Pour un preset choisi dans un `.pgb`, refaire l'export : le fichier
      contient `schema: "L6Preset"`, `version: 6` et l'enveloppe `meta`.
- [ ] Ouvrir une sauvegarde `.pgb` : les deux setlists Factory/User et le
      nombre de presets non vides s'affichent.
- [ ] Sélectionner un slot User : le détail et la chaîne correspondent au
      fichier ; les slots vides sont non cliquables.
- [ ] Fermer le dialogue : le fichier n'apparaît dans aucune sauvegarde locale
      (vérifier le stockage du navigateur).
- [ ] Optionnel : couper le réseau après le chargement de la page et refaire
      les étapes ; aucune requête ne doit partir.

**Résultat :** à compléter (date, fichiers, firmware, écarts).

---

## 4. À ne pas tester encore

- Écriture de chaîne (op 21) : non implémentée ; le sceau de l'objet 14 n'est
  pas résolu.
- Restauration op 9/86/113 et op-254 final : non rejoués par ce build ; leur
  sémantique est inconnue. Seul le flux op-5 est envoyé (§3.12).
- Effacement ou purge d'un slot : aucune opération n'est prouvée ; un
  déplacement local marque la source comme vide, mais le pédalier la conserve.
- Renommage sur le pédalier d'un slot autre que le preset User actif : op 71
  ne stocke que les métadonnées du preset actif.
- Écriture d'un corps de preset (op 5) au-delà du flux de restauration et du
  collage testé en §3.13 : non validée matériellement.
- Export `.pgb` (setlist/backup) et `.hlx` : non implémentés. L'export `.pgp`
  existe, mais un preset importé ou exporté ne peut pas être converti vers
  `l6-helix` ni envoyé au pédalier.
- Application desktop Tauri, Android, iOS (Phases 5 et 8).
- Toute affirmation `ITH` en dehors des chemins validés matériellement :
  lecture WebUSB et `set_param` sur Web Chromium. La sauvegarde (op 71) et la
  restauration restent `ITM`.

---

## 5. Definition of done d'un test

Un test n'est « fait » que si :

1. la commande et le résultat sont reproductibles ;
2. le code de retour est celui attendu ;
3. une preuve est archivée (sortie texte ou capture) ;
4. les écarts sont documentés, pas contournés.

---

## 6. Journal de validation

Copier une ligne par test :

| Date | OS | Firmware | Test | Résultat | Preuve |
|---|---|---|---|---|---|
| aaaa-mm-jj | | | `cargo test --workspace` | | |
| aaaa-mm-jj | | | probe preset | | |
| aaaa-mm-jj | | | probe setlist | | |
| aaaa-mm-jj | | | capture USB | | |
| | | | | | |
