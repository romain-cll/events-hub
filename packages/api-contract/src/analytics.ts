import { z } from 'zod';

/**
 * Les **deux** routes analytiques, et il n'y en a que deux.
 *
 * C'est le point le plus important de ce fichier. Le dashboard en appelait
 * trois — `/analytics`, `/analytics/sources`, `/analytics/sessions` — dont une
 * qui n'existe plus, une avec un paramètre refusé, et une dont il attendait des
 * agrégats là où l'API rend des lignes. Ce fichier décrit ce que l'API sert
 * **réellement**, et rien d'autre.
 *
 * ## Ce que l'API retient, et pourquoi
 *
 * Le découpage temporel a été retiré : le pas, le fuseau et le calendrier sont
 * trois décisions d'affichage, et le serveur n'a pas à les prendre. Le lecteur
 * reçoit des sessions datées et les regroupe comme il l'entend.
 *
 * Le prix a été réel un temps : **les visiteurs uniques par jour ont disparu
 * avec**. Un compte de valeurs distinctes n'est pas une somme, et la clé
 * visiteur ne sort pas du Core — le lecteur n'avait donc rien à dédupliquer.
 *
 * Chaque ligne de session porte maintenant un **alias de visiteur** : opaque,
 * tiré au hasard à chaque appel, valable dans la réponse seule. Le lecteur
 * compte ses distincts au grain qu'il veut, et le serveur ne reprend toujours
 * aucun calendrier. Voir `sessionRowSchema.visitorAlias`.
 *
 * Même logique pour la ventilation par source et pour les totaux de session :
 * ils se refont chez le lecteur à partir des lignes ci-dessous.
 */

/**
 * Une valeur et ses deux comptes, la forme que le Core rend pour un classement.
 *
 * `value` est toujours du texte, quel que soit le type JSON d'origine.
 */
export const valueCountSchema = z.object({
  value: z.string(),
  events: z.number(),
  visitors: z.number(),
});

export type ValueCount = z.infer<typeof valueCountSchema>;

/**
 * `GET /v1/projects/:projectId/analytics` — six agrégats et un classement.
 *
 * Aucune ligne ne remonte : tout est calculé par Postgres, donc le coût ne
 * dépend pas du volume de la fenêtre.
 *
 * ⚠️ **Il n'y a ni `interval` en paramètre, ni `timeseries` en réponse.** Un
 * `?interval=day` resté dans un signet reçoit un 400 — la requête est validée
 * en `strictObject` côté serveur, elle refuse plutôt que d'ignorer.
 *
 * `uniqueVisitors` **n'est pas un nombre de personnes** : la clé visiteur
 * tourne chaque nuit UTC, quelqu'un revenu trois jours y vaut trois. C'est le
 * seul chiffre de la chaîne qui ne puisse pas se recalculer chez le lecteur.
 *
 * `topPages` est un **classement tronqué à dix**, pas une décomposition : la
 * somme de ses `events` est inférieure à `pageViews` dès qu'il existe plus de
 * dix pages, ou qu'une vue n'a pas de chemin exploitable. L'afficher en
 * pourcentages du total serait un mensonge.
 */
