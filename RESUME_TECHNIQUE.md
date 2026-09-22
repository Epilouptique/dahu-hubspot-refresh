# Résumé technique — dahu-hubspot-refresh

Document interne, en français. Contexte du problème, pistes explorées,
architecture retenue et pièges connus.

Version courante : **1.1.0**. Si un diagnostic de rafraîchissement doit être
repris, commencer par la section 5 : elle recense les fausses pistes déjà
explorées, dont deux ont été tenues pour vraies pendant plusieurs semaines.

---

## 1. Le problème initial

HubSpot ne rafraîchit **jamais** une fiche déjà ouverte lorsqu'une source
externe la modifie. Concrètement, côté SAV :

1. Un agent ouvre le ticket d'un client dans son navigateur.
2. Une action de sa part (ou une action automatique) déclenche un workflow
   HubSpot, qui change le statut ou le pipeline du ticket via l'API.
3. La fiche affichée à l'écran continue d'indiquer l'ancien statut,
   indéfiniment, jusqu'à un rechargement manuel (F5).

L'agent travaille donc sur une information périmée sans le savoir, et le
parcours SAV — qui repose sur un enchaînement d'étapes de pipeline — devient
illisible sans réflexe de rechargement permanent.

---

## 2. Pistes explorées et écartées

**Redirection d'onglet.** Faire pointer l'utilisateur vers une nouvelle URL de
la fiche après chaque action, pour forcer un chargement neuf. Écarté : la
redirection ne peut pas être déclenchée depuis un workflow, et côté carte elle
provoquerait un rechargement complet visible et brutal, avec perte du contexte
de saisie en cours. *Nuance apportée en 1.1.0 :* le rechargement complet est
finalement devenu le filet de sécurité (section 5), mais **sur clic de l'agent
uniquement** — c'est le déclenchement automatique qui était inacceptable, pas le
rechargement en lui-même.

**Statuts fictifs.** Créer des statuts intermédiaires dans le pipeline pour
provoquer un changement d'état visible côté interface. Écarté : cela pollue le
pipeline métier avec des étapes qui n'ont aucun sens fonctionnel, et le
problème d'affichage reste entier — un statut fictif écrit par API ne rafraîchit
pas davantage la fiche qu'un statut réel.

**Extension Chrome.** Un script navigateur qui surveille la page et la
rafraîchit. Écarté : suppose un déploiement et une maintenance sur chaque poste
agent, hors du périmètre HubSpot, fragile à chaque évolution du DOM HubSpot, et
inacceptable en termes de gouvernance côté client.

**`onCrmPropertiesUpdate` (mécanisme événementiel natif du SDK).** C'était la
piste la plus élégante et la première implémentée. **Elle ne fonctionne pas
pour ce cas d'usage** : l'événement n'est émis que pour les changements
effectués depuis l'interface HubSpot elle-même (saisie manuelle d'un
utilisateur). Une écriture par API ou par workflow ne déclenche **aucun**
événement. C'est un comportement documenté par HubSpot, pas un bug, donc sans
espoir de correction. Vérifié end-to-end avec des logs à chaque étape du cycle
de vie : abonnement bien enregistré, callback jamais appelé.

Conclusion : le polling actif est la seule approche viable ici, précisément
parce que les changements viennent de workflows et d'API, jamais de saisie
manuelle.

---

## 3. Architecture retenue

### Propriété tampon

Propriété ticket `dahu_refresh_signal`, de type **datetime**. Le type datetime
a été retenu parce que c'est le seul qu'un workflow HubSpot sait mettre à jour
nativement avec une valeur toujours nouvelle, sans code personnalisé.

### Écriture du signal

Dans les workflows, l'action **« Date de fin d'action »** écrit l'horodatage
courant dans `dahu_refresh_signal`. Chaque passage produit une valeur
différente, ce qui suffit à signaler « quelque chose a changé sur ce ticket ».

Le contenu de la valeur n'a aucune importance : seul son *changement* est
exploité. La carte ne l'affiche jamais.

### Lecture du signal

