import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/** Ce qu'un compte fraîchement branché nous apprend sur lui-même. */
export interface ConnectedAccount {
  accountId: string;
  scope: string;
  livemode: boolean;
}

/** Les deux portées que Connect accepte. */
type ConnectScope = 'read_only' | 'read_write';

/**
 * La portée demandée. `read_only` est ce qu'on veut, et pas toujours ce qu'on
 * peut.
 *
 * Le hub lit des paiements, il n'en crée aucun : `read_only` décrit exactement
 * ce dont il a besoin, et nous met hors d'état de casser quoi que ce soit chez
 * un client même en cas de bug. C'est donc le défaut, et ce doit rester la
 * cible.
 *
 * Mais Stripe ne l'accorde pas à toutes les plateformes — « Please use the
 * `read_write` scope, or contact support in order to use read-only
 * connections ». Tant que le read-only n'est pas débloqué, une plateforme n'a
 * que `read_write` à sa disposition.
 *
 * D'où une variable d'environnement plutôt qu'une constante : le jour où le
 * support l'accorde, on repasse en `read_only` sans redéployer de logique. C'est
 * un réglage daté, pas une option de conception.
 *
 * ⚠️ `read_write` a un coût qui n'est pas qu'un principe : la restriction de
 * juin 2021 s'y applique, donc un compte Standard déjà contrôlé par une autre
 * plateforme devient impossible à connecter.
 */
const DEFAULT_SCOPE: ConnectScope = 'read_only';

/** Un lien d'autorisation ne doit pas survivre à la page qui l'a affiché. */
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Le dialogue OAuth avec Stripe Connect, et rien d'autre.
 *
 * ## Ce qui n'est pas stocké, et pourquoi c'est la bonne nouvelle
 *
 * L'échange rend un identifiant de compte (`acct_…`), pas un jeton à garder au
 * chaud. Les appels ultérieurs se font avec **notre** clé plateforme et
 * l'en-tête `Stripe-Account` : il n'y a donc ni jeton à chiffrer, ni
 * rafraîchissement à programmer, ni fuite possible depuis la base.
 *
 * ## Le `state`, et pourquoi il est signé plutôt que stocké
 *
 * Sans lui, il suffit d'attirer un membre connecté sur une URL de retour forgée
 * pour lui faire brancher le compte Stripe de quelqu'un d'autre — et le revenu
 * d'un inconnu apparaîtrait dans son projet.
 *
 * Il porte le projet et une expiration, et il est signé. Le vérifier ne demande
 * donc aucune table et aucun nettoyage de lignes périmées : ce qui n'est pas
 * signé par nous ne passe pas, et ce qui est trop vieux non plus.
 *
 * La clé de signature est la clé secrète Stripe. Elle est déjà là, déjà secrète,
 * et déjà propre à ce sujet — en introduire une quatrième dans l'environnement
 * pour signer une valeur qui vit quinze minutes ne protégerait rien de plus.
 */
