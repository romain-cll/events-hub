import type {
  AnalyticsSummary as WireAnalyticsSummary,
  CampaignRevenuePage as WireCampaignRevenuePage,
  EventsPage as WireEventsPage,
  Integration as WireIntegration,
  Invitation as WireInvitation,
  InvitationDetail as WireInvitationDetail,
  LocationsPage as WireLocationsPage,
  Member as WireMember,
  Organization as WireOrganization,
  Project as WireProject,
  ProjectIngestion as WireProjectIngestion,
  EventType as WireEventType,
  ProjectKey as WireProjectKey,
  SessionsPage as WireSessionsPage,
  TechnologyPage as WireTechnologyPage,
} from '@events-hub/api-contract';

import type { Auth } from './auth/auth';
import type { PublicIntegration } from './integrations/integrations.controller';
import type { ProjectEventType } from './event-types/event-type-registry.service';
import type { ListedProjectKey } from './projects/project-keys.service';
import type {
  AnalyticsSummary,
  LocationsPage,
  SessionsPage,
} from './features/analytics/analytics.service';
import type { TechnologyPage } from './features/analytics/analytics.service';
import type { EventsPage } from './features/events/events.service';
import type { CampaignRevenuePage } from './features/stripe/revenue.service';
import type { OrganizationRow } from './organizations/organizations.service';
import type { ProjectIngestion, ProjectRow } from './projects/projects.service';

/**
 * Test de conformité : ce que l'API rend est ce que le contrat promet.
 *
 * ## Ce qu'il ferme
 *
 * Le contrat HTTP a dérivé quatre fois sans que rien ne l'attrape, parce que la
 * sortie était décrite **deux fois, dans deux langages, sans lien** : une
 * interface TypeScript ici, un schéma Zod dans le dashboard. Personne ne
 * pouvait comparer les deux, donc personne ne le faisait — jusqu'à ce que trois
 * requêtes sur trois se révèlent périmées à l'écran.
 *
 * Ce fichier est le lien manquant. Renommer un champ d'`AnalyticsSummary`,
 * changer son type ou le supprimer casse `pnpm check-types` **dans l'éditeur**,
 * pas dans un navigateur trois semaines plus tard.
 *
 * ## Pourquoi il s'appelle `.spec.ts`
 *
 * Deux raisons qui se cumulent, et ce n'est pas un hasard de nommage.
 *
 * `tsconfig.build.json` exclut `**\/*spec.ts` : ce fichier est **le seul** du
 * projet à toucher `@events-hub/api-contract`, et il ne doit surtout pas entrer
 * dans le build. Le paquet est du TypeScript source, sans étape de compilation ;
 * l'inclure ferait de la racine du monorepo le `rootDir` de tsc, et la sortie
 * partirait dans `dist/apps/api/src/main.js` au lieu de `dist/main.js`. C'est
 * ce qui impose habituellement un build à un paquet partagé — et c'est ce qu'on
 * évite en n'important **que des types**, effacés à la compilation.
 *
 * La règle est tenue par `architecture.spec.ts`, qui refuse tout import de
 * valeur depuis ce paquet.
 *
 * Et comme Jest ramasse les `.spec.ts`, il faut au moins un test exécutable —
 * d'où le `describe` en bas, qui n'est là que pour ça.
 *
 * ## Ce qu'il n'attrape pas
 *
 * Les types décrivent la **forme**, pas la sérialisation réelle. Qu'un `Date`
 * devienne bien une chaîne ISO, qu'un `null` ne se transforme pas en
 * `undefined`, qu'un `numeric` Postgres ne remonte pas en texte : rien de tout
 * ça n'est visible ici. C'est le travail des assertions e2e, qui parsent les
 * vraies réponses HTTP contre les mêmes schémas — voir `expectMatchesContract`
 * dans `test/fixtures.ts`. Les deux mécanismes sont complémentaires, pas
 * redondants.
 */

/**
 * Le domaine vu depuis le fil : `Date` devient `string`.
 *
 * C'est **toute** la différence entre les deux descriptions, et c'est réel :
 * l'API manipule des `Date`, `JSON.stringify` les rend en ISO 8601, le client
 * reçoit des chaînes. Comparer les types sans cette conversion ferait échouer
 * chaque forme datée pour une raison qui n'est pas une erreur.
 *
 * La récursion traverse les tableaux et les objets. `Date` est testé **avant**
 * `object` — un `Date` est un objet, et l'ordre inverse le décomposerait en ses
 * méthodes.
 */
type Wire<T> = T extends Date
  ? string
  : T extends (infer Element)[]
    ? Wire<Element>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * L'assignabilité, dans les deux sens.
 *
 * Un seul sens ne suffirait pas : vérifier que le domaine est assignable au
 * contrat laisse passer un champ que le contrat promet et que l'API ne rend
 * pas ; l'inverse laisse passer un champ rendu mais non décrit. Les deux
 * ensemble forcent l'égalité.
 *
 * Les tuples autour des opérandes empêchent la distribution sur les unions —
 * sans eux, `Source | null` serait testé variante par variante et l'ensemble
 * passerait alors qu'il ne devrait pas.
 */
type Conforms<Wired, Contract> = [Wired] extends [Contract]
  ? [Contract] extends [Wired]
    ? true
    : false
  : false;

