# Ce que l'Analytics promet de mesurer

Document de conception. Il ne décrit pas ce qui est codé, il décide **ce qui a le droit d'exister** — et à quelles conditions. Aucune métrique ne devrait être branchée dans l'API ou l'UI sans figurer ici avec sa définition, ses cas limites et son additivité.

Il existe parce qu'on a construit plusieurs étages de transformation et qu'il est maintenant possible d'en tirer des dizaines de chiffres. La plupart seraient faux, ou vrais d'une manière que personne ne saurait expliquer six mois plus tard.

---

## 1. La chaîne, et ce que chaque étage garantit

```
Ingestion                 SessionAssigner.assign()
        ↓                 une convention, écrite une fois : SESSION_GAP_MS = 30 min
Événements bruts          EventStore.events()
        ↓                 ordre total, fenêtre [from, to), session_id rendu tel quel
Sessions                  sessionsOf()
        ↓                 des présences observées, un repli — aucune addition
Provenances               sourceOf()
        ↓                 une interprétation : un referrer devient un moteur, un site, nous
Lignes datées             GET /analytics/sessions
        ↓                 une forme de sortie, aucun total
Métriques produit         ← ce document, et le lecteur qui regroupe
```

Chaque étage ne connaît que le précédent, et **plus aucun n'additionne**. C'est le renversement de l'étape 33. Il a existé un `session-metrics.ts` qui sommait, et un `summarizeSources()` qui partitionnait ; les deux sont partis. L'API rend des sessions datées sur `[from, to)`, et regrouper — par heure, par jour, par semaine, par provenance — est le travail de qui affiche.

La raison n'est pas esthétique. `/sources` et `/sessions` lisaient le même journal, le repliaient par la même fonction, et deux de leurs compteurs étaient numériquement identiques : deux requêtes pour un seul travail, et deux nombres qui pouvaient se contredire à l'écran si un événement arrivait entre les deux appels. Une seule lecture ne peut pas se désaccorder avec elle-même.

Ce qui **reste** au serveur est ce qui ne peut pas descendre : la classification d'un referrer, qui est une interprétation métier. `uniqueVisitors` y est resté un temps pour la même raison — la déduplication portait sur une clé que le Core ne laisse pas sortir — puis l'**alias de visiteur** a rendu ce compte au lecteur sans rendre la clé. Il reste servi ici pour ce qu'il coûte, pas pour ce qu'il est le seul à pouvoir faire.

Trois choses à ne jamais perdre de vue en lisant la suite.

**Le découpage est fait à l'ingestion, et il est persisté.** C'est le changement structurel de l'étape 25.5. Avant, Analytics regroupait les événements par visiteur et appliquait un seuil à chaque lecture ; désormais chaque événement porte son `session_id`, écrit une fois pour toutes. Deux modules qui lisent le même journal voient forcément les mêmes sessions, parce qu'ils lisent une colonne au lieu de refaire un calcul chacun de leur côté.

**Le Core ne sait pas ce qu'est une durée.** Il sait borner, ordonner, regrouper, **rattacher** et rendre l'instant d'ouverture d'une session ; il ne soustrait jamais deux instants. Toute notion de temps passé naît dans `sessions.ts` et nulle part ailleurs.

**`startedAt` déborde la fenêtre, et c'est le seul champ dans ce cas.** Depuis l'étape 27, le Core rend `sessions.started_at` avec chaque ligne du journal : le début **réel** de la session, même antérieur à `from`. C'est ce qui permet de reconnaître une session que la fenêtre a tronquée par le bas — l'appelant compare à sa propre borne basse. Sans lui, une session ouverte à 09:00 et lue sur `[09:30, 10:00)` serait indiscernable d'une session réellement ouverte à 09:30. La contrepartie est dans `durationMs` : voir le §6.

**Rien n'est jamais fermé à la borne de la fenêtre.** Une présence encore ouverte à `to` reste ouverte, sans durée inventée. C'est ce qui garantit qu'une mesure ne change pas selon le moment où on pose la question — et c'est aussi la source de la plupart des cas limites qui suivent.

### Session et présence

Deux mots, deux choses, et les confondre est la principale façon de se tromper en lisant ce document.

Une **session** est ce que le Core découpe : la suite d'événements d'un même visiteur sans trou de plus de trente minutes. C'est une convention. C'est aussi ce qu'on appelle une **visite** — il n'y a plus deux étages depuis l'étape 25.5, et le mot « visite » ne désigne rien d'autre.

Une **présence** est ce que le SDK observe : un `page_view` l'ouvre, le `page_leave` suivant la ferme. C'est un fait. Une session contient une ou plusieurs présences, séparées par les moments où l'onglet était en arrière-plan.

D'où les deux mesures de temps, qui ne disent pas la même chose :

|                                 | `durationMs`                              | `activeMs`                                  |
| ------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Définition                      | dernier − premier événement de la session | somme des présences **fermées**             |
| Nature                          | l'étendue                                 | le mesuré                                   |
| Inclut le temps en arrière-plan | oui                                       | non                                         |
| Sous-estime                     | non                                       | oui, et `presencesStillOpen` dit de combien |

Une session de vingt minutes dont deux d'actives, c'est un onglet oublié ; vingt minutes dont dix-huit, c'est une lecture. Les afficher séparément est le seul moyen de ne pas mentir.

