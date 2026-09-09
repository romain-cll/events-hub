import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ExternalLinkIcon, PlugIcon } from 'lucide-react';
import { useState } from 'react';

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
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { Skeleton } from '#/components/ui/skeleton';
import {
  authorizeStripe,
  disconnectStripe,
  integrationsQuery,
  rememberPendingProject,
  type Integration,
} from '#/lib/integrations';

/**
 * Les sources de données branchées sur le projet.
 *
 * ## Ce que cet écran débloque
 *
 * L'attribution du revenu. Le hub sait déjà relier un paiement à un parcours —
 * ce qui manquait était le moyen de brancher un compte sans écrire dans la base
 * à la main.
 *
 * ## Pourquoi « read-only » est affiché, et pas seulement respecté
 *
 * Brancher son compte de paiement à un outil tiers est le geste le plus engageant
 * qu'on demande ici. Montrer la portée accordée est la seule façon pour quelqu'un
 * de **constater** qu'on ne peut rien écrire chez lui, plutôt que d'avoir à nous
 * croire.
 *
 * Même raison pour l'identifiant du compte et le badge Test/Live : un projet
 * branché par erreur sur un compte de test afficherait un revenu plausible et
 * faux, et rien d'autre à l'écran ne le dirait.
 */
export const Route = createFileRoute(
  '/_authed/projects/$projectId/settings/integrations',
)({
  component: Integrations,
});

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function Integrations() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const integrations = useQuery(integrationsQuery(projectId));

  const [disconnecting, setDisconnecting] = useState<Integration | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const stripe = integrations.data?.find(
    ({ provider }) => provider === 'stripe',
  );

  /**
   * Quitte le dashboard pour Stripe.
   *
   * Le projet est retenu avant le départ : l'URL de retour est déclarée une
   * seule fois chez Stripe et ne peut pas le porter.
   */
  const connect = async () => {
    setConnecting(true);
    setFailure(null);

    try {
      const { url } = await authorizeStripe(projectId);

      rememberPendingProject(projectId);
      window.location.href = url;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setConnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Stripe</CardTitle>
          <CardDescription>
            Connect your Stripe account to see which visits produced revenue.
            We ask for read-only access and never write anything back.
          </CardDescription>

          {stripe && (
            <CardAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDisconnecting(stripe);
                }}
              >
                Disconnect
              </Button>
            </CardAction>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {integrations.isPending && <Skeleton className="h-16 w-full" />}

          {integrations.error && (
            <p className="text-destructive text-sm">
              {integrations.error.message}
            </p>
          )}

          {integrations.isSuccess &&
            (stripe ? (
              <Connected integration={stripe} />
            ) : (
              <Empty>
                <EmptyTitle>Not connected</EmptyTitle>
                <EmptyDescription>
                  Payments will appear in your event stream, and each one that
                  carries a visitor id will be attributed to the visit that
                  produced it.
                </EmptyDescription>
                <Button
                  type="button"
                  size="sm"
                  disabled={connecting}
                  onClick={() => {
                    void connect();
                  }}
                >
                  <PlugIcon />
                  {connecting ? 'Redirecting…' : 'Connect Stripe'}
                  <ExternalLinkIcon className="text-primary-foreground/70" />
                </Button>
              </Empty>
            ))}

          {failure && <p className="text-destructive text-sm">{failure}</p>}
        </CardContent>
      </Card>

      <DisconnectDialog
        integration={disconnecting}
        onClose={() => {
          setDisconnecting(null);
        }}
        onDone={() => {
          setDisconnecting(null);
          void queryClient.invalidateQueries({
            queryKey: ['projects', projectId, 'integrations'],
          });
        }}
        projectId={projectId}
      />
    </div>
  );
}

/** Ce qu'on montre d'un compte branché, et pourquoi ces trois-là. */
function Connected({ integration }: { integration: Integration }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="font-mono text-sm">{integration.externalAccountId}</span>

      {/* Le badge qui compte : un compte de test produit un revenu plausible et
          faux, et rien d'autre à l'écran ne le distinguerait d'un vrai. */}
      <Badge variant={integration.livemode ? 'default' : 'outline'}>
        {integration.livemode ? 'Live' : 'Test'}
      </Badge>

      <Badge variant="outline">{integration.scope}</Badge>

      <span className="text-muted-foreground text-sm">
        Connected {dateFormat.format(new Date(integration.connectedAt))}
      </span>
    </div>
  );
}

/**
 * La confirmation, parce que débrancher est silencieux pour tout le reste.
 *
 * Aucune erreur ne remonte nulle part ensuite : les paiements cessent
 * simplement d'arriver, et ça ne se voit qu'en constatant un trou dans le
 * revenu. C'est le même silence que la révocation d'une clé, et il se dit au
 * même endroit.
 */
function DisconnectDialog({
  integration,
  projectId,
  onClose,
  onDone,
}: {
  integration: Integration | null;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setFailure(null);

    try {
      await disconnectStripe(projectId);
      onDone();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={integration !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect Stripe?</DialogTitle>
          <DialogDescription>
            New payments stop arriving immediately, and nothing will say so —
            you would only notice it as a gap in revenue. Payments already
            ingested stay where they are.
          </DialogDescription>
        </DialogHeader>

        {failure && <p className="text-destructive text-sm">{failure}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              void confirm();
            }}
          >
            {pending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