Carte UI Extension en `crm.record.sidebar` (et non `crm.record.tab` : en
sidebar, la carte reste montée quel que soit l'onglet consulté, donc la
surveillance ne s'interrompt pas). Elle :

1. lit `dahu_refresh_signal` au montage et mémorise la valeur, sans rien
   afficher ni rafraîchir ;
2. relit la même propriété toutes les **2 secondes** (`POLL_INTERVAL_MS`) ;
3. si la valeur diffère de la précédente, appelle `refreshObjectProperties()`,
   qui recharge les propriétés affichées sur la fiche sans rechargement de page.

Intervalle de 2 s validé comme définitif : 1 à 3 agents SAV simultanés au
maximum, la charge API est négligeable et la latence perçue nulle.

Le rendu se limite à une ligne « Synchronisation active » — le SDK exige un
retour JSX non nul, un rendu vide fait échouer l'extension.

Les logs `[dahu-sync]` sont conservés dans le code mais conditionnés au flag
`DEBUG` (à `false` par défaut, en haut de `SyncCard.tsx`). En cas de
régression, passer le flag à `true` et redéployer suffit à retracer tout le
cycle de vie. Les erreurs de lecture restent affichées en `console.error` même
hors mode debug : elles signalent une anomalie réelle.

---

## 4. Point de vigilance principal — propagation aux workflows

**L'action « Date de fin d'action » doit être ajoutée à CHAQUE point de CHAQUE
workflow qui modifie le statut ou le pipeline d'un ticket.**

C'est la faiblesse structurelle du dispositif : le rafraîchissement n'a lieu
que là où le signal est écrit. Un workflow qui change un statut sans toucher à
`dahu_refresh_signal` laissera la fiche périmée à l'écran, et le symptôme sera
strictement identique à celui d'avant la mise en place — d'où un risque réel de
diagnostic erroné (« le mécanisme ne marche plus ») alors que seule une branche
de workflow a été oubliée.

Liste à tenir à jour au fur et à mesure de la propagation :

| Workflow | Points modifiant le statut/pipeline | Signal ajouté |
|---|---|---|
| Triage / Diagnostic | à recenser | ⬜ |
| Garantie | à recenser | ⬜ |
| Hors Garantie | à recenser | ⬜ |

Mettre à jour ce tableau à chaque branche traitée, en notant le nombre de
points couverts plutôt qu'un simple « fait ».

---

## 5. Piège majeur — le périmètre réel de `refreshObjectProperties()`

**Cette section a été entièrement réécrite en 1.1.0. La version précédente
attribuait le symptôme au throttling des onglets en arrière-plan. C'était faux,
et cette explication erronée a elle-même coûté un cycle de diagnostic complet à
la session suivante, qui l'a prise pour acquise. Le détail des fausses pistes est
conservé ci-dessous : c'est le principal intérêt de cette section.**

### Le symptôme

Après une action SAV (« Éléments à retourner », « Pièces remplacées »…), la
fiche ticket reste périmée : l'agent voit l'ancienne valeur jusqu'à un
rechargement manuel. La donnée elle-même est correcte — une navigation fraîche
vers le même ticket l'affiche immédiatement. **C'est un problème d'affichage
seul, jamais de perte de donnée.**

### Fausse piste n°1 — le cycle de vie React

Ce n'est **pas** un démontage/remontage du composant. La carte reste montée,
l'onglet HubSpot n'est jamais quitté (les pages `dahu-sav` naviguent à
l'intérieur de leur propre onglet popup, qu'elles tentent de refermer par
`window.close()` en fin de parcours).

### Fausse piste n°2 — le throttling des timers (la plus coûteuse)

Les navigateurs ralentissent bien les `setInterval` d'un onglet inactif, et
l'explication était séduisante : les actions longues laissent l'onglet HubSpot
en arrière-plan plusieurs minutes, les actions rapides ne présentaient pas le
symptôme. Deux séries de tests l'ont démolie :

1. Un aller-retour de quelques secondes échoue **tout autant**, sans qu'aucun
   tick tardif n'apparaisse dans les logs ;
2. Test décisif, onglet maintenu **au premier plan du début à la fin** : le
   compteur d'appels de la carte est passé de 6 à 10 — donc quatre cycles de
   rafraîchissement complets, détectés et exécutés — pendant que le champ
   « Transporteur » du panneau latéral restait obstinément périmé.

Le polling fonctionne. La détection fonctionne. L'appel part. **C'est ce que
l'appel rafraîchit qui est insuffisant.**

### Piège méthodologique à connaître

Deux écueils ont brouillé le diagnostic pendant des semaines, tous deux liés à
l'observabilité et non au code :

- **Ce qui tourne sur le portail ne vient pas de git, mais du dernier
  `hs project upload`.** Une version instrumentée a été écrite le 25 août,
  testée via `hs project dev` (mode local, temporaire), puis jamais téléversée :
  la production est restée un mois sur le build n°17, en `DEBUG = false`, tandis
  que les conclusions étaient tirées du code de l'arbre de travail. **Avant tout
  diagnostic, vérifier le numéro et la date du build déployé côté HubSpot.**
- **`DEBUG = false` ne produit aucune ligne.** Une console vide ne prouve donc
  ni l'absence de la carte, ni son inertie. Le test décisif n'a pu être mené
  qu'après avoir fait afficher à la carte son propre compteur d'appels, dans la
  barre latérale : si un diagnostic doit être repris, rétablir cet affichage
  temporaire plutôt que de se fier à la console.

### Tentative de correctif écartée — `visibilitychange` (impasse)

Un écouteur `document.addEventListener('visibilitychange', …)` a été déployé
puis **immédiatement retiré** : il fait planter la carte en production avec
`ReferenceError: document is not defined`.

Raison : **les cartes UI Extensions s'exécutent dans un Web Worker sandboxé**,
pas dans le contexte DOM de la page (visible dans la stack trace : `worker.ts`,
`WorkerRenderer.tsx`, « Creating a worker from 'blob:…' »). Un Worker n'a accès
ni à `document` ni à `window`. C'est d'ailleurs écrit noir sur blanc dans la
documentation HubSpot des composants `card` : « The global `window` object is
not available in the `card` component ».

**Ne pas reproposer cette piste, ni aucune variante s'appuyant sur `document`
ou `window`** (`visibilitychange`, `focus`, `blur`, `requestAnimationFrame`…).

### Rien à espérer du SDK non plus

Aucun équivalent n'existe côté SDK. Vérifié dans la documentation officielle
(`ui-extensions-sdk/hooks` et `ui-extensions-sdk/actions`) :

- hooks disponibles : `useExtensionApi`, `useExtensionContext`,
  `useExtensionActions`, `useCrmSearch`, `useDebounce`, `useCrmProperties`,
  `useAssociations` — aucun lié à la visibilité, au focus ou au cycle de vie ;
- actions disponibles : `addAlert`, `reloadPage`, `copyTextToClipboard`,
  `closeOverlay`, `openIframeModal`, `fetchCrmObjectProperties`,
  `refreshObjectProperties`, `onCrmPropertiesUpdate` — rien non plus.

### Solution retenue en 1.1.0 — double approche

Puisque le rafraîchissement en place ne couvre pas tout et qu'aucun mécanisme
du SDK ne permet de le forcer plus loin, la carte combine deux niveaux :

1. **`refreshObjectProperties()` à chaque changement détecté.** Conservée : elle
   ne coûte rien et met bien à jour ce qui relève de son périmètre. La retirer
   dégraderait les cas qui fonctionnent déjà.
2. **Un bouton « Mise à jour disponible — actualiser »**, affiché uniquement
   tant qu'un changement détecté n'a pas été pris en compte, appelant
   `reloadPage()`. Un clic, état correct garanti.

**Pourquoi le rechargement n'est pas automatique.** `reloadPage()` déclenché
tout seul ferait perdre une note en cours de saisie dans un autre panneau de la
fiche. La détection est automatique, le rechargement reste à la main de l'agent.

**Repli défensif.** `reloadPage` n'apparaît pas dans le typage des actions de
`crm.record.sidebar` pour cette version du SDK, bien qu'elle soit documentée.
Sa présence est donc testée à l'exécution, avec repli sur `addAlert` invitant à
recharger manuellement — la carte dégrade proprement au lieu de planter.

**Angle mort assumé.** Le bouton n'apparaît que si la carte est montée au moment
où le signal change. Un agent revenant sur un ticket longtemps après ne verra
rien — mais il y arrive alors par une navigation fraîche, donc avec des données
à jour. Le trou subsiste là où il ne gêne pas.

### Ce qui a été supprimé en 1.1.0

Le second appel différé (`STABILIZATION_DELAY_MS`) et toute l'instrumentation de
dérive de timer (`REFRESH_WINDOW_MS`, `TICK_DRIFT_THRESHOLD_MS`,
`WORKER_LOADED_AT`) ont été retirés : ils traitaient le throttling, cause
écartée. Leurs commentaires affirmaient une conclusion fausse avec assurance, ce
qui est exactement ce qui a égaré le diagnostic suivant. **Ne pas les
réintroduire sans avoir d'abord refait le test « onglet au premier plan ».**

La cadence de polling est passée de 5000 à 2000 ms : avec un bouton, c'est la
promptitude de son apparition qui compte, et le coût API reste négligeable à
1-3 agents simultanés.

---

## 6. Limitation connue

La lecture initiale et les ticks de polling partagent la même fonction, avec un
drapeau `initialized` qui distingue le premier passage (mémorisation seule, pas
de refresh) des suivants (comparaison et refresh).

Conséquence : si le tout premier `fetchCrmObjectProperties` échoue (réseau,
throttling), c'est le tick suivant qui fera office d'initialisation — donc un
changement survenu pendant cette fenêtre d'échec de quelques secondes ne sera
jamais détecté. Edge case rare et non bloquant : le changement suivant, lui,
sera capté normalement. Documenté ici pour éviter d'y perdre du temps si le
symptôme se présente une fois.

Autre point mineur : deux écritures du signal séparées de moins d'un tick sont
vues comme un seul changement. Sans conséquence, un refresh unique affichant
l'état final étant exactement le résultat souhaité.

---

## 7. Gouvernance et accès

L'app est une **app privée** liée au compte HubSpot de **Mathieu Migeon** : la
clé d'accès personnelle (`pat-eu1-…` dans `hubspot.config.yml`) a été générée
sous son identifiant, et l'installation de l'app sur le portail 27197525 en
dépend.

À surveiller : si cet accès change côté client (départ, révocation de la clé,
changement de rôle), la CLI ne pourra plus déployer et l'app pourra se
retrouver désinstallée. Il faudra alors regénérer une clé sous un autre
identifiant disposant des droits super-admin, puis relancer
`hs project upload` et `hs project install-app`.

`hubspot.config.yml` est dans `.gitignore` et ne doit jamais être versionné.

---

## 8. Contexte de déploiement

Portail HubSpot 27197525, app privée `annad-App` (uid `annad_app`), carte
`annad_card`. Objet ciblé : `tickets`. Scopes requis : `oauth` et `tickets`
uniquement — les scopes contacts hérités du template de départ ont été retirés,
le projet ne lit aucun contact.
