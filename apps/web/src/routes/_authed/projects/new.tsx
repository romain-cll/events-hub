import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';

import { CreateProjectForm } from '#/components/create-project-form';
import { Steps } from '#/components/onboarding';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { Skeleton } from '#/components/ui/skeleton';
import { organizationsQuery } from '#/lib/organizations';

/**
 * Étape 1 sur 3 — nommer le projet et dire d'où viendront les événements.
 *
 * ## Ce que cet écran garde en propre
 *
 * Le formulaire vit dans `CreateProjectForm`, partagé avec le dialogue des
 * réglages. Ici, il reste **le parcours** : les trois temps annoncés en tête, et
 * l'enchaînement sur l'installation. C'est la seule différence entre les deux
 * appelants, et c'est celle qui compte — on ne crée pas un projet pour la même
 * raison quand on découvre le produit et quand on en ajoute un cinquième.
 *
 * ## L'organisation d'accueil
 *
 * La première de la liste. C'était sans conséquence tant qu'un compte n'en avait
 * qu'une — elle naît à l'inscription, et rien n'en créait d'autre.
 *
 * ⚠️ Ce n'est plus le cas : les invitations et le sélecteur en amènent
 * désormais plusieurs, et cet écran déposera toujours dans la première par ordre
 * alphabétique. Le dialogue des réglages, lui, dépose dans celle qu'on regarde —
 * il connaît sa cible. Ici il faudrait un sélecteur, ou un paramètre d'URL ; en
 * attendant, le nom est affiché en clair sous le champ plutôt que deviné en
 * silence.
 */
export const Route = createFileRoute('/_authed/projects/new')({
  component: NewProject,
});

function NewProject() {
  const navigate = useNavigate();
  const organizations = useQuery(organizationsQuery());

  const organization = organizations.data?.[0];

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <Steps current={1} />

      {organizations.error ? (
        <Empty className="border">
          <EmptyTitle>Organizations unavailable</EmptyTitle>
          <EmptyDescription className="whitespace-pre-line">
            {organizations.error.message}
          </EmptyDescription>
        </Empty>
      ) : organizations.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : !organization ? (
        <Empty className="border">
          <EmptyTitle>No organization</EmptyTitle>
          <EmptyDescription>
            A project belongs to an organization, and your account has none.
            That should not happen — an organization is created with every
            account. Sign out and back in; if it persists, it is a bug on our
            side.
          </EmptyDescription>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Create a project</CardTitle>
            <CardDescription>
              It will live in {organization.name}. Next you get the key and the
              snippet to drop into your site.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <CreateProjectForm
              organizationId={organization.id}
              actions={
                <Button asChild variant="ghost">
                  <Link to="/projects">Cancel</Link>
                </Button>
              }
              onCreated={async (project) => {
                // `replace` : revenir en arrière depuis l'installation doit
                // ramener à la liste, pas à un formulaire de création qui
                // referait un projet.
                await navigate({
                  to: '/projects/$projectId/setup',
                  params: { projectId: project.id },
                  replace: true,
                });
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
