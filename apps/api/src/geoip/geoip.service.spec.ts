import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { GeoIpService } from './geoip.service';

/** `ConfigService` réduit à ce que le service consomme : un chemin. */
function serviceAvecBase(path: string | undefined): GeoIpService {
  return new GeoIpService({
    get: () => path,
  } as unknown as ConfigService);
}

/**
 * La base réelle, si elle est là.
 *
 * Elle pèse 124 Mo et n'est pas versionnée (voir `.gitignore`). Les tests qui
 * en dépendent se sautent donc d'eux-mêmes plutôt que d'échouer : un dépôt
 * fraîchement cloné doit passer au vert, sinon c'est la suite entière qui
 * devient facultative dans la tête de celui qui la lance.
 *
 * Ce qui n'est **pas** facultatif, c'est le comportement sans base — testé plus
 * bas, sans condition, parce que c'est celui que tourne un environnement neuf.
 */
const BASE = resolve(__dirname, '../../data/dbip-city-lite-2026-08.mmdb');
const avecBase = existsSync(BASE) ? describe : describe.skip;

describe('GeoIpService', () => {
  describe('sans base', () => {
    it('démarre quand même quand le chemin est absent', async () => {
      const service = serviceAvecBase(undefined);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('démarre quand même quand le fichier n’existe pas', async () => {
      // Le cas d'un `.env` copié sur un poste où la base n'a pas été
      // téléchargée. L'ingestion est le chemin critique du produit : la faire
      // tomber pour une carte serait perdre les événements pour ne pas perdre
      // un affichage.
      const service = serviceAvecBase('/nowhere/absente.mmdb');

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('rend trois `null` plutôt que de lever', async () => {
      const service = serviceAvecBase(undefined);
      await service.onModuleInit();

      expect(service.locate('80.15.0.1')).toEqual({
        countryCode: null,
        region: null,
        city: null,
      });
    });
  });

  avecBase('avec la base', () => {
    let service: GeoIpService;

    beforeAll(async () => {
      service = serviceAvecBase(BASE);
      await service.onModuleInit();
    });

    it('résout une IPv4 en pays, région et ville', () => {
      expect(service.locate('80.15.0.1')).toEqual({
        countryCode: 'FR',
        region: 'Île-de-France',
        city: 'Aubervilliers',
      });
    });

    it('résout aussi une IPv6', () => {
      // Le SDK tourne dans des navigateurs qui sortent en v6 par défaut chez
      // beaucoup d'opérateurs : l'oublier viderait la carte pour une part du
      // trafic sans que rien ne le signale.
      expect(service.locate('2a01:e0a::1').countryCode).toBe('FR');
    });

    it('rend trois `null` sur une adresse de bouclage', () => {
      // C'est le cas **normal** en développement, pas une erreur : `::1` n'a
      // pas de pays, et une session locale n'en portera donc pas.
      expect(service.locate('127.0.0.1')).toEqual({
        countryCode: null,
        region: null,
        city: null,
      });
    });

    it('rend trois `null` sur ce qui n’est pas une adresse', () => {
      // L'entrée vient d'un en-tête `X-Forwarded-For` quand un proxy est
      // déclaré : elle n'est pas toujours ce qu'elle prétend être.
      expect(service.locate('pas-une-ip')).toEqual({
        countryCode: null,
        region: null,
        city: null,
      });
    });
  });
});