---

## 2. Audience

### `uniqueVisitors` — visiteurs uniques

- **Unité** : visiteur
- **Source** : `EventStore.countVisitors({ projectId, from, to })`
- **Définition** : nombre de `visitor_key` distincts dans la fenêtre, **tous types d'événements confondus**
- **Définition, dite franchement** : ce **n'est pas un nombre de personnes**. `visitor_key` est un HMAC qui tourne chaque nuit UTC, donc sur une fenêtre de plusieurs jours ce compte dénombre des couples _(personne, journée)_ — quelqu'un revenu trois jours y vaut trois. C'est le prix de l'anonymat par rotation, et il se paie ici plutôt qu'en conservant de quoi suivre les gens.
- **Cas limites** : l'unicité est quotidienne au mieux, et il ne peut pas en être autrement sans une identité qui survit à la journée, que ce projet a choisi de ne pas stocker. Depuis l'étape 25.5, la clé vit sur la table `sessions` et non plus sur l'événement : le Core la lit par jointure, et **elle ne parvient pas jusqu'à Analytics**.
- **Additive** : **exactement à la frontière de rotation.** Deux fenêtres qui se coupent sur un minuit UTC s'additionnent, les clés des deux côtés étant distinctes par construction. Deux fenêtres qui découpent une même journée ne s'additionnent pas — quelqu'un présent le matin et le soir y porte la même clé et compte deux fois.
- **Le lecteur sait maintenant le refaire, à son propre grain.** Ce ne fut pas le cas : un compte de valeurs distinctes n'est pas une somme, et sans identités en main il n'y avait rien à dédoublonner. C'est ce que l'**alias de visiteur** a débloqué — voir §4. Ce chiffre reste ici pour une raison de coût, pas de capacité : il répond sans faire remonter une ligne, là où le refaire côté lecteur coûte le journal entier.

### La série quotidienne de visiteurs

Elle n'a pas existé entre l'étape 33 et l'arrivée de l'alias. Elle existe maintenant, et elle est **exacte** — pas approchée. La démonstration tient en trois pas :

1. une session est portée par le couple `(project_id, visitor_key)` ;
2. la clé tourne à minuit UTC, donc le Core ouvre forcément une session neuve à cet instant : **une session ne peut pas traverser minuit** ;
3. chaque session appartient donc à une seule journée UTC, et chaque clé à une seule journée.

D'où la propriété qui compte : la somme des visiteurs distincts de chaque journée **vaut** `uniqueVisitors` sur la période. Ce n'est pas une coïncidence de jeu de données, c'est la frontière de rotation qui coïncide avec le pas d'affichage. Vérifié sur données réelles : 355 = 355 = 355 sur sept jours.

La réserve, marginale et réelle : la clé est dérivée de l'heure d'**arrivée** de la requête, pas de l'`occurredAt` déclaré (`visitor-key.service.ts`). Un événement antidaté qui traverse minuit peut donc porter la clé du lendemain pour une session datée de la veille. C'est du bruit de bord, pas un biais — mais ça se nomme plutôt que de se taire.

### Ce qui a quitté cette section

`visitorsWithPageView`, `visitorsWithoutPageView` et `visitorsSeenMidVisit` n'existent plus. Les trois étaient des mesures **par visiteur** produites par l'attribution, et l'attribution est passée à la session à l'étape 26.

Leurs remplaçants ne sont pas des renommages, ce sont d'autres nombres :

| Avant                     | Maintenant                                 | Ce qui a changé                                                                                                                            |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `visitorsWithPageView`    | `source !== null` sur les lignes           | L'unité. Un visiteur venu deux fois comptait 1, ses deux visites comptent 2.                                                               |
| `visitorsWithoutPageView` | `source === null`, ventilé par `startedAt` | Une **observation** au lieu d'une soustraction : le lecteur tient les sessions non classées dans la main, et `startedAt` lui dit pourquoi. |
| `visitorsSeenMidVisit`    | rien                                       | Reposait sur `navigation.from`, que le module ne reçoit plus. Le §5 dit ce qu'on sait — et ne sait pas — à la place.                       |

---

## 3. Sessions

### `sessions` — nombre de sessions (= de visites)

- **Unité** : session
- **Source** : `count(distinct session_id)` via `EventStore.countSessions()` pour le résumé, la longueur de `GET /analytics/sessions` pour le détail — **et les deux valent toujours la même chose**, l'égalité étant éprouvée en e2e
- **Définition** : cardinal des `session_id` distincts apparaissant dans la fenêtre
- **Cas limites** : une session à cheval sur une borne est comptée **dans les deux fenêtres** — elle a des événements de chaque côté, donc son `session_id` apparaît des deux côtés. Une session ne peut pas traverser minuit UTC : la clé visiteur tourne, et le Core ouvre forcément une session neuve. C'est la borne de confidentialité qui déborde sur le découpage, et c'est assumé.
- **Additive** : **non** — et l'erreur va dans le sens de la surestimation.

### `presencesStillOpen` / `sessionsWithOpenPresence`

