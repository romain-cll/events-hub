import { createEventSchema } from './create-event.dto';

const validPayload = {
  apiKey: 'eh_pk_7f3f2b1e9c4a4f0d8a112c6d5e4b3a90',
  type: 'page.viewed',
  occurredAt: '2026-08-20T14:30:00.000Z',
  attributes: { 'page.path': '/pricing' },
  properties: { durationMs: 1200 },
};

describe('createEventSchema', () => {
  it('convertit occurredAt en Date', () => {
    const parsed = createEventSchema.parse(validPayload);

    expect(parsed.occurredAt).toBeInstanceOf(Date);
    expect(parsed.occurredAt.toISOString()).toBe('2026-08-20T14:30:00.000Z');
  });

  it('normalise un offset en instant absolu', () => {
    const parsed = createEventSchema.parse({
      ...validPayload,
      occurredAt: '2026-08-20T16:30:00+02:00',
    });

    expect(parsed.occurredAt.toISOString()).toBe('2026-08-20T14:30:00.000Z');
  });

  it('borne la précision à la milliseconde, comme la colonne', () => {
    const parsed = createEventSchema.parse({
      ...validPayload,
      occurredAt: '2026-08-20T14:30:00.123456Z',
    });

    expect(parsed.occurredAt.toISOString()).toBe('2026-08-20T14:30:00.123Z');
  });

  it('remplit attributes et properties quand ils sont absents', () => {
    const parsed = createEventSchema.parse({
      apiKey: validPayload.apiKey,
      type: validPayload.type,
      occurredAt: validPayload.occurredAt,
    });

    expect(parsed.attributes).toEqual({});
    expect(parsed.properties).toEqual({});
  });

  it.each([
    // `type` : ce qui nomme l'événement ne peut pas être vide ni sans limite.
    ['un type vide', { type: '' }],
    ["un type fait d'espaces", { type: '   ' }],
    ['un type trop long', { type: 'a'.repeat(129) }],
    ['un type absent', { type: undefined }],
    ["un type qui n'est pas une chaîne", { type: 42 }],
    // `version` a existé et n'existe plus : `strictObject` fait qu'un client
    // qui l'enverrait encore reçoit un 400 explicite plutôt qu'un champ ignoré
    // en silence. C'est le seul comportement qui rende la suppression visible.
    ['une version, désormais inconnue', { version: 1 }],
    // `occurredAt` : ISO 8601 avec zone, et une date qui existe vraiment.
    ['une date non ISO 8601', { occurredAt: '2026-08-20 14:30:00' }],
    ['une date sans timezone', { occurredAt: '2026-08-20T14:30:00' }],
    ['une date au format FR', { occurredAt: '20/08/2026' }],
    ['une année seule', { occurredAt: '2026' }],
    ["un jour qui n'existe pas", { occurredAt: '2026-02-30T00:00:00Z' }],
    ['un timestamp numérique', { occurredAt: 1755770000000 }],
    ['une date absente', { occurredAt: undefined }],
    // `attributes` / `properties` : des objets, et rien d'autre. Un tableau
    // passerait `typeof x === 'object'` mais se relirait mal en `jsonb`.
    ['des attributes en chaîne', { attributes: 'page.path=/pricing' }],
    ['des attributes en tableau', { attributes: [] }],
    ['des attributes numériques', { attributes: 42 }],
    ['des attributes nuls', { attributes: null }],
    ['des properties en chaîne', { properties: 'plan=pro' }],
    ['des properties en tableau', { properties: ['pro'] }],
    ['des properties nulles', { properties: null }],
    // `apiKey` : le format est vérifié ici pour qu'une clé tronquée produise un
    // 400 lisible plutôt qu'un 401 « clé inconnue », qui enverrait chercher la
    // panne du mauvais côté.
    [
      'une apiKey sans le préfixe attendu',
      { apiKey: 'pk_7f3f2b1e9c4a4f0d8a112c6d5e4b3a90' },
    ],
    ['une apiKey trop courte', { apiKey: 'eh_pk_7f3f2b1e' }],
    ['une apiKey non hexadécimale', { apiKey: `eh_pk_${'z'.repeat(32)}` }],
    ['une apiKey numérique', { apiKey: 123 }],
    ['une apiKey vide', { apiKey: '' }],
    // `projectId` a disparu du contrat : le corps ne choisit plus sa cible.
    [
      'un projectId, qui n’a plus cours',
      { projectId: '7f3f2b1e-9c4a-4f0d-8a11-2c6d5e4b3a90' },
    ],
  ])('rejette %s', (_label, override) => {
    const result = createEventSchema.safeParse({
      ...validPayload,
      ...override,
    });

    expect(result.success).toBe(false);
  });

  it('rejette un event sans apiKey', () => {
    const result = createEventSchema.safeParse({
      type: validPayload.type,
      occurredAt: validPayload.occurredAt,
    });

    expect(result.success).toBe(false);
  });

  it('rejette une clé inconnue plutôt que de la perdre en silence', () => {
    const result = createEventSchema.safeParse({
      ...validPayload,
      occuredAt: '2026-08-20T14:30:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejette les métadonnées réseau envoyées dans le corps', () => {
    // Elles sont lues sur la connexion HTTP, jamais déclarées par le client :
    // un site ne doit pas pouvoir se faire passer pour un autre visiteur.
    for (const usurpation of [
      { ip: '203.0.113.42' },
      { userAgent: 'Mozilla/5.0' },
      { visitorKey: 'a'.repeat(64) },
    ]) {
      const result = createEventSchema.safeParse({
        ...validPayload,
        ...usurpation,
      });

      expect(result.success).toBe(false);
    }
  });

  it('accepte un type métier arbitraire', () => {
    for (const type of [
      'panier.abandonné',
      'checkout_completed',
      'A/B:variant',
    ]) {
      expect(
        createEventSchema.safeParse({ ...validPayload, type }).success,
      ).toBe(true);
    }
  });

  it('accepte des properties de tous les types JSON', () => {
    const properties = {
      chaine: 'pro',
      entier: 3,
      decimal: 1.5,
      booleen: true,
      nul: null,
      tableau: [1, 'deux', { trois: 3 }],
      imbrique: { a: { b: { c: 'd' } } },
    };

    const parsed = createEventSchema.parse({ ...validPayload, properties });

    // Transmis tel quel : `properties` appartient à l'appelant, le schéma ne
    // contraint que son enveloppe.
    expect(parsed.properties).toEqual(properties);
  });

  it('accepte des attributes et des properties vides', () => {
    const parsed = createEventSchema.parse({
      ...validPayload,
      attributes: {},
      properties: {},
    });

    expect(parsed.attributes).toEqual({});
    expect(parsed.properties).toEqual({});
  });

  it('accepte un type de 128 caractères, refuse le 129e', () => {
    expect(
      createEventSchema.safeParse({ ...validPayload, type: 'a'.repeat(128) })
        .success,
    ).toBe(true);
    expect(
      createEventSchema.safeParse({ ...validPayload, type: 'a'.repeat(129) })
        .success,
    ).toBe(false);
  });
});