@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);
  private readonly clientId: string | undefined;
  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly scope: ConnectScope;
  private readonly redirectUri: string;
  private client: Stripe | undefined;

  /**
   * La configuration est **optionnelle**, à la différence de
   * `VISITOR_KEY_SECRET`.
   *
   * Celle-là est chargée à chaque événement : sans elle, rien n'a de sens et
   * l'API doit refuser de démarrer. Stripe est une source parmi d'autres, que
   * la plupart des déploiements n'auront pas. Faire dépendre le démarrage de
   * l'API d'une verticale optionnelle rendrait l'ingestion — qui n'a rien à
   * voir — indisponible pour une clé manquante.
   *
   * L'absence n'est pas silencieuse pour autant : un avertissement au démarrage,
   * et une erreur explicite si quelqu'un tente de brancher un compte. C'est le
   * même arbitrage que `GeoIpService`, pour la même raison.
   */
  constructor(config: ConfigService) {
    this.secretKey = config.get<string>('STRIPE_SECRET_KEY');
    this.clientId = config.get<string>('STRIPE_CONNECT_CLIENT_ID');
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET');
    this.scope = readScope(config.get<string>('STRIPE_CONNECT_SCOPE'));
    this.redirectUri = `${config.get<string>('WEB_URL') ?? 'http://localhost:3002'}/integrations/stripe/callback`;

    if (!this.secretKey || !this.clientId) {
      this.logger.warn(
        'STRIPE_SECRET_KEY ou STRIPE_CONNECT_CLIENT_ID absente : la connexion Stripe est désactivée.',
      );
    }
  }

  /** Configuré, donc utilisable ? Ce que l'appelant peut demander sans échouer. */
  get available(): boolean {
    return Boolean(this.secretKey && this.clientId);
  }

  /**
   * Un client authentifié, à l'usage des modules qui lisent chez Stripe.
   *
   * Exposé plutôt que recopié : les identifiants Stripe vivent **ici**, et un
   * module métier qui construirait son propre client relirait la configuration
   * de son côté — deux endroits à changer le jour d'une rotation de clé, et un
   * qu'on oublierait.
   *
   * L'appelant passe `{ stripeAccount }` sur chaque requête pour agir au nom
   * d'un compte connecté. C'est tout ce que Connect demande : il n'y a pas de
   * jeton par compte à retrouver.
   */
  get api(): Stripe {
    return this.stripe;
  }

  /**
   * Vérifie la signature d'un webhook et rend l'événement.
   *
   * Ici, et pas dans le module qui consomme les webhooks, pour la même raison
   * que `api` : c'est cette classe qui détient les secrets Stripe. La
   * vérification est le seul rempart contre quelqu'un qui posterait de faux
   * paiements sur une route ouverte — s'en passer reviendrait à laisser
   * n'importe qui fabriquer du revenu dans le projet d'un client.
   *
   * `constructEvent` exige le **corps brut**, pas l'objet parsé : la signature
   * porte sur les octets reçus, et re-sérialiser du JSON ne redonne pas les
   * mêmes. C'est pourquoi `app.setup.ts` monte `express.raw` sur cette route.
   */
  verifyWebhook(payload: Buffer, signature: string): Stripe.Event {
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException(
        'STRIPE_WEBHOOK_SECRET absente : les webhooks Stripe ne peuvent pas être vérifiés.',
      );
    }

    try {
      return this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      // Le détail va au journal, jamais à l'appelant : lui dire *pourquoi* la
      // signature est refusée l'aiderait à en fabriquer une valide.
      this.logger.warn(
        `Signature de webhook Stripe refusée : ${String(error)}`,
      );

      throw new BadRequestException('Signature invalide.');
    }
  }

  /**
   * Le client Stripe, construit au premier usage.
   *
   * Le faire au démarrage obligerait à disposer d'une clé pour instancier le
   * module, donc à refuser de démarrer sans elle — ce que ce service existe
   * justement pour éviter.
   */
  private get stripe(): Stripe {
    if (!this.secretKey || !this.clientId) {
      throw new ServiceUnavailableException(
        'La connexion Stripe n’est pas configurée sur ce déploiement.',
      );
    }

    this.client ??= new Stripe(this.secretKey);

    return this.client;
  }

  /**
   * L'URL vers laquelle envoyer le membre pour qu'il autorise le hub.
   *
   * Le retour vise le **dashboard**, pas l'API. Stripe renvoie le navigateur par
   * une navigation de premier niveau : la faire atterrir sur l'API obligerait à
   * y traiter une session de dashboard et à rediriger derrière. Le front reçoit
   * le `code`, le repasse à l'API par son appel authentifié habituel, et rien
   * n'a besoin de changer côté cookies.
   */
  authorizeUrl(projectId: string): string {
    // Lu à travers `stripe`, qui lève si la configuration manque : la garde est
    // au même endroit pour les trois méthodes plutôt que répétée dans chacune.
    const stripe = this.stripe;

    return stripe.oauth.authorizeUrl({
      client_id: this.clientId as string,
      response_type: 'code',
      scope: this.scope,
      redirect_uri: this.redirectUri,
      state: this.signState(projectId),
    });
  }

  /**
   * Échange le code contre l'identité du compte connecté.
   *
   * Le `state` est vérifié **contre le projet de l'URL**, pas seulement contre
   * sa propre signature : un état valide émis pour un autre projet resterait
   * sinon utilisable ici.
   */
  async exchange(projectId: string, code: string, state: string) {
    // Lu **avant** la vérification du `state` : celle-ci signe avec la clé
    // secrète, et sans configuration elle échouerait sur une erreur de crypto
    // illisible plutôt que sur « Stripe n'est pas configuré ».
    const stripe = this.stripe;

    this.verifyState(projectId, state);

    const token = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code,
    });

    if (!token.stripe_user_id) {
      throw new BadRequestException(
        'Stripe n’a pas renvoyé de compte pour ce code.',
      );
    }

    // On enregistre la portée **accordée**, pas celle qu'on a demandée. Le jour
    // où les deux divergent, on veut le lire en base plutôt que le supposer.
    return {
      accountId: token.stripe_user_id,
      scope: token.scope ?? this.scope,
      livemode: token.livemode ?? false,
    } satisfies ConnectedAccount;
  }

  /**
   * Coupe l'accès côté Stripe.
   *
   * Appelée quand un membre débranche l'intégration. L'échec est journalisé mais
   * n'interrompt pas : la ligne locale doit disparaître dans tous les cas, et un
   * accès résiduel côté Stripe se révoque depuis leur tableau de bord. L'inverse
   * — garder la ligne parce que Stripe n'a pas répondu — laisserait le projet
   * afficher une intégration que l'utilisateur croit avoir retirée.
   */
  async deauthorize(accountId: string): Promise<void> {
    try {
      await this.stripe.oauth.deauthorize({
        client_id: this.clientId,
        stripe_user_id: accountId,
      });
    } catch (error) {
      this.logger.warn(
        `Révocation Stripe refusée pour ${accountId} : ${String(error)}. La connexion est retirée localement malgré tout.`,
      );
    }
  }

  private signState(projectId: string): string {
    const payload = `${projectId}.${Date.now() + STATE_TTL_MS}`;

    return `${payload}.${this.sign(payload)}`;
  }

  private verifyState(projectId: string, state: string): void {
    const [statedProject, expiry, signature] = state.split('.');
    const payload = `${statedProject}.${expiry}`;

    const expected = Buffer.from(this.sign(payload));
    const received = Buffer.from(signature ?? '');

    // `timingSafeEqual` exige des longueurs égales et lève sinon — d'où la
    // comparaison de taille d'abord. Une signature de longueur différente est
    // de toute façon fausse.
    const valid =
      received.length === expected.length &&
      timingSafeEqual(received, expected);

    if (!valid || statedProject !== projectId) {
      throw new BadRequestException('Retour Stripe invalide.');
    }

    if (Number(expiry) < Date.now()) {
      throw new BadRequestException(
        'Ce lien de connexion Stripe a expiré. Relancez la connexion.',
      );
    }
  }

  /** La portée courante, à l'usage des tests et de qui veut l'afficher. */
  get requestedScope(): ConnectScope {
    return this.scope;
  }

  private sign(payload: string): string {
    // `stripe` a déjà levé si la clé manque — la lire ici est donc sûre, et le
    // dire par une assertion évite de propager un `string | undefined` dans
    // toute la signature.
    return createHmac('sha256', this.secretKey as string)
      .update(payload)
      .digest('hex');
  }
}

/**
 * Lit la portée, et refuse une valeur qu'on ne sait pas demander.
 *
 * Une faute de frappe passerait sinon jusqu'à Stripe, qui répondrait
 * `invalid_scope` sur une page blanche de son domaine — loin du fichier
 * `.env` qui en est la cause. Ici l'erreur nomme la variable et les valeurs
 * possibles, au démarrage.
 */
function readScope(value: string | undefined): ConnectScope {
  if (value === undefined) return DEFAULT_SCOPE;

  if (value !== 'read_only' && value !== 'read_write') {
    throw new Error(
      `STRIPE_CONNECT_SCOPE vaut « ${value} » : attendu « read_only » ou « read_write ».`,
    );
  }

  return value;
}
