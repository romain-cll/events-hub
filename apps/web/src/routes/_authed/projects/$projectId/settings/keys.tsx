import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronDownIcon, GlobeIcon, LockIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import type { ProjectKey } from '@events-hub/api-contract';

import { Field, fieldValue } from '#/components/field';
import { CopyButton, Snippet } from '#/components/onboarding';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { Skeleton } from '#/components/ui/skeleton';
import { INGESTION_ENDPOINT } from '#/lib/api';
import { parseOrigins } from '#/lib/origins';
import {
  createProjectKey,
  projectKeysQuery,
  revokeProjectKey,
} from '#/lib/projects';

/**
 * Les clés d'ingestion d'un projet : les lire, en créer, les révoquer.
 *
 * ## Ce que cet écran débloque
 *
 * Sans lui, une clé serveur ne s'obtient qu'en écrivant dans la base à la main.
 * C'est donc lui qui rend une source non-navigateur — un déploiement, un webhook
 * de paiement, une sonde — branchable par quelqu'un d'autre que nous.
 *
 * ## Il n'y a pas de bouton « Rotate », et ce n'est pas un oubli
 *
 * La rotation *est* « créer la remplaçante, migrer, révoquer l'ancienne ». Un
 * bouton unique cacherait l'étape du milieu — celle qui prend des jours et qui
 * appartient à celui qui déploie — et donnerait à croire que la bascule est
 * instantanée. Le dialogue de révocation dit l'ordre à la place.
 *
 * ## Ce que l'écran doit dire, et que l'API ne dira pas
 *
 * Une révocation est **silencieuse pour l'émetteur** : un site qui expédie encore
 * la clé cesse d'être mesuré sans erreur de son côté. C'est le genre de silence
 * qu'on ne découvre qu'en constatant un trou dans les courbes, d'où sa place en
 * toutes lettres dans la description et dans le dialogue.
 */
export const Route = createFileRoute(
  '/_authed/projects/$projectId/settings/keys',
)({
  component: Keys,
});

/**
 * La date d'une clé, à la journée.
 *
 * Pas d'heure : ce qu'on lit sur cette ligne est « depuis quand » ou « depuis
 * quand plus », jamais « à quelle minute ». `timeZone: 'UTC'` par cohérence avec
 * les écrans analytiques, qui datent tout en UTC — deux fuseaux dans le même
 * dashboard finiraient par se contredire d'une journée.
 */
const day = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Ce qu'un dialogue de création est en train de faire. */
type Creating =
  | { kind: 'browser' }
  /** `secret` non nul : la clé est créée, on la montre — voir `Reveal`. */
  | { kind: 'server'; secret: string | null };

