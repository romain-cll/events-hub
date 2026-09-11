import { normalizeCampaign } from './campaign';

/**
 * La normalisation, et ce qu'elle refuse de faire.
 *
 * Elle vit côté serveur pour une raison qui se teste mal mais se dit bien : si
 * chaque version du SDK normalisait à sa façon, deux visiteurs d'un même site
 * produiraient deux campagnes selon la date de leur bundle, et rien ne le
 * signalerait sinon un classement qui se dédouble.
 */
describe('normalizeCampaign', () => {
  it('unifie les casses', () => {
    // Les plateformes publicitaires et les humains les mélangent. Sans cette
    // ligne, un classement montre trois campagnes là où il y en a une.
    expect(normalizeCampaign({ source: 'Newsletter' })?.source).toBe(
      'newsletter',
    );
    expect(normalizeCampaign({ source: 'NEWSLETTER' })?.source).toBe(
      'newsletter',
    );
  });

  it('retire les espaces de bord', () => {
    expect(normalizeCampaign({ name: '  rentrée 2026  ' })?.name).toBe(
      'rentrée 2026',
    );
  });

  it('rend `null` sur un champ vide, jamais une chaîne vide', () => {
    // Une chaîne vide obligerait chaque lecture en aval à distinguer deux cas
    // qui n'en font qu'un.
    expect(normalizeCampaign({ source: 'ads', medium: '   ' })).toEqual({
      source: 'ads',
      medium: null,
      name: null,
    });
  });

  it('rend `null` quand les trois champs sont vides', () => {
    expect(normalizeCampaign({ source: '', medium: '', name: '' })).toBeNull();
    expect(normalizeCampaign({})).toBeNull();
    expect(normalizeCampaign(undefined)).toBeNull();
  });

  it('n’exige pas les trois', () => {
    // Une campagne sans medium est courante, et la refuser perdrait la source.
    expect(normalizeCampaign({ source: 'producthunt' })).toEqual({
      source: 'producthunt',
      medium: null,
      name: null,
    });
  });

  it('tronque plutôt que de refuser', () => {
    // La colonne est indexée et une query n'est bornée par rien. Jeter la ligne
    // ferait perdre la visite entière pour un libellé aberrant.
    const long = 'a'.repeat(500);

    expect(normalizeCampaign({ name: long })?.name).toHaveLength(200);
  });
});