/**
 * Le déclencheur : `Assert` n'accepte que `true`.
 *
 * Une divergence rend `false`, qui ne satisfait pas la contrainte, et tsc
 * refuse le fichier. Les alias sont **exportés** pour deux raisons : ils ne
 * sont pas signalés comme inutilisés, et un import ailleurs révélerait
 * immédiatement lequel a cassé.
 */
type Assert<T extends true> = T;

export type OrganizationConforms = Assert<
  Conforms<Wire<OrganizationRow>, WireOrganization>
>;
export type ProjectConforms = Assert<Conforms<Wire<ProjectRow>, WireProject>>;
export type ProjectIngestionConforms = Assert<
  Conforms<Wire<ProjectIngestion>, WireProjectIngestion>
>;
export type ProjectKeyConforms = Assert<
  Conforms<Wire<ListedProjectKey>, WireProjectKey>
>;
export type AnalyticsSummaryConforms = Assert<
  Conforms<Wire<AnalyticsSummary>, WireAnalyticsSummary>
>;
export type SessionsPageConforms = Assert<
  Conforms<Wire<SessionsPage>, WireSessionsPage>
>;
export type EventsPageConforms = Assert<
  Conforms<Wire<EventsPage>, WireEventsPage>
>;
export type EventTypeConforms = Assert<
  Conforms<Wire<ProjectEventType>, WireEventType>
>;
export type IntegrationConforms = Assert<
  Conforms<Wire<PublicIntegration>, WireIntegration>
>;
export type LocationsPageConforms = Assert<
  Conforms<Wire<LocationsPage>, WireLocationsPage>
>;
export type TechnologyPageConforms = Assert<
  Conforms<Wire<TechnologyPage>, WireTechnologyPage>
>;
export type CampaignRevenuePageConforms = Assert<
  Conforms<Wire<CampaignRevenuePage>, WireCampaignRevenuePage>
>;

/**
 * Les deux formes qui ne viennent pas de nos services.
 *
 * Membres et invitations sont servis par le plugin `organization`, pas par un
 * contrôleur d'ici : il n'y a donc pas de type de service à confronter. Le
 * pendant est le type que **le plugin lui-même infère** de sa configuration, et
 * c'est lui qu'on prend comme source.
 *
 * C'est ce qui autorise `members.ts` à exister dans le contrat malgré la règle
 * « pas `/v1/auth/*` » : la forme n'y est pas recopiée de mémoire, elle est
 * tenue. Changer `schema.member` dans `auth.ts`, ou monter le plugin d'une
 * version qui renomme un champ, casse ici.
 *
 * ⚠️ Ce que ça ne couvre pas : la sérialisation réelle. Le plugin manipule des
 * `Date` en mémoire — `Wire<>` fait la conversion attendue, mais que le JSON
 * sortant la respecte est vérifié en e2e, contre les mêmes schémas.
 */
type ListMembers = Awaited<ReturnType<Auth['api']['listMembers']>>;
type ListInvitations = Awaited<ReturnType<Auth['api']['listInvitations']>>;

type PluginMember = ListMembers['members'][number];

/**
 * Le seul champ où le plugin se trompe sur lui-même.
 *
 * Il déclare `user.image` en `string | undefined`. Sa propre requête le lit dans
 * la colonne `users.image`, qui est nullable : ce qui sort est `null`, et
 * `JSON.stringify` conserve `null` — la clé est bien là, avec cette valeur.
 * Décrire le contrat d'après le type ferait échouer la lecture de tout membre
 * sans avatar, c'est-à-dire de presque tous.
 *
 * L'écart a été trouvé par l'e2e, qui parse la vraie réponse ; les deux
 * mécanismes se corrigent l'un l'autre, ce qui est exactement leur raison
 * d'être commune. On garde donc l'assertion sur **tous les autres champs** — un
 * renommage, un ajout, une disparition cassent toujours — et on nomme ici
 * l'unique correction, plutôt que d'abandonner le lien pour un champ.
 *
 * ⚠️ Si une version du plugin corrige sa déclaration en `string | null`, ce
 * `Omit` deviendra inutile sans rien casser. C'est voulu : il ne doit pas être
 * ce qui empêche de s'en apercevoir. La vérification qui le signalera est
 * l'e2e, pas celle-ci.
 */
type ObservedMember = Omit<PluginMember, 'user'> & {
  user: Omit<PluginMember['user'], 'image'> & { image: string | null };
};

export type MemberConforms = Assert<Conforms<Wire<ObservedMember>, WireMember>>;
export type InvitationConforms = Assert<
  Conforms<Wire<ListInvitations[number]>, WireInvitation>
>;

/**
 * La lecture par le lien rend trois champs de plus — d'où un second schéma.
 *
 * Ce sont eux qui permettent à l'écran d'invitation de nommer l'organisation :
 * l'invité n'en est pas encore membre, et aucune de ses autres requêtes ne la
 * lui apprendrait.
 */
type GetInvitation = Awaited<ReturnType<Auth['api']['getInvitation']>>;

export type InvitationDetailConforms = Assert<
  Conforms<Wire<GetInvitation>, WireInvitationDetail>
>;

describe('conformité du contrat', () => {
  it('tient à la compilation, pas à l’exécution', () => {
    // Les assertions ci-dessus sont vérifiées par `pnpm check-types`. Ce test
    // n'existe que parce que Jest refuse un fichier `.spec.ts` sans assertion —
    // et le nom `.spec.ts` est ce qui sort ce fichier du build.
    expect(true).toBe(true);
  });
});
