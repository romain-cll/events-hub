import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Le seul hôte que ce module contacte, et il est écrit en dur.
 *
 * C'est **la** propriété de sécurité du relais : la destination ne dépend
 * d'aucune valeur d'appelant. L'hôte demandé n'est pas une adresse qu'on suit,
 * c'est un segment de chemin dans cette URL-là.
 */
const UPSTREAM = 'https://icons.duckduckgo.com/ip3';

/**
 * Ce à quoi un nom d'hôte doit ressembler pour qu'on le laisse passer.
 *
 * Volontairement plus stricte que la RFC : lettres, chiffres, tirets et points,
 * au moins un point, 253 caractères au plus. Ce qu'elle exclut est ce qui
 * compte — pas de `/` (on ne sort pas du chemin), pas de `..`, pas de `@` (pas
 * de partie utilisateur qui déguiserait l'hôte réel), pas de `:` (pas de port
 * ni de schéma), pas d'espace ni d'encodage.
 *
 * **Le dernier label doit commencer par une lettre.** C'est ce qui écarte
 * `169.254.169.254` et les adresses en général, tout en gardant les TLD
 * punycode (`xn--p1ai`). Ce n'est pas ça qui empêche la SSRF — la destination
 * fixe s'en charge, et une adresse ici n'aurait fait qu'interroger DuckDuckGo
 * pour rien. C'est un refus d'entrée qui n'a pas de sens : personne n'a de
 * favicon à une adresse IP.
 */
const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** Au-delà, on abandonne : une icône n'a pas le droit de retenir une requête. */
const TIMEOUT_MS = 3000;

/**
 * Le relais de favicons.
 *
 * ## Pourquoi un relais, et pas le navigateur
 *
 * Sans lui, chaque lecteur du dashboard contacterait un tiers une fois par hôte
 * affiché — et dirait donc à ce tiers vers quels sites partent les visiteurs de
 * nos clients. C'est le chemin que Plausible a abandonné en 1.4.0, pour cette
 * raison exactement. Ici, le tiers ne voit que notre serveur.
 *
 * ## Pourquoi pas `https://<hôte>/favicon.ico` directement
 *
 * Trois raisons qui se cumulent, et la troisième est disqualifiante :
 *
 * - le fichier à la racine n'existe souvent plus — les sites déclarent
 *   `<link rel="icon">` vers un chemin haché, qu'il faudrait aller lire dans
 *   leur HTML ;
 * - beaucoup répondent 200 avec une page d'erreur plutôt que 404 ;
 * - surtout, **ce serait une SSRF**. L'hôte affiché vient de la donnée ingérée,
 *   donc d'un tiers : il suffit d'émettre un événement portant `169.254.169.254`
 *   pour nous faire interroger les métadonnées de notre propre hébergeur. Un
 *   relais vers une destination fixe ferme la porte ; une liste noire
 *   d'adresses privées ne l'aurait que rétrécie.
 *
 * Ce module ne sait d'ailleurs pas **quel** événement porte cet hôte, et il n'a
 * pas à le savoir : il reçoit un nom d'hôte et rend une image.
 *
 * ## Pourquoi c'est authentifié
 *
 * Le guard global s'applique — pas de `@Public()` ici, et c'est délibéré. Sans
 * session, cette route serait un proxy DuckDuckGo ouvert à tout Internet, à nos
 * frais et sous notre adresse IP.
 */
@Controller({ path: 'favicons', version: '1' })
export class FaviconsController {
  /**
   * `GET /v1/favicons/:host` — l'icône d'un site, ou rien.
   *
   * **204 et jamais 404** quand l'amont ne sait pas répondre : une icône
   * manquante est un cas ordinaire, pas une erreur de la requête. Le client
   * dessine alors son monogramme, et une ligne de tableau ne se casse pas pour
   * si peu.
   */
  @Get(':host')
  @Header('Cache-Control', 'public, max-age=604800, immutable')
  async icon(
    @Param('host') host: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    // Minuscules avant le test : un hôte est insensible à la casse, et refuser
    // `GitHub.com` serait refuser une adresse valide.
    const name = host.toLowerCase();

    if (!HOST.test(name)) {
      throw new BadRequestException(`« ${host} » n'est pas un nom d'hôte.`);
    }

    const upstream = await this.fetchIcon(name);

    if (upstream === null) {
      response.status(HttpStatus.NO_CONTENT);

      return undefined;
    }

    // Le type est **imposé**, pas recopié : on ne renvoie pas tel quel ce qu'un
    // tiers a déclaré. Un `text/html` relayé sous notre origine serait du XSS
    // offert à qui saurait faire répondre l'amont autrement.
    response.setHeader('Content-Type', 'image/x-icon');

    return new StreamableFile(upstream);
  }

  /** L'icône en octets, ou `null` si l'amont n'a rien d'utilisable. */
  private async fetchIcon(host: string): Promise<Buffer | null> {
    try {
      const response = await fetch(`${UPSTREAM}/${host}.ico`, {
        // Sans ce garde, un amont qui ne répond pas retient une requête
        // authentifiée jusqu'au timeout du serveur.
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // On ne suit pas les redirections : la destination doit rester celle
        // qu'on a écrite, sinon la garantie du paragraphe d'en-tête tombe.
        redirect: 'error',
      });

      if (!response.ok) return null;

      const bytes = Buffer.from(await response.arrayBuffer());

      // DuckDuckGo rend parfois un corps vide plutôt qu'un 404.
      return bytes.byteLength === 0 ? null : bytes;
    } catch {
      // Réseau coupé, délai dépassé, redirection : dans tous les cas il n'y a
      // pas d'icône, et ce n'est pas une panne de notre API.
      return null;
    }
  }
}
