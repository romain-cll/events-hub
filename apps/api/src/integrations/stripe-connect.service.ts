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

/**
 * La portée demandée, et elle ne changera pas.
 *
 * `read_only` est le défaut de Stripe et c'est exactement notre besoin : le hub
 * lit des paiements, il n'en crée aucun. Deux conséquences qu'on encaisse
 * gratuitement — nous ne pouvons rien casser chez un client même en cas de bug,
 * et la restriction de juin 2021 sur les comptes Standard déjà contrôlés par une
 * autre plateforme ne s'applique qu'à `read_write`, donc pas à nous.
 */
const SCOPE = 'read_only';

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
      scope: SCOPE,
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
      scope: token.scope ?? SCOPE,
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

  private sign(payload: string): string {
    // `stripe` a déjà levé si la clé manque — la lire ici est donc sûre, et le
    // dire par une assertion évite de propager un `string | undefined` dans
    // toute la signature.
    return createHmac('sha256', this.secretKey as string)
      .update(payload)
      .digest('hex');
  }
}
