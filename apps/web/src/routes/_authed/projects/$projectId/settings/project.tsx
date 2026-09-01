import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Trash2Icon } from 'lucide-react';
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
import { Input } from '#/components/ui/input';
import { Skeleton } from '#/components/ui/skeleton';
import { UNREACHABLE } from '#/lib/auth-errors';
import { organizationsQuery } from '#/lib/organizations';
import { deleteProject, projectsQuery, renameProject } from '#/lib/projects';

/**
 * Le nom du projet, et sa suppression.
 *
 * ## Renommer ne touche à rien d'autre
 *
 * Ni les clés, ni leurs origines, ni les événements déjà collectés : tout cela
 * ne connaît que `projectId`. C'est dit dans la description parce que la crainte
 * inverse est la raison pour laquelle on n'ose pas renommer.
 *
 * ## Supprimer demande d'écrire le nom
 *
 * Pas par cérémonie : la confirmation par frappe est ce qui distingue « je veux
 * supprimer *ce* projet » de « j'ai cliqué ». Les événements partent avec, et
 * l'API ne les garde nulle part — la cascade est explicite côté serveur
 * (`ProjectsService.remove`) et il n'y a pas de corbeille.
 */
export const Route = createFileRoute(
  '/_authed/projects/$projectId/settings/project',
)({
  component: ProjectSettings,
});

function ProjectSettings() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const projects = useQuery(projectsQuery());
  const organizations = useQuery(organizationsQuery());

  const [fieldError, setFieldError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const project = projects.data?.find(({ id }) => id === projectId);
  const organization = organizations.data?.find(
    ({ id }) => id === project?.organizationId,
  );

  const rename = useMutation({
    mutationFn: (name: string) => renameProject(projectId, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: async () => {
      // Le cache entier plutôt que la seule liste : tout ce qui est indexé sur
      // ce `projectId` — clés, analytics, événements — vient de disparaître, et
      // `/projects` réaiguille aussitôt vers ce qui reste.
      queryClient.clear();
      setDeleting(false);
      await navigate({ to: '/projects', replace: true });
    },
  });

  if (!project || !organization) {
    return <Skeleton className="h-64 w-full" />;
  }

  const canManage = organization.role !== 'member';

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = fieldValue(new FormData(event.currentTarget), 'name').trim();

    if (!name) {
      setFieldError('Give your project a name.');

      return;
    }

    setFieldError('');
    rename.mutate(name);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Project name</CardTitle>
          <CardDescription>
            Usually the name of the site you are measuring. It changes nothing
            about the keys or the events already collected.
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
                maxLength={128}
                disabled={!canManage}
                defaultValue={project.name}
                hint={
                  canManage
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

            {canManage && (
              <Button type="submit" loading={rename.isPending}>
                Save
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      {canManage && (
        <Card className="border-destructive/35">
          <CardHeader>
            <CardTitle className="text-destructive">Danger zone</CardTitle>
          </CardHeader>

          <CardContent className="px-0">
            <div className="flex flex-wrap items-center gap-4 border-t px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Delete this project</span>
                <span className="text-muted-foreground text-2xs">
                  Its keys stop working and every event it collected is erased.
                  There is no undo.
                </span>
              </div>
              <Button
                variant="destructive-outline"
                onClick={() => {
                  setConfirmation('');
                  setDeleting(true);
                }}
              >
                <Trash2Icon />
                Delete project
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-100">
          <DialogHeader>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>
              Its keys and every event it collected go with it, for everyone in{' '}
              {organization.name}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="delete-confirmation"
              className="text-sm leading-none font-medium"
            >
              Type{' '}
              <span className="font-mono font-semibold">{project.name}</span> to
              confirm
            </label>
            <Input
              id="delete-confirmation"
              value={confirmation}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
            />
          </div>

          {remove.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="whitespace-pre-line">
                {remove.error instanceof Error
                  ? remove.error.message
                  : UNREACHABLE}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleting(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmation.trim() !== project.name}
              loading={remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