function Keys() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const keys = useQuery(projectKeysQuery(projectId));

  const [creating, setCreating] = useState<Creating | null>(null);
  const [revoking, setRevoking] = useState<ProjectKey | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ['projects', projectId, 'keys'],
    });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Keys</CardTitle>
          <CardDescription>
            Revoking is instant and silent — a site still using a revoked key
            stops being measured without an error on its side.
          </CardDescription>

          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <PlusIcon />
                  Create key
                  <ChevronDownIcon className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem
                  className="flex-col items-start gap-0.5"
                  onSelect={() => {
                    setCreating({ kind: 'browser' });
                  }}
                >
                  <span>
                    Browser key{' '}
                    <span className="text-muted-foreground font-mono text-xs">
                      eh_pk_
                    </span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Public. Ships in your bundle, fenced by origin.
                  </span>
                </DropdownMenuItem>

                <DropdownMenuItem
                  className="flex-col items-start gap-0.5"
                  onSelect={() => {
                    setCreating({ kind: 'server', secret: null });
                  }}
                >
                  <span>
                    Server key{' '}
                    <span className="text-muted-foreground font-mono text-xs">
                      eh_sk_
                    </span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Secret. Shown once, at creation, and never again.
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>

        <CardContent>
          {keys.error ? (
            <Empty className="border">
              <EmptyTitle>Keys unavailable</EmptyTitle>
              <EmptyDescription className="whitespace-pre-line">
                {keys.error.message}
              </EmptyDescription>
            </Empty>
          ) : keys.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : keys.data.length === 0 ? (
            <Empty className="border">
              <EmptyTitle>No keys yet</EmptyTitle>
              <EmptyDescription>
                This project cannot receive anything until it has one.
              </EmptyDescription>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y">
              {keys.data.map((entry) => (
                <KeyRow key={entry.id} entry={entry} onRevoke={setRevoking} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {creating ? (
        <CreateDialog
          projectId={projectId}
          creating={creating}
          onCreating={setCreating}
          onCreated={() => void refresh()}
        />
      ) : null}

      {revoking ? (
        <RevokeDialog
          projectId={projectId}
          entry={revoking}
          onClose={() => {
            setRevoking(null);
          }}
          onRevoked={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

/**
 * Une clé, sur une ligne.
 *
 * `value` à `null` ne veut pas dire « pas de valeur » mais **« clé serveur »** :
 * la base n'en garde qu'un hash, et elle ne s'est montrée qu'à sa création. On
 * l'écrit plutôt que de laisser un blanc, sans quoi la ligne ressemble à un
 * chargement qui n'aurait pas fini.
 */
function KeyRow({
  entry,
  onRevoke,
}: {
  entry: ProjectKey;
  onRevoke: (key: ProjectKey) => void;
}) {
  const revoked = entry.revokedAt !== null;

  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
          revoked
            ? 'bg-muted text-muted-foreground'
            : entry.isSecret
              ? 'bg-muted text-foreground'
              : 'bg-primary/10 text-primary'
        }`}
      >
        {entry.isSecret ? (
          <LockIcon className="size-3.5" />
        ) : (
          <GlobeIcon className="size-3.5" />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={`truncate font-mono text-xs ${
              revoked ? 'text-muted-foreground line-through' : ''
            }`}
          >
            {entry.value ?? 'eh_sk_ ···· shown once, at creation'}
          </span>
          {entry.name ? <Badge variant="outline">{entry.name}</Badge> : null}
        </div>

        {/*
          Une clé serveur n'a pas d'origine, et la ligne ne doit pas laisser un
          « Accepted from » vide qui ferait croire à une configuration manquante.
        */}
        {entry.allowedOrigins.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs">Accepted from</span>
            {entry.allowedOrigins.map((origin) => (
              <Badge key={origin} variant="outline" className="font-mono">
                {origin}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">
            No origin check — it authenticates by being secret.
          </span>
        )}
      </div>

      {/*
        `outline` pour l'état actif plutôt qu'une pastille pleine : c'est l'état
        normal, il n'a rien à réclamer. Le plein est réservé à ce qui a changé.
      */}
      <Badge variant={revoked ? 'secondary' : 'outline'}>
        {revoked ? 'Revoked' : 'Active'}
      </Badge>

      <span className="text-muted-foreground w-40 text-right text-xs whitespace-nowrap">
        {revoked
          ? `Revoked ${day.format(new Date(entry.revokedAt ?? entry.createdAt))}`
          : `Created ${day.format(new Date(entry.createdAt))}`}
      </span>

      <div className="flex items-center justify-end gap-2">
        {entry.value !== null && !revoked ? (
          <CopyButton value={entry.value} label="Copy the API key" />
        ) : null}

        {revoked ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onRevoke(entry);
            }}
          >
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Créer une clé — et, pour une clé serveur, la montrer.
 *
 * Les deux natures partagent un dialogue parce qu'elles partagent tout sauf un
 * champ et une conséquence. Ce qui les sépare vraiment vient **après** la
 * création : une clé publique se relit dans la liste, une clé serveur ne se
 * relit jamais. D'où le second état, qui ne concerne qu'elle.
 */
function CreateDialog({
  projectId,
  creating,
  onCreating,
  onCreated,
}: {
  projectId: string;
  creating: Creating;
  onCreating: (creating: Creating | null) => void;
  onCreated: () => void;
}) {
  const [originsError, setOriginsError] = useState('');
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);

  const isSecret = creating.kind === 'server';
  const revealed = creating.kind === 'server' ? creating.secret : null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const name = fieldValue(form, 'name').trim();
    const parsed = parseOrigins(fieldValue(form, 'origins'));

    if (!isSecret) {
      if (parsed.invalid !== undefined) {
        setOriginsError(`“${parsed.invalid}” is not a valid site address.`);

        return;
      }

      if (parsed.origins.length === 0) {
        setOriginsError('Enter the address of the site you want to measure.');

        return;
      }
    }

    setOriginsError('');
    setFormError('');
    setPending(true);

    try {
      const key = await createProjectKey(projectId, {
        name: name || undefined,
        allowedOrigins: isSecret ? [] : (parsed.origins ?? []),
        isSecret,
      });

      onCreated();

      // Une clé publique se relit dans la liste : le dialogue n'a plus rien à
      // dire. Une clé serveur, non — on bascule sur sa seule apparition.
      if (isSecret) {
        onCreating({ kind: 'server', secret: key.value });
      } else {
        onCreating(null);
      }
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCreating(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {revealed === null ? (
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {isSecret ? 'New server key' : 'New browser key'}
              </DialogTitle>
              <DialogDescription>
                {isSecret
                  ? 'For anything that is not a browser — a deploy, a webhook, a probe. You will see it once.'
                  : 'It ships in your bundle and anyone can read it. Declare where it may send from.'}
              </DialogDescription>
            </DialogHeader>

            <Field
              label="Name"
              name="name"
              maxLength={64}
              placeholder={isSecret ? 'ci' : 'prod'}
              hint="Optional. Only to tell your keys apart."
            />

            {isSecret ? null : (
              <Field
                label="Accepted from"
                name="origins"
                placeholder="acme.com, staging.acme.com"
                error={originsError}
                hint="Separate several with a comma."
              />
            )}

            {formError ? (
              <p className="text-destructive text-sm whitespace-pre-line">
                {formError}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onCreating(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                Create key
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <Reveal
            secret={revealed}
            onDone={() => {
              onCreating(null);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * L'appel prêt à coller, la clé déjà dedans.
 *
 * `deployment` est pris en exemple parce que c'est le cas d'usage qui amène ici :
 * on vient de créer une clé serveur, et ce qu'on veut savoir est « comment je
 * m'en sers ». Le type est libre — le hub ne connaît aucun nom d'avance — mais un
 * exemple abstrait obligerait à en inventer un pour essayer.
 */
function curlFor(secret: string): string {
  return `NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

curl -X POST ${INGESTION_ENDPOINT} \\
  -H 'Content-Type: application/json' \\
  -d "{
    \\"apiKey\\": \\"${secret}\\",
    \\"type\\": \\"deployment\\",
    \\"occurredAt\\": \\"$NOW\\",
    \\"properties\\": { \\"release.tag\\": \\"v1.0.0\\" }
  }"`;
}

/**
 * La seule fois où une clé serveur est lisible.
 *
 * Le bouton de fermeture dit ce qu'il fait — « I saved it » et non « Close » —
 * parce que fermer est ici **irréversible** : la base n'a que le hash, et
 * personne, nous compris, ne peut retrouver cette valeur. L'avertissement est
 * au-dessus de la valeur, pas en dessous : après l'avoir copiée, on ne lit plus.
 *
 * L'appel complet est donné **ici** et pas seulement dans la documentation,
 * parce que c'est le seul instant où il peut l'être avec la vraie clé dedans.
 * Ailleurs il faudrait la recopier à la main, ce qui est exactement l'étape où
 * l'on se trompe.
 */
function Reveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Copy it now</DialogTitle>
        <DialogDescription>
          This is the only time this key is shown. Closing this dialog is final
          — we keep a hash, not the key, so it cannot be recovered.
        </DialogDescription>
      </DialogHeader>

      <div className="bg-muted flex items-center gap-2 rounded-md border p-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {secret}
        </code>
        <CopyButton value={secret} label="Copy the server key" />
      </div>

      <Snippet
        code={curlFor(secret)}
        label="Copy the request"
        caption="Try it — this sends a deployment event."
        wrap
      />

      <DialogFooter>
        <Button type="button" onClick={onDone}>
          I saved it
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Confirmer une révocation.
 *
 * Le dialogue existe pour une seule raison : dire **l'ordre**. Révoquer avant
 * d'avoir déployé la remplaçante coupe la mesure sans que le site s'en rende
 * compte, et c'est la seule erreur que cet écran peut vraiment prévenir.
 */
function RevokeDialog({
  projectId,
  entry,
  onClose,
  onRevoked,
}: {
  projectId: string;
  entry: ProjectKey;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const revoke = async () => {
    setError('');
    setPending(true);

    try {
      await revokeProjectKey(projectId, entry.id);
      onRevoked();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Something went wrong.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke this key?</DialogTitle>
          <DialogDescription>
            Anything still sending{' '}
            <span className="font-mono text-xs">
              {entry.value ?? 'this server key'}
            </span>{' '}
            stops immediately, and gets no error back. Create the replacement
            first, then revoke.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-destructive text-sm whitespace-pre-line">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void revoke()}
          >
            Revoke key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
