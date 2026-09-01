import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Field, fieldValue } from '#/components/field';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Button } from '#/components/ui/button';
import {
  Card,
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
import { Skeleton } from '#/components/ui/skeleton';
import { UNREACHABLE } from '#/lib/auth-errors';
import { leaveOrganization } from '#/lib/members';
import { organizationsQuery, renameOrganization } from '#/lib/organizations';
import { projectsQuery } from '#/lib/projects';

/**
 * Le nom de l'organisation, et les deux gestes irréversibles.
 *
 * ## Ce que cet écran ne montre pas
 *
 * Le `slug`. Le plugin l'exige et la colonne est unique, mais il n'apparaît
 * dans aucune URL — les routes désignent les projets par leur id, et l'accès se
 * vérifie contre l'appartenance. L'afficher inviterait à s'en servir, et
 * construire une adresse à partir de lui exposerait une seconde façon de
 * désigner une organisation, qu'il faudrait alors sécuriser aussi.
 *
 * ## Pourquoi « Delete » est souvent inerte
 *
 * `projects.organizationId` est en `onDelete: 'restrict'` : Postgres refuse de
 * supprimer une organisation qui possède encore des projets, et le plugin n'en
 * sait rien — il tenterait, et l'erreur de contrainte remonterait telle quelle.
 * Le bouton le dit **avant**, avec le compte de ce qui bloque.
 */
export const Route = createFileRoute(
  '/_authed/projects/$projectId/settings/organization',
)({
  component: OrganizationSettings,
});

function OrganizationSettings() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const projects = useQuery(projectsQuery());
  const organizations = useQuery(organizationsQuery());

  const [fieldError, setFieldError] = useState('');
  const [leaving, setLeaving] = useState(false);

  const project = projects.data?.find(({ id }) => id === projectId);
  const organization = organizations.data?.find(
    ({ id }) => id === project?.organizationId,
  );

  const rename = useMutation({
    mutationFn: (name: string) =>
      renameOrganization({ organizationId: organization!.id, name }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['organizations'] }),
  });

  const leave = useMutation({
    mutationFn: () => leaveOrganization(organization!.id),
    onSuccess: async () => {
      // La session reste valide, mais l'accès aux projets de cette organisation
      // vient de disparaître : rester ici afficherait un écran qui répondra 404.
      // `/projects` réaiguille vers ce qui reste, ou vers la création.
      queryClient.clear();
      setLeaving(false);
      await navigate({ to: '/projects', replace: true });
    },
  });

  if (!organization) {
    return <Skeleton className="h-64 w-full" />;
  }

  const owned = (projects.data ?? []).filter(
    ({ organizationId }) => organizationId === organization.id,
  );

  const canRename = organization.role !== 'member';
  const canDelete = organization.role === 'owner' && owned.length === 0;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = fieldValue(new FormData(event.currentTarget), 'name').trim();

    if (!name) {
      setFieldError('Give your organization a name.');

      return;
    }

    setFieldError('');
    rename.mutate(name);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Organization name</CardTitle>
          <CardDescription>
            Shown in the switcher and on every invitation you send.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            noValidate
            onSubmit={submit}
            className="flex flex-col items-start gap-4"
          >
            <div className="w-full max-w-sm">
              <Field
                label="Name"
                name="name"
                required
                maxLength={64}
                disabled={!canRename}
                defaultValue={organization.name}
                hint={
                  canRename
                    ? undefined
                    : 'Only an owner or an admin can rename it.'
                }
                error={fieldError}
              />
            </div>

            {rename.error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription className="whitespace-pre-line">
                  {rename.error instanceof Error
                    ? rename.error.message
                    : UNREACHABLE}
                </AlertDescription>
              </Alert>
            )}

            {canRename && (
              <Button type="submit" loading={rename.isPending}>
                Save
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/35">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col px-0">
          <div className="flex flex-wrap items-center gap-4 border-t px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">
                Leave {organization.name}
              </span>
              <span className="text-muted-foreground text-2xs">
                You lose access to its {owned.length} project
                {owned.length === 1 ? '' : 's'}. The projects stay.
              </span>
            </div>
            <Button
              variant="destructive-outline"
              onClick={() => {
                setLeaving(true);
              }}
            >
              Leave
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">Delete organization</span>
              <span className="text-muted-foreground text-2xs">
                {organization.role !== 'owner'
                  ? 'Only an owner can delete it.'
                  : owned.length > 0
                    ? `Delete its ${String(owned.length)} project${owned.length === 1 ? '' : 's'} first — an organization that still owns projects cannot be deleted.`
                    : 'Its members and pending invitations go with it.'}
              </span>
            </div>
            <Button variant="destructive-outline" disabled={!canDelete}>
              Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={leaving} onOpenChange={setLeaving}>
        <DialogContent className="sm:max-w-100">
          <DialogHeader>
            <DialogTitle>Leave {organization.name}?</DialogTitle>
            <DialogDescription>
              You lose access to its {owned.length} project
              {owned.length === 1 ? '' : 's'} right away. Someone with an owner
              role has to invite you back.
            </DialogDescription>
          </DialogHeader>

          {leave.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="whitespace-pre-line">
                {leave.error instanceof Error
                  ? leave.error.message
                  : UNREACHABLE}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setLeaving(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={leave.isPending}
              onClick={() => {
                leave.mutate();
              }}
            >
              Leave organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
