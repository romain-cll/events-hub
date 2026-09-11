import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectCampaign } from './campaign.ts';

/**
 * Ce que le SDK extrait de l'URL, et ce qu'il laisse au serveur.
 *
 * L'essentiel de ces cas porte sur ce qui **n'est pas** fait ici : aucune
 * normalisation, aucune déduction. Une règle qui doit valoir pour tous les
 * clients ne peut pas dépendre de la date du bundle qu'ils ont chargé.
 */

const sur = (search: string) => {
  vi.stubGlobal('window', { location: { search } });
};

describe('collectCampaign', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lit les trois paramètres', () => {
    sur('?utm_source=newsletter&utm_medium=email&utm_campaign=september-drop');

    expect(collectCampaign()).toEqual({
      source: 'newsletter',
      medium: 'email',
      name: 'september-drop',
    });
  });

  it('n’en exige aucun', () => {
    sur('?utm_source=producthunt');

    expect(collectCampaign()).toEqual({
      source: 'producthunt',
      medium: undefined,
      name: undefined,
    });
  });

  it('ne rend rien quand il n’y a pas de campagne', () => {
    // Un objet toujours présent effacerait dès le fil la distinction entre
    // « pas de campagne » et « campagne aux champs vides ».
    sur('?page=2&ref=interne');

    expect(collectCampaign()).toBeUndefined();
  });

  it('ne rend rien sur une URL sans query', () => {
    sur('');

    expect(collectCampaign()).toBeUndefined();
  });

  it('ne normalise pas la casse', () => {
    // Le serveur le fait, et lui seul : deux versions du SDK qui
    // normaliseraient différemment produiraient deux campagnes pour un même
    // site, sans que rien ne le signale.
    sur('?utm_source=Newsletter&utm_campaign=Septembre');

    expect(collectCampaign()).toMatchObject({
      source: 'Newsletter',
      name: 'Septembre',
    });
  });

  it('décode ce que le navigateur a encodé', () => {
    sur('?utm_campaign=rentr%C3%A9e+2026');

    expect(collectCampaign()?.name).toBe('rentrée 2026');
  });

  it('ne prend pas une valeur vide pour une campagne', () => {
    sur('?utm_source=&utm_medium=');

    expect(collectCampaign()).toBeUndefined();
  });

  it('n’invente pas de campagne à partir d’un identifiant de clic', () => {
    // Un `gclid` identifie un clic, pas une campagne. En tirer une source
    // fabriquerait un fait — la même erreur que transformer une absence de
    // referrer en « accès direct ».
    sur('?gclid=Cj0KCQjw&fbclid=IwAR2');

    expect(collectCampaign()).toBeUndefined();
  });

  it('ignore `utm_term` et `utm_content`', () => {
    // Ils répondent à « quelle création », pas à « quelle campagne rapporte ».
    // Ils restent dans `page.url`, entiers.
    sur('?utm_source=ads&utm_term=chaussures&utm_content=variante-b');

    expect(collectCampaign()).toEqual({
      source: 'ads',
      medium: undefined,
      name: undefined,
    });
  });
});
