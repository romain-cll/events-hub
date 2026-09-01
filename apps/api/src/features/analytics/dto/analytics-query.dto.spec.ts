import { analyticsWindowSchema } from './analytics-query.dto';

describe('analyticsWindowSchema', () => {
  it('convertit les bornes en instants absolus', () => {
    const { from, to } = analyticsWindowSchema.parse({
      from: '2026-08-21T00:00:00Z',
      to: '2026-08-22T02:00:00+02:00',
    });

    expect(from.toISOString()).toBe('2026-08-21T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });

  it('sans query, retient les 7 derniers jours', () => {
    const { from, to } = analyticsWindowSchema.parse({});

    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('avec `from` seul, va jusqu’à maintenant', () => {
    const avant = Date.now();
    const { from, to } = analyticsWindowSchema.parse({
      from: '2026-01-01T00:00:00Z',
    });

    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.getTime()).toBeGreaterThanOrEqual(avant);
  });

  it('avec `to` seul, remonte 7 jours en arrière depuis cette borne', () => {
    const { from, to } = analyticsWindowSchema.parse({
      to: '2026-08-22T00:00:00Z',
    });

    expect(to.toISOString()).toBe('2026-08-22T00:00:00.000Z');
    expect(from.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('refuse une fenêtre à l’envers', () => {
    const result = analyticsWindowSchema.safeParse({
      from: '2026-08-22T00:00:00Z',
      to: '2026-08-21T00:00:00Z',
    });

    expect(result.success).toBe(false);
  });

  it('accepte une fenêtre vide (from === to)', () => {
    const result = analyticsWindowSchema.safeParse({
      from: '2026-08-21T00:00:00Z',
      to: '2026-08-21T00:00:00Z',
    });

    expect(result.success).toBe(true);
  });

  it('refuse un paramètre inconnu plutôt que de l’ignorer', () => {
    const result = analyticsWindowSchema.safeParse({
      form: '2026-08-21T00:00:00Z',
    });

    expect(result.success).toBe(false);
  });

  // `interval` a existé jusqu'à l'étape 33 et déclenchait une série
  // quotidienne. Il est parti avec elle : le découpage appartient au lecteur.
  // Le refus n'est pas cosmétique — un signet qui porte encore le paramètre doit
  // se voir, pas produire une réponse silencieusement différente de ce qu'il
  // demande.
  it('refuse `interval`, qui n’existe plus', () => {
    for (const interval of ['day', 'hour', 'week', 'month']) {
      expect(analyticsWindowSchema.safeParse({ interval }).success).toBe(false);
    }
  });

  it('refuse une borne qui n’est pas de l’ISO 8601', () => {
    expect(analyticsWindowSchema.safeParse({ from: '2026' }).success).toBe(
      false,
    );
    expect(analyticsWindowSchema.safeParse({ from: 'hier' }).success).toBe(
      false,
    );
  });
});
