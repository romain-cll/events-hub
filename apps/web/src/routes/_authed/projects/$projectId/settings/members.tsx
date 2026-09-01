import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  CheckIcon,
  ChevronDownIcon,
  MailIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
} from 'lucide-react';
import { useState } from 'react';

import type { Invitation, Member, OrganizationRole } from '#/lib/members';

import { Field, fieldValue } from '#/components/field';
import { Alert, AlertDescription } from '#/components/ui/alert';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { Skeleton } from '#/components/ui/skeleton';
import { UNREACHABLE } from '#/lib/auth-errors';
import {
  cancelInvitation,
  invitationsQuery,
  inviteMember,
  membersQuery,
  removeMember,
  updateMemberRole,
} from '#/lib/members';
import { organizationsQuery } from '#/lib/organizations';
import { projectsQuery } from '#/lib/projects';

/**
 * Qui est dans l'organisation, et qui a été invité.
 *
 * ## Ce que le rôle décide, ici et côté serveur
 *
 * Un `member` ne voit ni le bouton « Invite people », ni les menus de rôle, ni
 * le menu de dépassement. Ils ne sont pas **désactivés** : un contrôle qui ne
 * pourra jamais agir est un contrôle qu'on ne dessine pas — le désactiver
 * demande au visiteur de deviner ce qui le débloquerait.
 *
 * Cette absence n'est pas ce qui protège. Le plugin refuse par 403 quiconque
 * n'a pas `invitation:create`, `member:update` ou `member:delete`, et c'est
 * éprouvé (`organizations.e2e-spec.ts`). L'écran ne fait qu'éviter de proposer
 * ce qui sera refusé.
 *
 * ## Les rôles s'expliquent dans le menu, pas sous la liste
 *
 * Chaque entrée porte sa phrase — « Invites people and manages projects » — là
 * où la question se pose. Un paragraphe sous le tableau se lirait une fois,
 * jamais deux, et coûterait une ligne de hauteur pour toujours.
 */
export const Route = createFileRoute(
  '/_authed/projects/$projectId/settings/members',
)({
  component: Members,
});

/** Ce que chaque rôle permet, dit là où on le choisit. */
const ROLES: { value: OrganizationRole; label: string; hint: string }[] = [
  {
    value: 'owner',
    label: 'Owner',
    hint: 'Full control, including deleting the organization.',
  },
  {
    value: 'admin',
    label: 'Admin',
    hint: 'Invites people and manages projects and keys.',
  },
  {
    value: 'member',
    label: 'Member',
    hint: 'Reads analytics and creates projects.',
  },
];

const day = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

