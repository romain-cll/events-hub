# Site externe de test

Page HTML statique, servie sur une **autre origine** que l'API et que le
dashboard. Elle sert à vérifier une seule chose : le SDK est utilisable par
n'importe quel site, sans rien partager avec notre application.

```sh
pnpm --filter @events-hub/sdk demo:site   # build + serveur statique sur :4000
```

Puis ouvrir <http://localhost:4000/example/> (l'API doit tourner sur `:3003`).

La page n'appelle **aucun** `track()` : elle fait `analytics.start()` et laisse
les collecteurs travailler. Un parcours complet — cliquer, chercher, naviguer,
puis suivre le lien sortant — doit produire :

```
page_view      fetch    {"navigation.type":"initial"}
click          fetch    {"element.tag":"button","element.id":"filtrer",…}
submit         fetch    {"form.id":"recherche","form.action":…,"form.method":"get"}
page_view      fetch    {"navigation.type":"push_state","navigation.from":"/example/"}
click          fetch    {"element.tag":"a","element.id":"sortie",…}
outbound_click fetch    {"link.origin":"https://example.com",…}
page_leave     keepalive {"leave.reason":"outbound_click"}
```

Deux choses à vérifier de ses yeux sur cette page :

- **pushState vers la même URL ne produit rien.** C'est l'anti-doublon ; sans
  lui le trafic serait compté deux fois sur tout site dont le routeur normalise
  l'URL au montage.
- **`page_leave` part en `keepalive`, pas par un `fetch` ordinaire.** C'est ce
  qui lui permet de survivre à la mort de la page — et la raison pour laquelle
  ce n'est pas `sendBeacon` est mesurable ici : son preflight CORS
  (`application/json`) ne survit pas au déchargement.

Le formulaire annule sa soumission native (comportement d'une SPA) pour qu'on
reste sur la page et qu'on voie la suite de la séquence — le `submit` part
quand même, le collecteur écoute l'événement et pas la navigation.

Le journal affiché est produit par la page elle-même, qui enveloppe `fetch` et
`sendBeacon` pour les donner à voir. Le SDK n'expose pas de hook de ce genre :
ce n'est pas son travail.