- **Unité** : session
- **Source** : `Session.presencesStillOpen`, rendu tel quel sur chaque ligne de l'API
- **Définition** : présences ouvertes dont le `page_leave` n'est jamais arrivé / sessions qui en portent au moins une
- **Cas limites** : au plus une présence ouverte par session — une présence ouverte empêche d'en ouvrir une autre, et seule la dernière peut rester béante à la fin du journal. **C'est le chiffre qui dit à quel point `totalActiveMs` sous-estime** : il doit accompagner toute durée affichée, sinon le total se lit comme une vérité.
- **Additive** : non.

### `pageViews` par session

- **Unité** : session
- **Source** : `SessionMetrics.pageViews`
- **Définition** : nombre de `page_view` de la session, présences rouvertes comprises
- **Cas limites** : peut valoir **0** — une session sans aucune vue de page existe, et le Core l'ouvre quand même (il ne sait pas ce qu'est un `page_view`). C'est le cas d'une salve de clics dont la vue est tombée hors fenêtre, ou d'une instrumentation partielle. Ne pas supposer `pageViews >= 1`.
- **Additive** : oui au sein d'une fenêtre (`Σ Session.pageViews = totalPageViews`), non entre fenêtres.

### `activeMs` par session

- **Unité** : session
- **Source** : `SessionMetrics.activeMs`
- **Définition** : somme des présences **fermées** de la session
- **Cas limites** : vaut 0 pour une session dont la seule présence court encore. Une session peut avoir un `activeMs` non nul **et** une présence ouverte — ses présences fermées sont mesurées, la dernière court. Les deux faits sont vrais en même temps et aucun ne se déduit de l'autre.
- **Additive** : oui au sein d'une fenêtre, **non et lossy** entre fenêtres (§6).

### `durationMs` par session

- **Unité** : session
- **Source** : `SessionMetrics.durationMs`
- **Définition** : `endedAt − startedAt`, où `startedAt` est le **début réel** de la session et `endedAt` son dernier instant **observé**
- **Cas limites** : les deux bornes n'ont pas le même statut, et c'est délibéré. Le début est une valeur persistée, la fin est une observation — le Core ne stocke pas d'`ended_at`, parce qu'une session n'a pas de fin tant qu'un événement peut encore lui arriver. Conséquence : sur une session tronquée par le bas, `durationMs` **couvre du temps qu'on n'a pas observé** (09:00 → 09:50 alors que la fenêtre commence à 09:30). Ce n'est pas une extrapolation, la session a réellement duré ça. Vaut 0 pour une session d'un seul événement, ce qui est normal. **Toujours ≥ `activeMs`.** Ne jamais l'afficher comme « temps passé » : il inclut l'arrière-plan.
- **Additive** : **non, et inflationniste**. Deux fenêtres consécutives qui contiennent chacune un morceau de la même session comptent chacune tout ce qui précède leur propre borne. Voir §6.

### `startedAt` — le champ qui dit si la fenêtre a coupé

- **Unité** : session
- **Source** : `SessionMetrics.startedAt` ← `sessions.started_at`, rendu par le Core avec chaque ligne du journal
- **Définition** : l'instant du premier événement de la session, **hors fenêtre compris**
- **Cas limites** : c'est le seul champ de toute la chaîne qui puisse être antérieur à `from`. Ce n'est pas une entorse au cadrage : la fenêtre décide de quelles _lignes_ sortent, pas de ce qu'une ligne dit d'elle-même. `startedAt < from` signifie « session commencée avant ma fenêtre » ; `startedAt >= from` signifie « je l'ai vue s'ouvrir ». Aucun autre signal ne permet cette distinction — le premier événement visible vaut `from` ou plus dans les deux cas.
- **Additive** : sans objet, ce n'est pas un compteur.

### `sessionsWithPageView` / `sessionsWithoutPageView`

- **Unité** : session
- **Source** : deux filtres du lecteur sur `pageViews`
- **Définition** : sessions ayant au moins un `page_view` dans la fenêtre, et les autres
- **Cas limites** : les deux **partitionnent** — leur somme fait toujours `sessions.length`. Une session sans vue de page reste une vraie session et compte dans le total : le Core l'a ouverte parce qu'un événement est arrivé, et il ne sait pas ce qu'est une vue de page. C'est exactement la population que `source === null` désigne sur les lignes de l'API, et `startedAt` la ventile ensuite entre « fenêtre qui coupe » et « aucune vue de page ».
- **Additive** : non.

---

## 4. Pages

### Déjà exposé — `GET /v1/projects/:id/analytics`

