import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { createEventSchema, type CreateEventDto } from './dto/create-event.dto';
import {
  CoreService,
  type IngestedEvent as CoreIngestedEvent,
} from '../core/core.service';
import { ProjectKeysService } from '../projects/project-keys.service';
import { Public } from '../auth/auth.decorators';
import { decideOptOut } from './opt-out';
import {
  clearVisitorCookie,
  decideVisitorCookie,
} from './visitor-cookie';

/**
 * L'événement écrit, sa visite, et l'identifiant durable du visiteur quand il
 * en a un.
 *
 * ## Deux identifiants, et le site choisit lequel il joint à son paiement
 *
 * `visitorId` n'existe que sous consentement, et c'est le bon quand il existe :
 * il traverse les visites, donc il attribue les renouvellements et la valeur
 * vie. `sessionId` est toujours là, ne coûte aucun consentement puisque rien
 * n'est inscrit sur le terminal, et n'attribue que l'achat conclu pendant la
 * visite.
 *
 * L'ordre de préférence est donc : le durable s'il est là, la visite sinon.
 * C'est au site de l'appliquer — nous rendons les deux, nous ne choisissons pas
 * à sa place.
 *
 * ## Pourquoi le `visitorId` remonte
 *
 * Le SDK est le seul à ne **pas** pouvoir lire le cookie qui le porte : celui-ci
 * est posé sur notre domaine, la page tourne sur celui du site client. Sans ce
 * renvoi, le site n'a aucun moyen d'obtenir la valeur qu'il doit joindre à son
 * paiement — et c'est cette jointure qui donne toute sa raison d'être au mode
 * consenti.
 *
 * Rien n'est révélé au passage : la réponse part vers le navigateur du visiteur
 * concerné, qui est déjà porteur du cookie.
 *
 * ## Son absence dit quelque chose
 *
 * Elle n'est pas un « rien à signaler » : elle dit au SDK d'effacer la copie
 * qu'il tient sur le domaine du site. Sans consentement il n'y a pas
 * d'identifiant, donc il ne doit rien en rester nulle part.
 */
export type IngestedEvent = CoreIngestedEvent & { visitorId?: string };

/**
 * `version: '1'` + le versioning URI activé dans `main.ts` donnent le préfixe
 * `/v1`. La route complète est donc `POST /v1/events`.
 */
/**
 * Public, et ça n'est pas un assouplissement : le SDK tourne dans le navigateur
 * des **visiteurs des sites clients**, qui n'ont aucun compte chez nous et n'en
 * auront jamais. L'ingestion ne s'authentifie pas par session de dashboard —
 * elle s'authentifie par **clé de projet**.
 *
 * Une seule route pour les deux natures de source. Le client ne choisit pas son
 * chemin : il présente une clé, et c'est elle qui dit s'il émet depuis un
 * navigateur (`eh_pk_`, origine vérifiée, session attribuée) ou depuis un
 * serveur (`eh_sk_`, pas d'origine, pas de session). Une seconde route n'aurait
 * rien ajouté qu'une occasion de se tromper de porte.
 */
@Public()
@Controller({ path: 'events', version: '1' })
export class IngestionController {
  constructor(
    private readonly core: CoreService,
    private readonly projectKeys: ProjectKeysService,
  ) {}