function Members() {
  const { projectId } = Route.useParams();

  /**
   * L'instant de référence, figé au montage.
   *
   * Une invitation périmée reste `pending` côté plugin : c'est donc à l'écran de
   * comparer sa date. Le faire à chaque rendu appellerait `Date.now()` pendant
   * le rendu — impur, et la liste basculerait sous les yeux à un rendu
   * quelconque. Figé ici, l'état affiché est celui de l'ouverture de l'écran,
   * et il ne change qu'au rechargement — ce qui est le bon grain pour une date
   * qui se compte en jours.
   */
  const [now] = useState(() => Date.now());

  const projects = useQuery(projectsQuery());
  const organizations = useQuery(organizationsQuery());

  const project = projects.data?.find(({ id }) => id === projectId);
  const organization = organizations.data?.find(
    ({ id }) => id === project?.organizationId,
  );

  if (!organization) {
    return projects.isPending || organizations.isPending ? (
      <Skeleton className="h-96 w-full" />
    ) : (
      <Empty className="border">
        <EmptyTitle>Organization unavailable</EmptyTitle>
        <EmptyDescription>
          This project&apos;s organization could not be read. Reload the page;
          if it persists, it is a bug on our side.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <MembersOf
      now={now}
      organizationId={organization.id}
      organizationName={organization.name}
      // Le rôle vient de la même jointure que la liste des organisations : il
      // n'y a pas de seconde requête à faire pour savoir ce qu'on a le droit
      // de proposer.
      canManage={organization.role !== 'member'}
    />
  );
}

function MembersOf({
  now,
  organizationId,
  organizationName,
  canManage,
}: {
  now: number;
  organizationId: string;
  organizationName: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(organizationId));
  const invitations = useQuery(invitationsQuery(organizationId));

  const [inviting, setInviting] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['organizations', organizationId, 'members'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['organizations', organizationId, 'invitations'],
      }),
    ]);

  // L'historique complet arrive ; seules les invitations encore vivantes ont
  // leur place ici. Une invitation acceptée est déjà visible plus haut, sous la
  // forme d'un membre.
  const pending = (invitations.data ?? []).filter(
    ({ status }) => status === 'pending',
  );

  const error = members.error ?? invitations.error;

  if (error) {
    return (
      <Empty className="border">
        <EmptyTitle>Members unavailable</EmptyTitle>
        <EmptyDescription className="whitespace-pre-line">
          {error.message}
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Everyone here can open every project in {organizationName}.
          </CardDescription>
          {canManage && (
            <CardAction>
              <Button
                size="sm"
                onClick={() => {
                  setInviting(true);
                }}
              >
                <PlusIcon />
                Invite people
              </Button>
            </CardAction>
          )}
        </CardHeader>

        <CardContent className="px-0">
          {members.isPending ? (
            <Skeleton className="mx-4 h-32" />
          ) : (
            <div className="flex flex-col">
              {(members.data ?? []).map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  organizationId={organizationId}
                  canManage={canManage}
                  onDone={refresh}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invitations</CardTitle>
          <CardDescription>
            Nothing changes here until they accept. An expired invitation can be
            resent.
          </CardDescription>
        </CardHeader>

        <CardContent className={pending.length > 0 ? 'px-0' : undefined}>
          {invitations.isPending ? (
            <Skeleton className="h-20" />
          ) : pending.length === 0 ? (
            <Empty className="border">
              <EmptyTitle>No one is waiting</EmptyTitle>
              <EmptyDescription>
                Invitations show up here until they are accepted, declined or
                revoked.
              </EmptyDescription>
            </Empty>
          ) : (
            <div className="flex flex-col">
              {pending.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  now={now}
                  invitation={invitation}
                  organizationId={organizationId}
                  canManage={canManage}
                  onDone={refresh}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        organizationId={organizationId}
        organizationName={organizationName}
        onDone={refresh}
      />
    </div>
  );
}

/** L'avatar d'un membre : ses initiales, faute d'image dans la plupart des cas. */
function Avatar({ label }: { label: string }) {
  return (
    <span className="bg-brand-soft text-brand-soft-foreground flex aspect-square size-7 shrink-0 items-center justify-center rounded-full text-2xs font-bold">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function MemberRow({
  member,
  organizationId,
  canManage,
  onDone,
}: {
  member: Member;
  organizationId: string;
  canManage: boolean;
  onDone: () => Promise<unknown>;
}) {
  const [failure, setFailure] = useState('');

  const setRole = useMutation({
    mutationFn: (role: OrganizationRole) =>
      updateMemberRole({ organizationId, memberId: member.id, role }),
    onSuccess: () => onDone(),
    onError: (cause: unknown) => {
      setFailure(cause instanceof Error ? cause.message : UNREACHABLE);
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      removeMember({ organizationId, memberIdOrEmail: member.id }),
    onSuccess: () => onDone(),
    onError: (cause: unknown) => {
      setFailure(cause instanceof Error ? cause.message : UNREACHABLE);
    },
  });

  const label = ROLES.find(({ value }) => value === member.role)?.label;

  return (
    <div className="flex flex-col gap-2 border-t px-4 py-2 first:border-t-0">
      <div className="flex items-center gap-3">
        <Avatar label={member.user.name || member.user.email} />

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {member.user.name || member.user.email}
          </span>
          <span className="text-muted-foreground truncate text-2xs">
            {member.user.email}
          </span>
        </div>

        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" loading={setRole.isPending}>
                {label}
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-68">
              {ROLES.map((role) => (
                <DropdownMenuItem
                  key={role.value}
                  onSelect={() => {
                    setFailure('');
                    setRole.mutate(role.value);
                  }}
                  className="items-start"
                >
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span>{role.label}</span>
                    <span className="text-muted-foreground text-2xs leading-snug">
                      {role.hint}
                    </span>
                  </span>
                  {role.value === member.role && (
                    <CheckIcon className="text-primary mt-0.5" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Badge variant="outline">{label}</Badge>
        )}

        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem
                onSelect={() => {
                  void navigator.clipboard.writeText(member.user.email);
                }}
              >
                <MailIcon />
                Copy email address
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  setFailure('');
                  remove.mutate();
                }}
              >
                Remove from organization
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/*
        Le refus est affiché sur la ligne concernée, pas en tête d'écran : « le
        dernier propriétaire ne peut pas être rétrogradé » ne veut rien dire à
        côté d'un titre, et tout dire à côté de la personne.
      */}
      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="whitespace-pre-line">
            {failure}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function InvitationRow({
  now,
  invitation,
  organizationId,
  canManage,
  onDone,
}: {
  now: number;
  invitation: Invitation;
  organizationId: string;
  canManage: boolean;
  onDone: () => Promise<unknown>;
}) {
  const [failure, setFailure] = useState('');
  const expired = new Date(invitation.expiresAt).getTime() < now;

  const resend = useMutation({
    mutationFn: () =>
      inviteMember({
        organizationId,
        email: invitation.email,
        role: invitation.role,
        resend: true,
      }),
    onSuccess: () => onDone(),
    onError: (cause: unknown) => {
      setFailure(cause instanceof Error ? cause.message : UNREACHABLE);
    },
  });

  const revoke = useMutation({
    mutationFn: () => cancelInvitation(invitation.id),
    onSuccess: () => onDone(),
    onError: (cause: unknown) => {
      setFailure(cause instanceof Error ? cause.message : UNREACHABLE);
    },
  });

  return (
    <div className="flex flex-col gap-2 border-t px-4 py-2 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="bg-muted text-muted-foreground flex aspect-square size-7 shrink-0 items-center justify-center rounded-full">
          <MailIcon className="size-3.5" />
        </span>

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {invitation.email}
          </span>
          <span className="text-muted-foreground truncate text-2xs">
            Invited {day.format(new Date(invitation.createdAt))}
          </span>
        </div>

        <Badge variant="outline">
          {ROLES.find(({ value }) => value === invitation.role)?.label}
        </Badge>

        {expired ? (
          <Badge className="bg-warning-soft text-warning">Expired</Badge>
        ) : (
          <span className="text-subtle-foreground tabular text-2xs">
            Expires {day.format(new Date(invitation.expiresAt))}
          </span>
        )}

        {canManage && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              loading={resend.isPending}
              onClick={() => {
                setFailure('');
                resend.mutate();
              }}
            >
              <RotateCcwIcon />
              Resend
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              loading={revoke.isPending}
              onClick={() => {
                setFailure('');
                revoke.mutate();
              }}
            >
              Revoke
            </Button>
          </div>
        )}
      </div>

      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="whitespace-pre-line">
            {failure}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * Inviter — une adresse, un rôle.
 *
 * ## Une seule adresse à la fois
 *
 * La maquette proposait une liste séparée par des virgules. L'endpoint, lui, en
 * prend une : en boucler plusieurs ici produirait des succès partiels — trois
 * envoyées, la quatrième refusée — que le formulaire ne saurait pas raconter.
 * Une adresse par envoi dit la vérité de ce qui se passe.
 */
function InviteDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationName: string;
  onDone: () => Promise<unknown>;
}) {
  const [role, setRole] = useState<OrganizationRole>('member');
  const [fieldError, setFieldError] = useState('');

  const invite = useMutation({
    mutationFn: (email: string) =>
      inviteMember({ organizationId, email, role }),
    onSuccess: async () => {
      await onDone();
      onOpenChange(false);
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const email = fieldValue(new FormData(event.currentTarget), 'email').trim();

    if (!email.includes('@')) {
      setFieldError('Enter the email address to invite.');

      return;
    }

    setFieldError('');
    invite.mutate(email);
  };

  const chosen = ROLES.find((entry) => entry.value === role);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setFieldError('');
        setRole('member');
        invite.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite people to {organizationName}</DialogTitle>
          <DialogDescription>
            They get a link by email. Nothing changes here until they accept.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label="Email address"
            name="email"
            type="email"
            required
            placeholder="sarah@acme.com"
            hint="They do not need an account yet — the link creates one."
            error={fieldError}
          />

          <div className="flex flex-col gap-1.5">
            <span className="text-sm leading-none font-medium">Role</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="justify-between">
                  {chosen?.label}
                  <ChevronDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-(--radix-dropdown-menu-trigger-width)"
              >
                {ROLES.map((entry) => (
                  <DropdownMenuItem
                    key={entry.value}
                    onSelect={() => {
                      setRole(entry.value);
                    }}
                    className="items-start"
                  >
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span>{entry.label}</span>
                      <span className="text-muted-foreground text-2xs leading-snug">
                        {entry.hint}
                      </span>
                    </span>
                    {entry.value === role && (
                      <CheckIcon className="text-primary mt-0.5" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {invite.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="whitespace-pre-line">
                {invite.error instanceof Error
                  ? invite.error.message
                  : UNREACHABLE}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={invite.isPending}>
              <SendIcon />
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