export const analyticsSummarySchema = z.object({
  /** Borne incluse. */
  from: z.iso.datetime({ offset: true }),
  /** Borne **exclue**. */
  to: z.iso.datetime({ offset: true }),
  /**
   * Sessions distinctes de la fenêtre, tous types confondus.
   *
   * Exactement la longueur de la réponse de la route voisine sur la même
   * fenêtre — l'égalité est éprouvée en e2e. Elle sert de jauge : elle dit
   * combien de lignes `sessions` rendra, sans les payer.
   */
  sessions: z.number(),
  /** Le seul total franchement additif. */
  pageViews: z.number(),
  uniqueVisitors: z.number(),
  /**
   * Sessions de robots **retirées** de tous les autres compteurs de ce résumé.
   *
   * Rendu pour que le retrait ne soit pas muet : sans lui, une vague de robots
   * et une baisse de trafic se ressemblent exactement.
   *
   * ⚠️ Rupture de série : il ne monte qu'à partir de la mise en service de la
   * détection. Les sessions antérieures sont toutes comptées comme humaines —
   * le User-Agent qui aurait permis de les juger n'a jamais été stocké.
   */
  botSessions: z.number(),
  /**
   * Visites dont le visiteur a **accepté** le cookie de croisement.
   *
   * Le consentement ne porte que sur l'attribution du revenu — la mesure
   * d'audience ne demande rien et ne dépose rien. Ce nombre dit donc combien de
   * visites sont corrélables à un paiement.
   */
  consentGranted: z.number(),
  /**
   * Visites dont le visiteur a **refusé** le cookie de croisement.
   *
   * ⚠️ `consentGranted + consentDeclined` ne fait **pas** `sessions`. L'écart
   * est le nombre de visites auxquelles on n'a rien demandé — site sans
   * bandeau, ou page qui ne l'a pas câblé. Les compter comme des refus ferait
   * passer l'absence de question pour un non, et un site sans bandeau pour un
   * site que tout le monde refuse.
   *
   * Aucun pourcentage n'est rendu : le dénominateur dépend de la question
   * posée — performance du bandeau, ou couverture de la mesure.
   *
   * ⚠️ Rupture de série : ne se remplit qu'à partir de la mise en service.
   */
  consentDeclined: z.number(),
  /**
   * Sessions **terminées** n'ayant vu qu'une seule page — le numérateur du
   * taux de rebond.
   *
   * La définition est celle de Plausible : une visite est un rebond si le
   * visiteur n'a pas vu de seconde page. Sans seuil de temps, contrairement à
   * PostHog, qui exige en plus « moins de dix secondes et aucune interaction »
   * — deux signaux que la chaîne ne porte pas.
   */
  bounces: z.number(),
  /**
   * Sessions **terminées** ayant vu au moins une page — le dénominateur.
   *
   * ⚠️ **Diviser `bounces` par ceci, jamais par `sessions`.** Trois
   * populations en sont exclues :
   *
   * - les sessions **en cours** — dernier événement à moins de trente minutes
   *   de `to`. Elles montrent une page et en auront peut-être quatre ; les
   *   compter ferait lire la queue de la période comme un pic de rebond ;
   * - les sessions **commencées avant `from`**, symétriquement : leurs vues
   *   d'avant la fenêtre ne sont pas comptées, donc une visite profonde
   *   ressemblerait à un rebond. `startedAt` sur la ligne de session dit
   *   lesquelles ;
   * - les sessions **sans vue de page**, qui n'ont pas de page d'entrée dont
   *   on puisse être parti.
   *
   * Ne dépasse donc jamais `sessions`, et l'**égalité est un cas normal** :
   * sur une fenêtre passée dont aucune session ne déborde d'un côté ni de
   * l'autre, les trois exclusions sont vides. L'écart, quand il existe, n'est
   * pas une perte : c'est ce sur quoi le serveur refuse de se prononcer, et il
   * vaut la peine de l'afficher à côté du taux plutôt que de laisser croire
   * qu'il porte sur tout le trafic.
   *
   * À zéro, il n'y a pas de taux : une division sans dénominateur ne rend pas
   * zéro, elle ne rend rien.
   */
  settledSessions: z.number(),
  topPages: z.array(valueCountSchema),
});

export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

/** D'où vient une session. `null` en `name` pour `direct`, ou referrer illisible. */
export const sourceSchema = z.object({
  /**
   * `assistant` est à part de `search`, et ce n'est pas un détail de rangement :
   * un moteur envoie vers une page, un assistant a **déjà répondu** et n'envoie
   * qu'accessoirement. Les fondre ferait lire « la recherche m'apporte X
   * visites » en y comptant autre chose.
   */
  kind: z.enum(['direct', 'search', 'assistant', 'referral', 'internal']),
  name: z.string().nullable(),
  /**
   * Le même fait, écrit pour un humain : `Google`, `ChatGPT`, `Direct`,
   * `news.ycombinator.com`.
   *
   * **Il vient du serveur exprès.** La casse d'un nom propre est une
   * connaissance métier — `duckduckgo` ne se capitalise pas comme `google` — et
   * une table côté client aurait été une seconde définition de ce qu'est une
   * source, qui aurait divergé au premier moteur ajouté.
   */
  label: z.string(),
  /**
   * Le domaine qui porte l'**icône** de la provenance, ou `null`.
   *
   * À ne pas confondre avec `name`, et c'est toute la raison de ce champ :
   * `name` vaut `google` pour un moteur — un label d'hôte, que le relais de
   * favicons refuse parce que ce n'est pas un nom d'hôte. `host` vaut
   * `google.com`. Sur un `referral` ou un `internal`, les deux coïncident.
   *
   * Il vient du serveur pour la même raison que `label` : compléter `google` en
   * `google.com` côté client aurait recréé là-bas la liste des moteurs.
   *
   * `null` sur `direct` et sur un referrer illisible — une provenance sans
   * site, pas une icône introuvable.
   */
  host: z.string().nullable(),
});