  /**
   * Deux issues heureuses, deux codes.
   *
   * **201 avec l'événement** quand la clé et l'origine tiennent. **204 sans
   * corps** quand l'origine ne tient pas — absente, ou non déclarée sur la clé.
   * Le second n'est pas une erreur déguisée : l'événement est *écarté*, et
   * l'appelant n'a rien à en faire.
   *
   * Ce silence est délibéré. Un 4xx sur un endpoint de capture fait revenir les
   * SDK clients en boucle de retry, donc amplifie exactement le trafic qu'on
   * cherche à écarter ; et il dirait à qui essaie des origines au hasard quand
   * il a visé juste. Le refus est en revanche journalisé côté serveur — c'est
   * là, et seulement là, qu'un développeur ayant oublié de déclarer son domaine
   * peut le constater.
   *
   * Les erreurs de **clé**, elles, restent bruyantes (401, 400) : l'interlocuteur
   * y est un développeur qui intègre le SDK, pas un émetteur anonyme.
   *
   * `passthrough: true` : Nest continue de sérialiser la valeur rendue, on ne
   * prend la main que sur le statut.
   *
   * L'IP et le User-Agent sont lus sur la requête, jamais dans le corps : ils
   * servent à dériver la clé visiteur et le client n'a pas à pouvoir les
   * choisir. Ils ne sont transmis qu'au chemin navigateur ; le chemin serveur ne
   * les reçoit pas. Ils ne sont pas non plus déclarés dans le schéma Zod, qui est en
   * `strictObject` — un payload qui prétendrait les porter serait rejeté.
   *
   * `@Ip()` renvoie `request.ip`. Derrière un reverse proxy il faudra activer
   * `trust proxy` dans `main.ts` pour qu'Express lise `X-Forwarded-For` :
   * sans ça toutes les requêtes partageraient l'IP du proxy, donc la même clé
   * visiteur. En local, l'adresse de la connexion est la bonne.
   *
   * Le User-Agent est optionnel côté HTTP : absent, on hache une chaîne vide
   * plutôt que de refuser l'événement.
   *
   * Le cookie de visiteur suit le même trajet, et seulement sur le chemin
   * navigateur : une source serveur n'a pas de terminal où écrire, et le lui
   * proposer n'aurait aucun sens.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createEventSchema)) payload: CreateEventDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) response: Response,
    @Headers('origin') origin?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('cookie') cookie?: string,
    @Headers('sec-gpc') secGpc?: string,
  ): Promise<IngestedEvent | undefined> {
    // La clé désigne le projet et sa nature ; l'origine dit si une clé publique
    // a le droit de servir depuis ce site. Tout est résolu ici, dans
    // l'adaptateur HTTP, parce qu'`Origin` est une notion HTTP — le socle reçoit
    // un `projectId` et une `source`, et n'a jamais à connaître d'en-tête.
    // `campaign` est extrait explicitement, et pas laissé filer dans `...event` :
    // sans ça il partirait aussi sur la branche serveur, où une campagne n'a
    // aucun sens — une source serveur n'a pas de visite d'où venir. Le
    // détournement serait silencieux, les objets étalés n'étant pas soumis au
    // contrôle des propriétés excédentaires.
    const { apiKey, consent, optOut, campaign, ...event } = payload;

    // Tranché **avant** de résoudre la clé, donc avant d'aller en base : un
    // événement qu'on n'écrira pas ne mérite pas une requête. Et avant le 204
    // d'origine, parce qu'une opposition vaut quelle que soit la provenance —
    // la refuser pour cause de domaine non déclaré serait la perdre.
    const opposition = decideOptOut(cookie, secGpc, optOut);

    // Accumulés plutôt que posés au fil de l'eau : `setHeader` écrase, et une
    // réponse peut avoir à porter les deux — celle qui enregistre l'opposition
    // retire aussi l'identité durable.
    const cookies = opposition.setCookie ? [opposition.setCookie] : [];

    if (opposition.refused) {
      // S'opposer sans perdre son identifiant durable serait un demi-geste : il
      // resterait sur le terminal, prêt à resservir si l'opposition tombe.
      if (optOut === true) cookies.push(clearVisitorCookie());

      response.setHeader('Set-Cookie', cookies);
      response.status(HttpStatus.NO_CONTENT);

      return undefined;
    }

    const resolved = await this.projectKeys.resolve(apiKey, origin);

    // Origine refusée : rien n'est écrit, et on ne le dit pas.
    if (resolved === null) {
      response.status(HttpStatus.NO_CONTENT);

      return undefined;
    }

    const { projectId, source } = resolved;

    // La `source` vient de la clé, jamais du corps — et c'est ce qui la rend
    // fiable. Les deux branches ne diffèrent que par l'identité réseau : le
    // chemin serveur ne la reçoit pas, donc il ne peut rien en faire. L'union
    // discriminée d'`IngestCommand` fait échouer la compilation de l'inverse.
    if (source === 'server') {
      if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);

      return this.core.ingest({ ...event, projectId, source });
    }

    // Le cookie s'arrête ici, comme `Origin` : ce qui descend est un
    // identifiant opaque, jamais un en-tête. Et il est décidé *après* le 204 —
    // un événement écarté ne laisse rien derrière lui, pas même un cookie.
    const { setCookie, ...visitor } = decideVisitorCookie(cookie, consent);

    if (setCookie) cookies.push(setCookie);
    if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);

    const written = await this.core.ingest({
      ...event,
      ...visitor,
      projectId,
      source,
      campaign,
      // Le signal brut descend **en plus** de sa conséquence. `visitor` porte
      // déjà ce que le consentement a produit — un identifiant, ou rien — mais
      // pas ce qui l'a produit : un visiteur sans identité durable a refusé, ou
      // n'a jamais rien eu à refuser, et les deux se ressemblent en aval.
      consent,
      network: { ip, userAgent: userAgent ?? '' },
    });

    return { ...written, visitorId: visitor.visitorId };
  }
}