| Métrique         | Unité     | Source                               | Additive entre fenêtres |
| ---------------- | --------- | ------------------------------------ | ----------------------- |
| `pageViews`      | événement | `countEvents({type: 'page_view'})`   | **oui**                 |
| `uniqueVisitors` | visiteur  | `countVisitors()` tous types         | non                     |
| `topPages`       | événement | `topValues(attributes, 'page.path')` | non (c'est un top-N)    |
| `sessions`       | session   | `countSessions()` tous types         | non, inflationniste     |

`pageViews` est la seule métrique **franchement additive** de tout ce document : un `page_view` est un événement ponctuel, il tombe d'un côté ou de l'autre d'une borne et jamais des deux.

`topPages` est un **classement, pas une décomposition**. La somme de ses `events` est inférieure à `pageViews` dès qu'il y a plus de dix pages ou qu'un `page_view` n'a pas de `page.path`. Le lire comme une répartition exhaustive est un contresens ; c'est pour ça que le total reste rendu à part.

### À construire

**Pages d'entrée** — la matière première est là et elle est branchée : `SessionSource.path`, rendu par `sessionSources()` à côté de la provenance. Reste à en faire un agrégat — un top-N des chemins d'entrée, avec le même avertissement que `topPages` : un classement n'est pas une décomposition. Les sessions sans entrée (§5) en sont exclues et doivent être comptées à côté, sinon le total du classement se lira comme le total des sessions.

**Pages de sortie** — définition ambiguë, à trancher avant de coder. La dernière page vue d'une session ? Ou la page où le `page_leave` a été émis ? Ce n'est pas la même chose dès qu'une navigation interne suit la dernière vue comptée. À ne pas exposer tant que la question n'est pas tranchée.

**Parcours entre pages** — hors scope pour l'instant. Demande de porter la suite ordonnée des chemins par session, ce qui change la forme de `Session`. À rediscuter quand pages d'entrée/sortie seront faites.

---

## 5. Acquisition : à quel niveau attribuer une source

**Décidé et fait : la session.** C'est l'unité de parcours, et c'est la seule qui donne le bon comportement — un visiteur revenu par Google le matin puis en direct le soir produit deux sessions, donc deux lignes.

Les deux autres niveaux étaient faux, chacun dans un sens :

- **par visiteur** — le premier `page_view` de la fenêtre décidait pour toute la journée. La seconde provenance était silencieusement écrasée. C'est ce que le module faisait jusqu'à l'étape 26 ;
- **par événement** — le referrer est figé au chargement du document et voyage avec chaque événement. Une visite de trois pages dirait trois arrivées de Google, et l'erreur serait exactement proportionnelle à la profondeur des visites : invisible, et d'autant plus grosse que le site est bon.

### Ce que le module lit, et ce qu'il ne lit plus

Il reçoit des `Session`, pas des événements. Deux conséquences voulues :

- la **clé visiteur ne l'atteint plus**. Il ne peut plus raisonner sur des personnes, même par accident ;
- **`properties` non plus**, donc `navigation.from` est structurellement hors de portée. Il servait à dire « on a attrapé la visite en cours de route » ; le rôle a disparu avec l'étage visiteur, et le §ci-dessous dit ce qui le remplace.

`Session.entry` porte trois faits recopiés du premier `page_view` de la session : `path`, `referrer`, et **`url`**. Le troisième a été ajouté à l'étape 26 parce que la règle « referrer de notre propre origine → `internal` » n'est pas décidable sans lui : `path` ne porte pas l'hôte. C'est toujours une recopie, jamais une conclusion — `sessions.ts` transporte, `entry-source.ts` interprète.

### Quand la fenêtre coupe le début d'une session

Une session peut commencer avant `from` et n'exposer que sa fin. Elle est alors attribuée sur ce que la fenêtre montre. La réponse n'est pas « on gère », c'est « voilà exactement ce qui se passe » — et les trois branches sont éprouvées :

| Ce que la fenêtre montre                      | Résultat                           | Est-ce faux ?                                                    |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Aucun `page_view` de la session               | `source: null`, `startedAt < from` | Non. On dit qu'on ne sait pas, et pourquoi.                      |
| Un `page_view` d'un site **multi-pages**      | `internal`                         | Non. C'est précisément la catégorie « on n'a pas vu l'arrivée ». |
| Un `page_view` d'une **application monopage** | la vraie provenance externe        | La source est juste. C'est le `path` qui n'est pas une landing.  |

Aucune de ces branches ne produit de **fausse acquisition** : on ne peut pas inventer un `search` ou un `referral` qui n'a pas eu lieu. Le seul défaut résiduel est le `path` du troisième cas.

On sait désormais **que** la session a été coupée : `Session.startedAt` porte le vrai début, et `startedAt < from` identifie exactement les sessions concernées. C'est ce que l'étape 28 exploite (voir juste en dessous). Ce qu'on ne sait toujours pas, c'est quelle page l'a ouverte.

Et on ne le cherchera pas. Élargir la fenêtre à la volée pour aller chercher le vrai `page_view` d'entrée ferait dépendre le résultat d'un cadrage que personne n'a demandé : deux lectures rendraient des acquisitions différentes pour des raisons qu'aucune borne n'expliquerait. `startedAt` sert à savoir que la session **existait déjà**, jamais à savoir d'où elle venait.

En pratique, la fenêtre doit être large devant les sessions. Sur une journée, seules celles qui chevauchent minuit sont concernées — et la rotation de la clé visiteur en ouvre déjà une neuve à cet instant-là.

### Une session sans page vue n'est pas `direct`

`direct` veut dire « on a vu la page, le navigateur n'a pas donné de provenance ». Une session sans aucun `page_view` veut dire « on n'a rien vu du tout ». Les ranger ensemble gonflerait l'acquisition d'un bruit qui n'a rien à voir avec elle, donc la seconde sort avec `source: null` plutôt qu'avec `direct`.

Deux causes s'y mélangent — une instrumentation partielle (des `click` sans `page_view`) et une fenêtre qui coupe. Elles ne sont plus indiscernables _en principe_ : `startedAt < from` désigne la seconde. Elles le restent _en pratique_ tant qu'`entry-source.ts` n'exploite pas le champ.

Nuance qui a sa place ici : une vue de page arrivée **sans aucun attribut exploitable** est bien attribuée, en `direct`. Elle a été vue ; c'est le seul critère. Le module se fonde donc sur `Session.pageViews`, pas sur « `entry` est vide » — les deux coïncident presque toujours, et ce presque est exactement ce cas-là.

### Les catégories

Inchangées, et elles restent bonnes : `direct` / `search` / `referral` / `internal`.

- **Additive** : non, quel que soit le niveau.
- **Cas limite majeur** : `internal` n'est pas de l'acquisition. C'est un referrer pointant sur nous — rechargement, ancre, session attrapée après un changement de document. Il est **rendu plutôt qu'écarté** parce que sa part dit à quel point la lecture est polluée. L'acquisition, c'est `direct + search + referral`.
- **Cas limite majeur** : `direct` veut dire « aucune provenance connue », pas « quelqu'un a tapé l'URL ». Le navigateur ne donne pas de referrer sur une entrée directe, mais pas non plus avec une `Referrer-Policy` restrictive, en HTTPS → HTTP, ou depuis certaines apps natives.

---

## 6. L'additivité, et pourquoi elle mérite sa section

**Ne pas supposer qu'une métrique simple est additive.** Le comportement aux frontières de fenêtre a été vérifié sur la chaîne réelle, pas déduit.

Cette section a changé de destinataire à l'étape 33 sans changer d'un mot sur le fond. Les totaux nommés ci-dessous ne sont plus calculés par l'API — c'est le lecteur qui les fait, à partir des lignes. Il en hérite donc les régimes, et il est le seul en position de les respecter. Les noms sont gardés parce qu'ils désignent les mêmes quantités.

Une présence de 09:50 à 10:10, coupée à 10:00 :

| Métrique          | Fenêtre entière | Avant 10:00 | Après 10:00 | Somme        |
| ----------------- | --------------- | ----------- | ----------- | ------------ |
| `totalPageViews`  | 2               | 1           | 1           | **2 ✓**      |
| `totalActiveMs`   | 20 min          | 0           | 5 min       | **5 min ✗**  |
| `totalDurationMs` | 20 min          | 10 min      | 20 min      | **30 min ✗** |
| `sessions`        | 1               | 1           | 1           | **2 ✗**      |
| `uniqueVisitors`  | 1               | 1           | 1           | **2 ✗**      |

Quatre régimes différents, à connaître :

**`pageViews` est additif.** Événement ponctuel, il tombe d'un seul côté.

**`activeMs` est _lossy_, pas seulement non additif.** Il ne se répartit pas entre les deux fenêtres : il **disparaît**. La moitié gauche voit un `page_view` sans `page_leave` (présence ouverte, 0 ms) ; la moitié droite voit un `page_leave` sans `page_view` (rien à fermer). Sans page vue à droite, les 20 minutes sont intégralement perdues. C'est la conséquence directe — et assumée — du refus d'inventer une durée jusqu'à `to`.

**`totalDurationMs` est inflationniste, et sur la durée.** Depuis l'étape 27, `startedAt` est le début **réel** de la session, pas le bord de la fenêtre. La moitié droite compte donc les 20 minutes complètes alors qu'elle n'en a observé que 10, et la somme dépasse le total. C'est le prix — assumé — de pouvoir reconnaître une session tronquée : le champ qui rend l'information rend aussi l'erreur, et il vaut mieux une surestimation qu'on sait nommer qu'une confusion qu'on ne voit pas.

**`sessions` et `uniqueVisitors` sont inflationnistes.** Une session à cheval a des événements des deux côtés, donc son `session_id` est compté deux fois. Noter que la persistance du découpage n'y change rien : ce n'est pas le découpage qui est instable, c'est la fenêtre qui coupe.

### Ce que ça impose au dashboard

1. **Ne jamais additionner deux fenêtres.** Sept lectures quotidiennes ne se somment pas en un total hebdomadaire — il faut redemander la semaine. C'est vrai des sessions, des visiteurs et des durées ; seules les vues de page y échappent.
2. **Les fenêtres doivent être larges devant les sessions.** Sur une journée, la perte concerne les sessions qui chevauchent minuit — et elles sont rares par construction, puisque la rotation de la clé visiteur en ouvre une neuve. Sur une fenêtre d'une heure, elle ne l'est plus.
3. **`sessionsWithOpenPresence` accompagne toute durée.** Sans lui, `totalActiveMs` se lit comme un total complet alors qu'il sous-estime toujours.
4. **`totalDurationMs` ne s'affiche pas seul.** Il inclut l'arrière-plan et déborde la fenêtre par le bas. À côté d'`activeMs` il dit quelque chose — l'écart entre les deux est l'inattention ; sans lui, il se lit comme du temps passé.

---

## 7. Temps : ce qu'on expose

`activeMs` est la donnée de base : en millisecondes, entière, exacte, additive **au sein d'une fenêtre**. Les parties font le tout — présences → session → total. Arrondir à la seconde casserait ces égalités ; la mise en forme est le travail de qui affiche.

| Métrique                       | Verdict                                | Pourquoi                                                                                                                      |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Durée totale active**        | ✅ exposer                             | Définie sans ambiguïté. Accompagnée de `sessionsWithOpenPresence`.                                                            |
| **Étendue (`durationMs`)**     | ⚠️ jamais seule                        | Toujours à côté d'`activeMs`, jamais à sa place. Seule, elle se lit comme du temps passé alors qu'elle inclut l'arrière-plan. |
| **Durée moyenne par session**  | ⚠️ à condition                         | Voir ci-dessous.                                                                                                              |
| **Médiane**                    | ✅ exposer, de préférence à la moyenne | Robuste aux sessions très longues, qui sont fréquentes (onglet oublié).                                                       |
| **Distribution**               | ✅ exposer                             | En quelques seaux fixes. C'est ce qui rend la médiane et la moyenne interprétables.                                           |
| **Temps actif moyen par page** | ❌ ne pas exposer                      | Non calculable honnêtement — voir ci-dessous.                                                                                 |

### La moyenne demande une décision explicite

`totalActiveMs / sessions` et `totalActiveMs / uniqueVisitors` sont deux chiffres différents, tous deux défendables. Et surtout : **le dénominateur doit-il inclure les sessions dont la présence court encore ?** Elles apportent 0 ms tout en comptant dans `sessions`, ce qui tire la moyenne vers le bas d'autant plus que la fenêtre est courte.

**Recommandation** : si on expose une moyenne, ce doit être `totalActiveMs / (sessions − sessionsWithOpenPresence)`, en affichant `sessionsWithOpenPresence` à côté. Diviser par `sessions` mélange des sessions mesurées et des sessions non mesurées dans un seul nombre.

### Pourquoi pas le temps par page

Il faudrait attribuer à chaque `page_view` la durée qui le sépare du suivant. Trois raisons de s'abstenir :

- la **dernière page** d'une présence n'a pas de suivant — c'est justement celle qu'on veut souvent mesurer, et c'est la seule qu'on ne peut pas ;
- le SDK n'émet **rien** quand l'onglet redevient visible : une reprise sans navigation est invisible, donc le temps sur cette page est indécomptable ;
- ça demanderait de porter les chemins dans la chaîne (§4).

À reconsidérer si un jour on ajoute un `page_resume` au SDK. Pas avant.

---

## 8. Hors scope, explicitement

Liste noire. Ces choses ne sont pas « pas encore faites », elles sont **refusées tant qu'une décision explicite ne les rouvre pas**.

| Refusé                      | Pourquoi                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redécouper à la lecture** | Le découpage est persisté depuis l'étape 25.5. Le refaire côté Analytics rouvrirait exactement le défaut qu'on vient de fermer : deux modules, deux seuils, deux réalités.              |
| **Bounce rate**             | Aucune définition partagée. « Une seule page » et « moins de N secondes » donnent des chiffres opposés sur un blog. Et une session à une page qui dure dix minutes n'est pas un rebond. |
| **Engagement score**        | Un nombre composite qui ne veut rien dire et que personne ne peut auditer. Si trois métriques comptent, on affiche trois métriques.                                                     |
| **Funnels**                 | Demande de nommer des étapes, donc de la configuration par projet. Rien dans le Core ne la porte aujourd'hui.                                                                           |
| **Conversion**              | Même chose : il faut que le site déclare ce qui compte comme conversion. `track()` existe pour ça, le reste est à construire.                                                           |
| **Attribution multi-touch** | Demande une identité qui survit à la journée. `visitor_key` tourne toutes les 24 h UTC — c'est un choix de conception, pas une limite technique.                                        |
| **Replay, heatmaps**        | Autre produit. Demanderait une collecte d'un ordre de grandeur différent et une posture vie privée qu'on n'a pas prise.                                                                 |

---

## 9. Ce que le dashboard promet — la version courte

> Sur une fenêtre donnée, l'Analytics dit **combien de monde est venu**, **combien de parcours ils ont faits**, **quelles pages ils ont vues**, **d'où ils venaient**, et **combien de temps ils ont réellement été présents** — en ne comptant que ce qui a été observé, et en disant ce qui lui a échappé.

Les trois promesses qui la rendent tenable :

1. **Rien n'est inventé.** Aucune durée n'est extrapolée, aucune présence n'est fermée d'office. Ce qui n'a pas été vu est compté comme non vu, et le nombre de mesures incomplètes est rendu à côté du total.
2. **Une seule définition de la session, pour tout le monde.** Elle est écrite une fois à l'ingestion et lue partout. Aucun module ne peut en avoir une version légèrement différente.
3. **Rien ne s'additionne sans le dire.** Chaque métrique porte son régime d'additivité, et le dashboard ne somme jamais deux fenêtres.

### Ce qui est devenu irréversible, et pourquoi on l'a accepté

Le document affirmait avant que **rien** n'était irréversible : toutes les définitions étaient des lectures, changer un seuil ne demandait aucune migration. Ce n'est plus vrai du seul découpage.

`SESSION_GAP_MS` est appliqué à l'écriture. Le changer ne reprofilerait pas l'historique — il faudrait reconstruire les `session_id` existants. Le prix est assumé : trente minutes est une convention stable de l'analyse web, pas un réglage qu'on prévoit de bouger, et ce qu'on gagne en échange — une session unique pour tous les lecteurs — vaut plus que la souplesse qu'on perd.

Tout le reste reste réversible. Les définitions de ce document sont des lectures, les événements bruts sont intacts, et rien d'autre que le rattachement n'est figé.

### État d'implémentation

| Étage                       | Fichier                                           | Branché                                                              |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Attribution de session      | `sessions/session-assigner.service.ts`       | oui — à chaque ingestion, dans la transaction d'écriture             |
| Journal brut + `started_at` | `events/event-store.service.ts` → `events()` | oui                                                                  |
| Repli en sessions           | `sessions.ts` → `sessionsOf()`                    | oui — seul point d'entrée du module                                  |
| Lignes de session           | `analytics.service.ts` → `sessions()`             | `GET /v1/projects/:id/analytics/sessions` — une ligne par session    |
| Pages / audience            | `analytics.service.ts` → `summarize()`            | `GET /v1/projects/:id/analytics` — quatre agrégats de période        |
| Acquisition                 | `entry-source.ts` → `sourceOf()`                  | oui — une provenance par ligne, depuis l'étape 33                    |
| Entrée de session           | `sessions.ts` → `Session.entry`                   | oui — consommée par `sourceOf()`, et `entry.path` sort avec la ligne |

**Ce qui a été supprimé à l'étape 33**, et qui ne doit pas revenir sans qu'on ait redécidé :

- `session-metrics.ts` en entier — les totaux se refont chez le lecteur ;
- `summarizeSources()` et sa ventilation `unattributed` — même raison ;
- `EventStore.countEventsByDay` / `countVisitorsByDay` / `byDay` — le découpage temporel appartient au lecteur ;
- `EventStore.firstEvents()` — sans consommateur en production depuis l'étape 25.5 ;
- le paramètre `interval` et le champ `timeseries` de `GET /analytics`.

### Ce que l'API expose, et ce qu'elle retient

**Deux routes.** Ce qui les sépare n'est pas une vue, c'est un coût et une capacité.

| Route                     | Nature                       | Rend                                                                                   |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `GET /analytics`          | agrégats SQL, bon marché     | `sessions`, `pageViews`, `uniqueVisitors`, `topPages` — sur la période, sans découpage |
| `GET /analytics/sessions` | le journal replié, en lignes | une ligne par session, datée, avec sa provenance déjà classée et son alias de visiteur |

La première ne fait remonter aucune ligne, donc son coût ne dépend pas du volume — c'est ce qui la justifie, `uniqueVisitors` compris : le lecteur sait refaire ce compte depuis les alias de la seconde, mais il lui en coûte le journal entier. Elle est aussi la **jauge** de la seconde : son `sessions` dit exactement combien de lignes celle-ci rendra.

**Ce que la ligne porte, et ce qu'elle écarte.**

Huit champs : `visitorAlias`, `startedAt`, `endedAt`, `activeMs`, `pageViews`, `presencesStillOpen`, `entryPath`, `source`.

`durationMs` n'y est pas parce que les deux bornes y sont — la soustraction appartient au lecteur. La mise en garde du §6 reste entière : cette étendue part du début **réel** de la session, donc elle ne s'additionne pas entre fenêtres adjacentes. C'est désormais une note, plus une rétention, et `startedAt` est là pour que le lecteur le voie lui-même.

`presences[]` n'y est pas non plus : une heatmap de temps actif par heure en aurait besoin, rien ne la demande, et la ligne doublerait de taille pour du poids mort. Un champ de plus le jour où la question se pose.

La clé visiteur n'y est toujours pas, et n'y sera pas. Ce qui y est depuis, c'est la forme que ce paragraphe appelait de ses vœux : un **alias opaque valable dans la réponse seule**.

**Ce qu'il est.** Un jeton tiré au hasard à chaque lecture, attribué une fois par visiteur rencontré. Il permet une chose : reconnaître que deux lignes viennent du même visiteur, à l'intérieur d'une réponse. Il ne dit rien de qui, ne survit à rien, et deux appels sur la même fenêtre ne rendent pas les mêmes jetons.

**Ce qu'on accepte en le rendant.** Les sessions d'une même personne deviennent joignables **sur une journée**, pour qui lit la réponse. C'est la ligne, et elle est tenue par la mécanique plutôt que par la promesse : la clé sous-jacente tourne à minuit UTC, donc rien ne franchit la journée, alias ou pas. Le produit reste cookieless — rien n'est écrit sur l'appareil du visiteur, et ça n'a jamais été ce qui se jouait ici.

**Ce que ça débloque.** Les visiteurs uniques par jour, par semaine, par heure — au grain que le lecteur choisit, sans que le serveur reprenne le découpage temporel qu'il a rendu à l'affichage à l'étape 33. C'est la dette de cette étape-là, remboursée par l'autre bout.

**Ce qui rouvrira le calcul.** Un **mode à consentement**. Le jour où un bandeau recueille un accord explicite, une identité qui survit à la journée devient discutable — et avec elle l'attribution multi-touch, le retour visiteur, la rétention. Ce n'est pas cet alias qui le décidera : il est conçu pour ne rien pouvoir de tout ça.

**Ce que `sessionId` faisait là, et pourquoi il est parti.** Il identifiait la session, de façon stable d'un appel à l'autre. À côté d'un alias tiré au hasard, il annulait le tirage : deux réponses se joignent par `sessionId`, et les alias se recollent par transitivité. Aucun lecteur ne le réclamait — une ligne *est* une session.

À dire honnêtement plutôt qu'à survendre : retirer `sessionId` retire l'identifiant *explicite et stable*, celui qu'un client serait tenté de persister. Ça ne rend pas la corrélation entre deux réponses impossible — `startedAt` et `endedAt` forment une clé naturelle quasi unique. Ce qui est empêché, c'est le rapprochement délibéré et facile ; ce n'est pas une garantie cryptographique, et ça ne se présente pas comme telle.

**Ce qui n'est pas borné : le nombre de lignes.** C'est le vrai coût du modèle, et la fenêtre est le seul garde-fou. Le jour où ça mord, ce sera une pagination — un paramètre de la même route, pas une seconde route.

### Le prochain choix

Le tableau de bord. Rien de structurel ne manque plus en amont, et deux routes le nourrissent déjà.

Trois décisions :

1. **quelles moyennes affiche-t-on ?** Le §7 pose les conditions — médiane plutôt que moyenne, dénominateur explicite, `sessionsWithOpenPresence` toujours à côté. Il reste à choisir.
2. **que fait-on voir des sessions non classées ?** Les trois nombres — classées, tronquées, sans vue — ne se lisent qu'ensemble. La question est de savoir si l'UI montre la ventilation ou seulement une alerte quand « sans vue » grimpe : c'est le signal « instrumentation cassée », et le seul des trois sur lequel on peut agir.
3. **où plafonne-t-on le nombre de lignes ?** `/analytics/sessions` n'est borné que par la fenêtre. Une pagination ou un plafond explicite devra arriver avant que le volume ne le décide à notre place — dans la même route, et en le disant dans la réponse plutôt qu'en tronquant en silence.

## Technologie — navigateur, système, appareil

`GET /v1/projects/:id/analytics/technology?grain=browser|os|device`. Même forme
que `locations` : une route, trois grains, `unresolved` rendu plutôt que tu.

**Ce qui est mesuré.** Trois libellés dérivés du User-Agent **à l'ouverture de la
session**, comme la géographie l'est de l'IP. Le User-Agent lui-même n'est stocké
nulle part — il entre dans `CoreService`, sert à dériver la clé visiteur et ces
libellés, et meurt avec la requête.

**Aucune version.** Ni celle du navigateur — la mineure est du bruit qui
multiplie l'unicité d'une ligne de session, la majeure sert une matrice de
compatibilité qui est un autre produit — ni celle du système, qui est **fausse** :
Windows 11 se déclare « Windows NT 10.0 », macOS « 10_15_7 » depuis des années.

**`unresolved` n'est pas une anomalie.** C'est la longue traîne des navigateurs
qu'on ne nomme pas. La table ne reconnaît que ce qu'elle nomme, et rend `null`
plutôt qu'un libellé faux. Un classement qui tairait ces visiteurs se lirait
comme s'il couvrait tout le trafic.

**`visitors` ne s'additionne pas** entre les lignes, pour la même raison qu'au
classement géographique : le classement est tronqué par `limit`, et un même
visiteur peut apparaître sous deux valeurs s'il a changé d'appareil. Le
dénominateur est rendu à part.

### ⚠️ Les tablettes sont sous-comptées

Depuis iPadOS 13, Safari envoie par défaut l'en-tête d'un Mac — littéralement
celui d'un ordinateur de bureau. La majorité des iPad est donc rangée en
`desktop`. Aucune correction n'est possible : l'information n'est pas dans la
chaîne. C'est du même ordre que la ville, qui est une estimation, et ça se dit à
qui lit le chiffre.

### `botSessions` — et pourquoi il est publié

Les sessions de robots sont écartées **structurellement** : la condition vit dans
`EventStore.where()`, que les neuf lectures traversent, donc aucun module ne peut
l'oublier. Un événement sans session — un déploiement, un paiement, une sonde —
passe sans qu'on ait à l'écrire, le `NOT EXISTS` étant vrai quand il n'y a rien à
trouver.

Mais un chiffre retiré en silence est un chiffre que personne ne sait manquant :
sans ce compteur, une vague de robots et une baisse de trafic se ressembleraient
exactement. Le résumé le rend donc, et c'est la seule place des robots dans le
produit.

**La détection est volontairement conservatrice.** Uniquement des robots qui se
déclarent ; jamais une déduction par l'absence. Un faux positif ne dégrade pas une
statistique, il **supprime** du trafic réel de tous les compteurs — et un
User-Agent vide ou inhabituel n'est pas un robot, c'est un visiteur qu'on ne sait
pas nommer.

**⚠️ Rupture de série.** `botSessions` ne monte qu'à partir de la mise en service
de la détection. Toutes les sessions antérieures sont comptées comme humaines, et
le resteront : le User-Agent qui aurait permis de les juger n'a jamais été
stocké. Ce n'est pas une invasion soudaine, c'est une mesure qui commence.