export type Source = z.infer<typeof sourceSchema>;

/**
 * Une session, telle que `GET /analytics/sessions` la rend.
 *
 * Onze champs, et les absences sont aussi délibérées que les présences :
 * `durationMs` n'y est pas parce que les deux bornes y sont, `presences[]` non
 * plus parce que rien ne la demande encore, et `sessionId` est parti le jour
 * où `visitorAlias` est arrivé — stable d'un appel à l'autre, il aurait suffi à
 * recoller les alias de deux réponses.
 */
export const sessionRowSchema = z.object({
  /**
   * Le visiteur, sous une forme qui ne vaut **que dans cette réponse**.
   *
   * Un jeton opaque, tiré au hasard à chaque appel. Il permet une chose et une
   * seule : reconnaître que deux lignes viennent du même visiteur, à
   * l'intérieur d'une réponse. C'est ce qui rend les visiteurs uniques
   * calculables au grain qu'on veut — par jour, par semaine — sans que la clé
   * visiteur sorte du serveur et sans que celui-ci reprenne le découpage
   * temporel qu'il a rendu à l'affichage.
   *
   * ⚠️ **Ne jamais le persister ni le comparer entre deux réponses.** Deux
   * lectures de la même fenêtre rendent des alias différents ; un rapprochement
   * d'une réponse à l'autre ne rapproche rien.
   *
   * Il ne franchit pas la journée non plus, et pas seulement par convention :
   * la clé qu'il aliase tourne à minuit UTC, donc la même personne en porte une
   * autre le lendemain.
   */
  visitorAlias: z.string(),
  /**
   * Le début **réel**, même antérieur à `from`.
   *
   * La seule valeur de la réponse qui puisse sortir de la fenêtre. Comparé à
   * `from`, il dit si la session a été vue s'ouvrir ou si elle existait déjà.
   */
  startedAt: z.iso.datetime({ offset: true }),
  /**
   * Le dernier instant **observé**, jamais `to`.
   *
   * Une session encore ouverte au bord de la fenêtre n'est pas prolongée
   * jusqu'à la borne : la mesure ne doit pas dépendre du moment où on pose la
   * question.
   */
  endedAt: z.iso.datetime({ offset: true }),
  /**
   * Somme des présences **fermées**, en millisecondes.
   *
   * Sous-estime dès que `presencesStillOpen` est non nul. Ne jamais l'afficher
   * sans lui.
   */
  activeMs: z.number(),
  /** Vues de page **dans la fenêtre**. Peut valoir zéro. */
  pageViews: z.number(),
  /** Présences dont le `page_leave` n'est jamais arrivé. */
  presencesStillOpen: z.number(),
  /**
   * La page d'entrée **visible dans la fenêtre**, ou `null`.
   *
   * Sur une session tronquée, ce n'est pas la vraie page d'entrée mais celle où
   * la fenêtre nous a fait entrer.
   */
  entryPath: z.string().nullable(),
  /**
   * Par où la session s'est terminée — le miroir d'`entryPath`.
   *
   * `path` est la **dernière** page vue dans la fenêtre ; `outbound` l'origine
   * du **dernier** clic sortant, ou `null`.
   *
   * ⚠️ `outbound` à `null` ne dit **pas** que le visiteur est resté. Il dit
   * qu'aucun clic sortant n'a été vu : fermer l'onglet, taper une autre adresse
   * ou suivre un lien non capté se ressemblent tous depuis ici. D'où le libellé
   * « session terminée sur le site », jamais « visiteur resté ».
   *
   * Sur une session dont `settled` vaut `false`, « la dernière » veut dire « la
   * dernière qu'on ait vue » — pas la dernière qu'il y aura.
   */
  exit: z.object({
    path: z.string().nullable(),
    outbound: z.string().nullable(),
  }),
  /**
   * La session est-elle close — plus rien ne peut la rejoindre ?
   *
   * Rendu plutôt que déductible : la règle est « dernier événement à plus de
   * trente minutes de `to` », et ce seuil vit dans l'ingestion. Le recalculer
   * ici obligerait le lecteur à le recopier, où il divergerait le jour où il
   * change.
   *
   * C'est ce qui rend un **taux de rebond par page d'entrée** calculable chez
   * le lecteur : il faut écarter les sessions en cours du dénominateur,
   * exactement comme `settledSessions` le fait sur la fenêtre entière.
   */
  settled: z.boolean(),
  /**
   * `null` **n'est pas `direct`**.
   *
   * `null` veut dire « aucune vue de page, donc aucune provenance observable ».
   * `direct` est une observation : on a vu la page, le navigateur n'a pas donné
   * de referrer. Les confondre gonfle `direct` d'un bruit sans rapport avec
   * l'acquisition.
   */
  source: sourceSchema.nullable(),
  /**
   * La campagne qui a amené la visite, ou `null` — le cas ordinaire.
   *
   * Les trois UTM (`utm_source`, `utm_medium`, `utm_campaign`) normalisés par le
   * serveur — rognés, en minuscules — et **figés à l'ouverture de la session**.
   * Recharger une page avec d'autres paramètres ne les change pas : la campagne
   * décrit comment la visite a commencé, pas la dernière URL vue.
   *
   * ⚠️ À lire **à côté** de `source`, jamais à sa place. `source` dit d'où le
   * clic vient, la campagne dit ce qui a été acheté, et les deux se contredisent
   * régulièrement — une annonce rouverte depuis un signet arrive en `direct`
   * avec ses UTM intacts.
   *
   * Les trois champs sont nullables séparément : exiger le triplet écarterait
   * d'un classement les visites qui ne portent qu'un `utm_source`.
   */
  campaign: z
    .object({
      source: z.string().nullable(),
      medium: z.string().nullable(),
      name: z.string().nullable(),
    })
    .nullable(),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;

/**
 * `GET /v1/projects/:projectId/analytics/sessions` — le journal replié.
 *
 * Une ligne par session, datée, provenance déjà classée. C'est **la** source de
 * tout ce que le dashboard veut découper dans le temps ou grouper par
 * provenance.
 */
export const sessionsPageSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  sessions: z.array(sessionRowSchema),
});

