# Résumé technique — dahu-hubspot-refresh

Document interne, en français. Contexte du problème, pistes explorées,
architecture retenue et pièges connus.

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
de saisie en cours.

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
2. relit la même propriété toutes les **5 secondes** (`POLL_INTERVAL_MS`) ;
3. si la valeur diffère de la précédente, appelle `refreshObjectProperties()`,
   qui recharge les propriétés affichées sur la fiche sans rechargement de page.

Intervalle de 5 s validé comme définitif : 1 à 3 agents SAV simultanés au
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

## 5. Limitation connue

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

## 6. Gouvernance et accès

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

## 7. Contexte de déploiement

Portail HubSpot 27197525, app privée `annad-App` (uid `annad_app`), carte
`annad_card`. Objet ciblé : `tickets`. Scopes requis : `oauth` et `tickets`
uniquement — les scopes contacts hérités du template de départ ont été retirés,
le projet ne lit aucun contact.
