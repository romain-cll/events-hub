# Sending events

Everything reaches the hub through one endpoint:

```
POST /v1/events
```

There is no second route for server-side sources. You present a key, and the key
decides how the event is treated.

## The two kinds of key

| | `eh_pk_` — browser | `eh_sk_` — server |
|---|---|---|
| Where it lives | your page bundle, in the open | your backend, secret |
| Stored as | plain text | a hash — shown once, at creation |
| `Origin` header | required, checked against an allowlist | not sent, not checked |
| Session | assigned, from the visitor | none |
| Recorded `source` | `browser` | `server` |

Create either from **Settings → API keys** in the dashboard.

A browser key is not a secret and does not pretend to be one. It names a project;
it opens nothing. The origin allowlist is **data hygiene**, not security — it stops
a snippet copied onto another site, a staging environment, a forked template. It
does not stop a deliberate `curl`.

A server key is a real secret. Keep it where you keep your other credentials. We
store only a hash, so if you lose it, nobody — us included — can recover it.
Create a new one and revoke the old.

## The request

```bash
curl -X POST https://your-hub.example/v1/events \
  -H 'Content-Type: application/json' \
  -d '{
    "apiKey": "eh_sk_…",
    "type": "deployment",
    "occurredAt": "2026-08-30T12:41:04.000Z",
    "properties": { "release.tag": "v1.5.0" }
  }'
```

| Field | Required | What it is |
|---|---|---|
| `apiKey` | yes | `eh_pk_` or `eh_sk_` followed by 32 hex characters. |
| `type` | yes | Your own name for the event, in `snake_case`. Anything you like — no list to register first. |
| `occurredAt` | yes | ISO 8601 with an offset (`…Z` or `…+02:00`). When the event *happened*, not when you send it — late arrivals are placed correctly. |
| `properties` | no | What the event says about itself. Free-form JSON, kept intact. Defaults to `{}`. |
| `attributes` | no | Context around the event. The browser SDK puts page path, referrer and screen size here. Defaults to `{}`. |

Unknown fields are **rejected**, not ignored. A misspelled `occuredAt` returns 400
rather than silently dropping the timestamp.

## Compatibility

The contract is the `/v1` in the URL, and nothing else. There is no version field
in the payload — one used to exist, and it recorded nothing, because nothing ever
read it.

What that means for you:

- **Inside `/v1`, we only ever add optional things.** A new field arrives with a
  default; nothing you already send stops working.
- **A breaking change becomes `/v2`**, served alongside `/v1`. You move when you
  choose to.
- **`attributes` and `properties` are opaque to us.** We read no key inside them,
  so you can add, rename or drop your own keys without telling us — and so can our
  SDK, which is why an SDK update cannot break your ingestion.

The browser SDK reports itself in `attributes` as `sdk.version`. It is there for
one purpose: identifying which build sent something, the day one of them sends
something wrong.

## What comes back

| Status | Meaning |
|---|---|
| `201` | Written. The body is the stored event. |
| `204` | Discarded on purpose, browser keys only: the `Origin` header was missing or not on the allowlist. Nothing was written, and this is not an error to retry. |
| `400` | The body is malformed — a bad key format, a missing field, an unknown field. |
| `401` | The key does not exist, or has been revoked. |
| `422` | The body is well formed but names a project that no longer exists. |

The `204` is deliberate. A `4xx` on a capture endpoint sends client SDKs into retry
loops, amplifying exactly the traffic we are trying to drop. Refusals are logged
server-side instead.

## Naming your events

The first time a `type` arrives, it is added to the project's vocabulary — you do
not declare anything up front. From **Settings** you can then give it a readable
label, and mark it **server only**.

Marking a type server only means: events of that name that came from a browser stop
being shown, everywhere. It applies to what is already stored, and it is reversible.
Use it for anything a page must not be able to forge — payments, entitlements,
anything you would not want a visitor to write.

## Deployments, from CI

Nothing else is needed — a deployment is an ordinary event that happens to have no
visitor.

```yaml
- name: Tell the hub
  run: |
    curl -sS -X POST https://your-hub.example/v1/events \
      -H 'Content-Type: application/json' \
      -d "{
        \"apiKey\": \"$EVENTS_HUB_KEY\",
        \"type\": \"deployment\",
        \"occurredAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"properties\": { \"release.tag\": \"${{ github.ref_name }}\" }
      }"
  env:
    EVENTS_HUB_KEY: ${{ secrets.EVENTS_HUB_KEY }}
```

One project is one environment, so there is nothing to put in the payload that says
which one — the key already says it.

## Events without a visitor

An event sent with a server key has no session, because there is no visitor to
attach it to. That is a fact about the event, not missing data.

What follows from it: deployments, payments and probes appear in the event log, and
they do **not** move visitor or session counts. You can send a thousand of them
without touching your analytics.

## From a browser

Use the SDK rather than this endpoint — it collects page views, clicks, form
submits, outbound clicks and page leaves on its own, and sends them for you.

```html
<script defer src="https://your-hub.example/v1/eh.js" data-api-key="eh_pk_…"></script>
```

For your own events: `window.eventsHub.track('signed_up')`.