export type SessionsPage = z.infer<typeof sessionsPageSchema>;

/** Le grain d'un classement géographique — les trois onglets de la carte. */
export const locationGrainSchema = z.enum(['country', 'region', 'city']);

export type LocationGrain = z.infer<typeof locationGrainSchema>;

/** Un endroit et son poids. */
export const locationRowSchema = z.object({
  /**
   * Le pays, **quel que soit le grain**, en ISO-3166-1 alpha-2.
   *
   * Il accompagne la région et la ville parce qu'un nom de ville ne suffit pas
   * à désigner un endroit : sans lui, le Paris du Texas et celui d'Île-de-France
   * seraient une seule ligne. C'est aussi la clé sur laquelle un planisphère se
   * joint.
   *
   * `null` est possible en théorie — une session peut porter une ville sans
   * pays si la base est incohérente — et ne doit pas faire tomber l'affichage.
   */
  countryCode: z.string().nullable(),
  /** La valeur du grain demandé. Au grain `country`, égale à `countryCode`. */
  value: z.string(),
  visitors: z.number(),
  sessions: z.number(),
});

export type LocationRow = z.infer<typeof locationRowSchema>;

/**
 * `GET /v1/projects/:projectId/analytics/locations` — d'où viennent les
 * visiteurs.
 *
 * ## Une route, trois grains
 *
 * `?grain=country|region|city` choisit ce que `value` porte. Les trois onglets
 * de la carte tapent donc la même route, et le planisphère aussi — figé sur
 * `country`. `?limit=` borne le classement (250 au plus, assez pour tous les
 * pays).
 *
 * ## Trois pièges de lecture, et ils comptent
 *
 * ⚠️ **`visitors` ne s'additionne pas.** Quelqu'un dont deux sessions résolvent
 * vers deux pays — VPN, déplacement, un mobile qui change de réseau — compte
 * dans les deux lignes. La somme de la colonne dépasse `visitors` (le total
 * ci-dessous), et **les parts ne font pas 100 %**.
 *
 * ⚠️ **C'est un classement tronqué, pas une décomposition.** Comme `topPages` :
 * au-delà de `limit`, la queue existe et n'est pas rendue.
 *
 * ⚠️ **`unresolved` change avec le grain.** C'est le nombre de visiteurs dont
 * la valeur *du grain demandé* est inconnue : une session peut avoir un pays
 * sans avoir de ville. L'afficher à côté du classement est le seul moyen de ne
 * pas faire passer une couverture partielle pour un total.
 *
 * ## Ce que la géolocalisation vaut
 *
 * Le pays est solide, la ville est une **estimation** : les bases gratuites
 * tournent autour de 75–85 % au grain ville. À présenter comme telle, sans
 * décimale et sans faux sérieux.
 */
