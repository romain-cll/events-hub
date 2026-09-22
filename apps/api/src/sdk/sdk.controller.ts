import { Controller, Get, Header } from '@nestjs/common';

import { Public } from '../auth/auth.decorators';
import { SdkService } from './sdk.service';

/**
 * `GET /v1/eh.js` — le script que le snippet d'installation charge.
 *
 * ## Public, évidemment
 *
 * Il est chargé par le navigateur des visiteurs des sites clients, qui n'ont
 * aucun compte chez nous. C'est la même situation que l'ingestion, et pour la
 * même raison : ce n'est pas une ressource du dashboard.
 *
 * Une balise `<script src>` est une requête *no-cors* — la réponse est
 * exécutée sans que ses en-têtes d'origine soient examinés. La politique CORS
 * « dashboard » que traverse cette route (voir `app.setup.ts`) ne la gêne donc
 * pas, et il n'y a rien à ouvrir de plus.
 *
 * ## Versionné, et c'est ce qui fait tenir la déduction d'adresse
 *
 * Le script déduit l'adresse d'ingestion de son propre `src`, par résolution
 * **relative** : servi en `/v1/eh.js`, il poste sur `/v1/events`. Le jour d'un
 * `/v2`, les deux bougent ensemble et les sites déjà installés continuent de
 * parler la version qu'ils ont chargée.
 *
 * ## Cinq minutes de cache
 *
 * Assez pour que les rechargements d'un même visiteur ne repassent pas par le
 * réseau, assez court pour qu'un correctif se propage dans la journée sans
 * qu'on ait à renommer le fichier. Nest laisse Express calculer l'`ETag`, donc
 * la revalidation qui suit rend un 304 vide.
 *
 * ## Le corps est **rendu**, jamais envoyé à la main
 *
 * Un `@Res({ passthrough: true })` doublé d'un `response.send()` répond deux
 * fois : le handler envoie le script, puis Nest sérialise à son tour la valeur
 * rendue et se heurte à des en-têtes déjà partis
 * (`ERR_HTTP_HEADERS_SENT`). Le client, lui, a bien reçu le script — l'erreur
 * n'existe que dans les journaux du serveur, ce qui la rend invisible aux tests
 * et ne se remarque qu'en lisant la console un jour où quelqu'un charge
 * vraiment le script.
 *
 * Il faut rendre une **chaîne**, pas le tampon : Nest sérialise en JSON tout ce
 * qui n'est pas une chaîne, et un `Buffer` part alors en
 * `{"type":"Buffer","data":[…]}` — du JSON valide, servi en `text/javascript`,
 * qu'aucun navigateur n'exécute. Les deux `@Header` sont déjà posés, et Express
 * calcule l'`ETag` sur ce qu'il envoie.
 */
@Public()
@Controller({ path: 'eh.js', version: '1' })
export class SdkController {
  constructor(private readonly sdk: SdkService) {}

  @Get()
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  async serve(): Promise<string> {
    return (await this.sdk.bundle()).toString('utf8');
  }
}
