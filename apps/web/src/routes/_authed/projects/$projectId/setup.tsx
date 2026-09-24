import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';

import { CopyButton, Snippet, Steps } from '#/components/onboarding';
import type { ProjectKey } from '@events-hub/api-contract';

import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyTitle,
} from '#/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '#/components/ui/input-group';
import { Skeleton } from '#/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs';
import { INGESTION_ENDPOINT, SDK_SCRIPT_URL } from '#/lib/api';
import {
  activeKey,
  activeServerKey,
  projectKeysQuery,
  projectsQuery,
} from '#/lib/projects';

/**
 * Étape 2 sur 3 — la clé, le snippet, et rien à ressaisir.
 *
 * Tout ce qu'il fallait demander l'a été à l'étape précédente : cet écran ne
 * pose aucune question, il **donne**. C'est la seule étape que la personne ne
 * traverse pas dans le dashboard mais dans son propre éditeur, et la seule
 * chose qui compte est qu'elle en reparte avec **une** ligne copiée.
 *
 * ## La balise d'abord, le paquet ensuite
 *
 * Le chemin par défaut est un `<script>` avec la clé déjà écrite dedans, comme
 * chez tout le monde — parce que la majorité des sites qu'on mesure n'ont pas
 * de bundler, et que ceux qui en ont un savent traduire une balise en import.
 * L'inverse n'est pas vrai : demander « pnpm add » à quelqu'un sur WordPress,
 * c'est lui dire non.
 *
 * Le paquet reste offert, replié sous la balise. Ce n'est pas une relégation :
 * dans une application avec bundler il est meilleur — typé, sans requête
 * réseau supplémentaire au chargement. Il est simplement moins fréquent.
 */
export const Route = createFileRoute('/_authed/projects/$projectId/setup')({
  component: Setup,
});

/**
 * La balise, avec la clé déjà dedans. C'est le chemin par défaut.
 *
 * ## Une ligne, une valeur à recopier
 *
 * L'adresse d'ingestion n'y figure pas, et son absence est le sujet. Le script
 * est servi par le hub lui-même, donc il la déduit de son propre `src` — un
 * second attribut à recopier serait une seconde occasion de se tromper, et
 * celle-là échoue **sans message** : le hub ne répond rien à qui ne l'atteint
 * pas.
 *
 * ## `defer` et pas `async`
 *
 * `async` exécute dès que le fichier est là, donc parfois avant que le document
 * soit parcouru. Les collecteurs branchent des écouteurs sur des nœuds qui
 * n'existeraient pas encore. `defer` attend le parcours, ne bloque pas le rendu,
 * et garantit que la première vue de page est émise sur une page complète.
 */
function scriptTagFor(apiKey: string): string {
  return `<script defer src="${SDK_SCRIPT_URL}" data-api-key="${apiKey}"></script>`;
}

/**
 * L'autre chemin : le paquet, pour une application qui a déjà un bundler.
 *
 * L'endpoint vient d'`INGESTION_ENDPOINT`, donc de la configuration : écrire
 * `http://localhost:3003` en dur donnerait, le jour du déploiement, un snippet
 * qui a l'air juste et qui n'envoie nulle part.
 */
function moduleSnippetFor(apiKey: string): string {
  return `import { Analytics } from '@events-hub/sdk';

const analytics = new Analytics({
  apiKey: '${apiKey}',
  endpoint: '${INGESTION_ENDPOINT}',
});

analytics.start();`;
}

/**
 * L'appel qu'une source serveur fait — un déploiement, ici.
 *
 * ## La clé n'y est pas, et c'est la bonne recette
 *
 * On ne peut pas l'y mettre : la base n'en garde qu'un hash, elle est
 * irrécupérable après sa création. La contrainte tombe bien — un secret serveur
 * ne se colle pas dans un fichier versionné, il passe par l'environnement. Le
 * snippet enseigne donc `$EVENTS_HUB_KEY`, ce qu'il faudrait écrire de toute
 * façon.
 *
 * ## Le corps est celui de `docs/ingestion.md`
 *
 * Volontairement identique, au caractère près. Deux formulations de la même
 * requête divergeraient au premier changement, et c'est celle qu'on ne relit
 * jamais qui resterait fausse.
 */
function deploymentCurl(): string {
  return `NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

curl -X POST ${INGESTION_ENDPOINT} \\
  -H 'Content-Type: application/json' \\
  -d "{
    \\"apiKey\\": \\"$EVENTS_HUB_KEY\\",
    \\"type\\": \\"deployment\\",
    \\"occurredAt\\": \\"$NOW\\",
    \\"properties\\": { \\"release.tag\\": \\"v1.0.0\\" }
  }"`;
}