export const locationsPageSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  grain: locationGrainSchema,
  rows: z.array(locationRowSchema),
  /**
   * Visiteurs distincts de la fenêtre, tous endroits confondus.
   *
   * Le dénominateur des parts, et il est rendu plutôt que calculé par somme
   * des lignes — précisément parce que cette somme serait fausse (voir
   * ci-dessus).
   */
  visitors: z.number(),
  /** Visiteurs dont la valeur du grain est inconnue. Jamais tus. */
  unresolved: z.number(),
});

export type LocationsPage = z.infer<typeof locationsPageSchema>;

/**
 * Le grain d'un classement par technologie.
 *
 * `device` et non `deviceType` : c'est du vocabulaire de produit dans une URL
 * publique, pas un nom de colonne.
 */
export const technologyGrainSchema = z.enum(['browser', 'os', 'device']);

export type TechnologyGrain = z.infer<typeof technologyGrainSchema>;

/**
 * Une ligne de classement par technologie.
 *
 * Pas de qualificateur, contrairement à la géographie : deux villes homonymes
 * ont besoin de leur pays pour ne pas fusionner, deux navigateurs du même nom
 * *sont* le même navigateur.
 *
 * Aucune version n'est rendue, et il n'y en a pas en base : la version mineure
 * est du bruit qui multiplie l'unicité d'une ligne, et celle du système est
 * fausse — Windows 11 se déclare « Windows NT 10.0 ».
 */
export const technologyRowSchema = z.object({
  value: z.string(),
  visitors: z.number(),
  sessions: z.number(),
});

export type TechnologyRow = z.infer<typeof technologyRowSchema>;

/**
 * Un classement par technologie et sa couverture.
 *
 * `unresolved` compte les visiteurs dont la valeur du grain est inconnue : la
 * longue traîne des navigateurs qu'on ne nomme pas. Un classement qui la
 * tairait se lirait comme s'il couvrait tout le trafic.
 *
 * ⚠️ **Au grain `device`, les tablettes sont sous-comptées.** Depuis iPadOS 13,
 * Safari envoie par défaut l'en-tête d'un Mac : la majorité des iPad est rangée
 * en `desktop`. L'information n'est pas dans la chaîne, c'est une limite du
 * mécanisme et pas de la mesure — au même titre que la ville, qui est une
 * estimation.
 */
export const technologyPageSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  grain: technologyGrainSchema,
  rows: z.array(technologyRowSchema),
  /** Le dénominateur des parts. Rendu, jamais reconstitué par somme. */
  visitors: z.number(),
  unresolved: z.number(),
});

export type TechnologyPage = z.infer<typeof technologyPageSchema>;
