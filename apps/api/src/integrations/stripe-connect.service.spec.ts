import { ConfigService } from '@nestjs/config';

import { StripeConnectService } from './stripe-connect.service';

/**
 * Le `state` OAuth, et lui seul.
 *
 * C'est la seule partie de ce service qui protège quelque chose, et la seule
 * qu'on puisse éprouver sans réseau : les rejets se prononcent **avant** le
 * moindre appel à Stripe. Le chemin heureux, lui, se termine chez eux — il est
 * vérifié à la main avec `stripe listen`, pas ici.
 *
 * Ce que le `state` empêche : attirer un membre connecté sur une URL de retour
 * forgée pour lui faire brancher le compte Stripe de quelqu'un d'autre, et faire
 * apparaître le revenu d'un inconnu dans son projet.
 */

const PROJECT = '2e95b1b6-2a96-443a-919f-2b3661106689';
const AUTRE_PROJET = '00000000-0000-4000-8000-000000000000';

function serviceAvec(values: Record<string, string | undefined>) {
  return new StripeConnectService({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

const configure = () =>
  serviceAvec({
    STRIPE_SECRET_KEY: 'sk_test_secret',
    STRIPE_CONNECT_CLIENT_ID: 'ca_test',
    WEB_URL: 'http://localhost:3002',
  });

/** Le `state` que le service vient d'émettre pour ce projet. */
const stateDe = (service: StripeConnectService, projectId: string): string =>
  new URL(service.authorizeUrl(projectId)).searchParams.get('state') ?? '';

describe('StripeConnectService — sans configuration', () => {
  const service = serviceAvec({});

  it('se déclare indisponible plutôt que de laisser essayer', () => {
    expect(service.available).toBe(false);
  });

  it('refuse avec un message qui dit quoi faire', () => {
    // L'API démarre quand même : Stripe est une source parmi d'autres, et
    // l'ingestion n'a rien à voir avec elle.
    expect(() => service.authorizeUrl(PROJECT)).toThrow(/pas configurée/);
  });
});

describe('StripeConnectService — le state', () => {
  let service: StripeConnectService;

  beforeEach(() => {
    service = configure();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('demande read_only par défaut', () => {
    const url = new URL(service.authorizeUrl(PROJECT));

    // La cible : le hub lit des paiements, il n'en crée aucun. C'est aussi ce
    // qui évite la restriction de juin 2021 sur les comptes déjà contrôlés par
    // une autre plateforme.
    expect(url.searchParams.get('scope')).toBe('read_only');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3002/integrations/stripe/callback',
    );
  });

  it('accepte read_write, le temps que Stripe débloque le read-only', () => {
    // Stripe refuse `read_only` aux plateformes qui ne l'ont pas demandé à son
    // support. La variable existe pour ce délai-là, et pour pouvoir en sortir
    // sans redéployer.
    const large = serviceAvec({
      STRIPE_SECRET_KEY: 'sk_test_secret',
      STRIPE_CONNECT_CLIENT_ID: 'ca_test',
      STRIPE_CONNECT_SCOPE: 'read_write',
    });

    expect(
      new URL(large.authorizeUrl(PROJECT)).searchParams.get('scope'),
    ).toBe('read_write');
  });

  it('refuse une portée qu’on ne sait pas demander, au démarrage', () => {
    // Sinon la faute de frappe voyage jusqu'à Stripe, qui répond `invalid_scope`
    // sur une page blanche de son domaine — loin du `.env` qui en est la cause.
    expect(() =>
      serviceAvec({
        STRIPE_SECRET_KEY: 'sk_test_secret',
        STRIPE_CONNECT_CLIENT_ID: 'ca_test',
        STRIPE_CONNECT_SCOPE: 'readonly',
      }),
    ).toThrow(/STRIPE_CONNECT_SCOPE/);
  });

  it('refuse un state qui n’a pas été signé par nous', async () => {
    const [projectId, expiry] = stateDe(service, PROJECT).split('.');

    await expect(
      service.exchange(PROJECT, 'ac_code', `${projectId}.${expiry}.deadbeef`),
    ).rejects.toThrow(/invalide/);
  });

  it('refuse un state authentique émis pour un autre projet', async () => {
    // Le cas que la seule vérification de signature laisserait passer : l'état
    // est bien de nous, il ne désigne simplement pas ce projet-ci.
    await expect(
      service.exchange(PROJECT, 'ac_code', stateDe(service, AUTRE_PROJET)),
    ).rejects.toThrow(/invalide/);
  });

  it('refuse un state dont on a repoussé l’expiration', async () => {
    const [projectId, , signature] = stateDe(service, PROJECT).split('.');
    const plusTard = Date.now() + 86_400_000;

    // L'expiration est dans la charge signée : la déplacer casse la signature.
    await expect(
      service.exchange(PROJECT, 'ac_code', `${projectId}.${plusTard}.${signature}`),
    ).rejects.toThrow(/invalide/);
  });

  it('refuse un state périmé, et le dit autrement', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
    const state = stateDe(service, PROJECT);

    jest.setSystemTime(new Date('2026-09-01T10:16:00.000Z'));

    // Message distinct de « invalide » : ici l'utilisateur n'a rien fait de mal,
    // il a laissé l'onglet ouvert. Lui dire de recommencer suffit.
    await expect(service.exchange(PROJECT, 'ac_code', state)).rejects.toThrow(
      /expiré/,
    );
  });

  it('produit un state différent à chaque appel', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
    const premier = stateDe(service, PROJECT);

    jest.setSystemTime(new Date('2026-09-01T10:00:01.000Z'));

    // C'est pourquoi la route est en POST : une URL d'autorisation mise en
    // cache expirerait sans prévenir.
    expect(stateDe(service, PROJECT)).not.toBe(premier);
  });

  it('ne signe pas avec la même clé qu’un autre déploiement', async () => {
    const voisin = serviceAvec({
      STRIPE_SECRET_KEY: 'sk_test_autre',
      STRIPE_CONNECT_CLIENT_ID: 'ca_test',
    });

    await expect(
      service.exchange(PROJECT, 'ac_code', stateDe(voisin, PROJECT)),
    ).rejects.toThrow(/invalide/);
  });
});