/**
 * La même chose, en étape GitHub Actions.
 *
 * `github.ref_name` plutôt qu'un numéro inventé : c'est la seule valeur que le
 * CI connaît déjà et qui désigne ce qui vient d'être déployé. Un exemple qui
 * laisse `v1.0.0` en dur se copie tel quel, et toutes les lignes du graphique
 * portent alors la même version.
 */
function deploymentAction(): string {
  return `- name: Tell the hub
  run: |
    curl -sS -X POST ${INGESTION_ENDPOINT} \\
      -H 'Content-Type: application/json' \\
      -d "{
        \\"apiKey\\": \\"$EVENTS_HUB_KEY\\",
        \\"type\\": \\"deployment\\",
        \\"occurredAt\\": \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\",
        \\"properties\\": { \\"release.tag\\": \\"\${{ github.ref_name }}\\" }
      }"
  env:
    EVENTS_HUB_KEY: \${{ secrets.EVENTS_HUB_KEY }}`;
}

function Setup() {
  const { projectId } = Route.useParams();

  const projects = useQuery(projectsQuery());
  const keys = useQuery(projectKeysQuery(projectId));

  const project = projects.data?.find(({ id }) => id === projectId);
  const key = keys.data && activeKey(keys.data);
  const serverKey = keys.data && activeServerKey(keys.data);
  const error = keys.error ?? projects.error;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <Steps current={2} />

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Install the SDK
        </h1>
        <p className="text-muted-foreground text-sm">
          {project
            ? `${project.name} is ready to receive events. One line to copy.`
            : 'One line to copy.'}
        </p>
      </div>

      {error ? (
        <Empty className="border">
          <EmptyTitle>Setup unavailable</EmptyTitle>
          <EmptyDescription className="whitespace-pre-line">
            {error.message}
          </EmptyDescription>
        </Empty>
      ) : keys.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          {/*
            Deux onglets, et pas deux blocs l'un sous l'autre. La majorité des
            projets n'a qu'un site à mesurer : lui poser une recette serveur au
            même niveau que la balise la ferait hésiter là où il n'y a pas à
            hésiter. Le choix, lui, ne coûte rien à qui ne le regarde pas.

            Ils sont **dans** l'écran d'onboarding et pas ailleurs parce que
            c'est ici qu'on vient quand on se demande comment envoyer quelque
            chose — l'entrée « Setup » de la barre latérale mène là, à vie, bien
            après que les trois étapes sont passées.
          */}
          <Tabs defaultValue="browser" className="gap-6">
            <TabsList>
              <TabsTrigger value="browser">Browser</TabsTrigger>
              <TabsTrigger value="server">Server</TabsTrigger>
            </TabsList>

            <TabsContent value="browser" className="flex flex-col gap-6">
              {!key ? (
                <Empty className="border">
                  <EmptyTitle>No active browser key</EmptyTitle>
                  <EmptyDescription>
                    Every browser key on this project has been revoked, so there
                    is nothing to install on a site.
                  </EmptyDescription>

                  <EmptyContent>
                    <Button asChild variant="outline">
                      <Link
                        to="/projects/$projectId/settings/keys"
                        params={{ projectId }}
                      >
                        Create a key
                      </Link>
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>Your API key</CardTitle>
                      <CardDescription>
                        It ships in your bundle and anyone can read it — that is
                        its job. It names a project, it opens nothing.
                      </CardDescription>
                    </CardHeader>

                    <CardContent className="flex flex-col gap-3">
                      <InputGroup>
                        <InputGroupInput
                          readOnly
                          value={key.value}
                          aria-label="API key"
                          onFocus={(event) => {
                            event.currentTarget.select();
                          }}
                        />
                        <InputGroupAddon align="inline-end">
                          <CopyButton
                            value={key.value}
                            label="Copy the API key"
                          />
                        </InputGroupAddon>
                      </InputGroup>

                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-muted-foreground">
                          Accepted from
                          {key.allowedOrigins.length > 1 ? ':' : ''}
                        </span>
                        {key.allowedOrigins.map((origin) => (
                          <Badge key={origin} variant="outline">
                            {origin}
                          </Badge>
                        ))}
                      </div>

                      {/*
                Dit ici plutôt qu'omis : une origine non déclarée ne produit
                aucune erreur visible — l'API répond 204 et n'écrit rien. C'est
                exactement le genre de silence qui fait chercher le bug dans le
                snippet pendant une heure.
              */}
                      <p className="text-muted-foreground text-sm">
                        Events sent from anywhere else are dropped silently,
                        with no error on your side.
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Add it to your site</CardTitle>
                      <CardDescription>
                        Paste this into your <code>&lt;head&gt;</code>, on every
                        page you want to measure. Nothing to install, nothing to
                        configure — your key is already in it.
                      </CardDescription>
                    </CardHeader>

                    <CardContent className="flex flex-col gap-5">
                      <Snippet
                        code={scriptTagFor(key.value)}
                        label="Copy the script tag"
                        wrap
                      />

                      <p className="text-muted-foreground text-sm">
                        It collects page views, clicks, form submits, outbound
                        clicks and page leaves on its own. For your own events,
                        call{' '}
                        <code>
                          window.eventsHub.track(&apos;signed_up&apos;)
                        </code>
                        .
                      </p>

                      {/*
                Replié, mais présent. Le paquet npm est le bon chemin pour une
                application qui a déjà un bundler — le SDK y est typé, et il
                n'y a pas de requête réseau de plus au chargement. Ce n'est
                simplement pas le cas le plus fréquent, et le mettre au même
                niveau que la balise ferait hésiter là où il n'y a pas à
                hésiter.
              */}
                      <details className="group">
                        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm select-none">
                          Using a bundler? Install the package instead
                        </summary>

                        <div className="mt-4 flex flex-col gap-4">
                          <Snippet
                            code="pnpm add @events-hub/sdk"
                            label="Copy the install command"
                            caption="Install"
                          />

                          <Snippet
                            code={moduleSnippetFor(key.value)}
                            label="Copy the module snippet"
                            caption="Start collecting"
                          />
                        </div>
                      </details>
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>

            <TabsContent value="server">
              <ServerSetup projectId={projectId} serverKey={serverKey} />
            </TabsContent>
          </Tabs>

          <div className="flex items-center gap-3">
            {/*
              Sans `replace`, à l'inverse de l'arrivée sur cet écran : revenir
              en arrière depuis l'attente doit ramener **ici**, à la clé et au
              snippet. C'est le seul endroit où ils sont affichés, et c'est
              exactement ce qu'on veut relire quand rien n'arrive.
            */}
            <Button asChild>
              <Link to="/projects/$projectId/waiting" params={{ projectId }}>
                Next
              </Link>
            </Button>

            <Button asChild variant="ghost">
              <Link to="/projects">Back to projects</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * L'onglet Server : comment une source qui n'est pas un navigateur envoie.
 *
 * ## Pourquoi il existe
 *
 * Sans lui, la recette n'était joignable qu'à deux endroits inatteignables pour
 * un client — la documentation de notre propre dépôt, et le dialogue de
 * révélation de la clé, qui ne s'affiche **qu'une fois**. Quelqu'un qui a créé
 * sa clé la semaine dernière n'avait rien à lire.
 *
 * ## Le déploiement comme exemple
 *
 * C'est le seul type non-navigateur que le dashboard sait exploiter aujourd'hui
 * — il pose un repère sur la courbe des visiteurs. Prendre un exemple abstrait
 * obligerait le lecteur à en inventer un pour essayer, et le sien ne
 * s'afficherait nulle part.
 *
 * Le `type` reste libre : rien ici ne le contraint, et le hub n'en connaît
 * aucun d'avance.
 */
function ServerSetup({
  projectId,
  serverKey,
}: {
  projectId: string;
  serverKey: ProjectKey | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Send from a server</CardTitle>
        <CardDescription>
          A deploy, a webhook, a probe — anything without a browser. No{' '}
          <code>Origin</code> to declare, and no session: these events have no
          visitor, so they never move your visitor counts.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {serverKey ? (
          <p className="text-muted-foreground text-sm">
            Put your server key in <code>EVENTS_HUB_KEY</code>. This
            project&apos;s most recent one is{' '}
            <Badge variant="outline">{serverKey.name ?? 'unnamed'}</Badge> — if
            you no longer have its value, create a replacement and revoke it.
          </p>
        ) : (
          /*
            Sans clé serveur la recette ne sert à rien : on le dit avant de la
            montrer, plutôt que de laisser copier un appel qui rendra 401.
          */
          <div className="flex flex-col items-start gap-3">
            <p className="text-muted-foreground text-sm">
              This project has no server key yet. Create one first — you will
              see its value once, and never again.
            </p>

            <Button asChild variant="outline" size="sm">
              <Link
                to="/projects/$projectId/settings/keys"
                params={{ projectId }}
              >
                Create a server key
              </Link>
            </Button>
          </div>
        )}

        <Snippet
          code={deploymentCurl()}
          label="Copy the request"
          caption="Try it from your terminal"
          wrap
        />

        <Snippet
          code={deploymentAction()}
          label="Copy the GitHub Actions step"
          caption="Or send it from your pipeline"
          wrap
        />

        {/*
          Dit ici parce que c'est la question suivante, et qu'elle n'a pas de
          réponse évidente : `release.tag` est la seule propriété que le
          graphique lit. Le reste de ce qu'on envoie est conservé intact et
          consultable dans l'explorateur, mais n'apparaît pas sur la courbe.
        */}
        <p className="text-muted-foreground text-sm">
          <code>release.tag</code> is what the analytics chart shows on the day
          of the deploy. Anything else you send is kept and readable in Events.
        </p>
      </CardContent>
    </Card>
  );
}
