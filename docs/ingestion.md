# Sending events

Everything reaches the hub through one endpoint:

```
POST /v1/events
```

There is no second route for server-side sources. You present a key, and the key
decides how the event is treated.

## The two kinds of key

|                   | `eh_pk_` — browser                     | `eh_sk_` — server                |
| ----------------- | -------------------------------------- | -------------------------------- |
| Where it lives    | your page bundle, in the open          | your backend, secret             |
| Stored as         | plain text                             | a hash — shown once, at creation |
| `Origin` header   | required, checked against an allowlist | not sent, not checked            |
| Session           | assigned, from the visitor             | none                             |
| Recorded `source` | `browser`                              | `server`                         |

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

| Field        | Required | What it is                                                                                                                         |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`     | yes      | `eh_pk_` or `eh_sk_` followed by 32 hex characters.                                                                                |
| `type`       | yes      | Your own name for the event, in `snake_case`. Anything you like — no list to register first.                                       |
| `occurredAt` | yes      | ISO 8601 with an offset (`…Z` or `…+02:00`). When the event _happened_, not when you send it — late arrivals are placed correctly. |
| `properties` | no       | What the event says about itself. Free-form JSON, kept intact. Defaults to `{}`.                                                   |
| `attributes` | no       | Context around the event. The browser SDK puts page path, referrer and screen size here. Defaults to `{}`.                         |

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

| Status | Meaning                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201`  | Written. The body is the stored event.                                                                                                                    |
| `204`  | Discarded on purpose, browser keys only: the `Origin` header was missing or not on the allowlist. Nothing was written, and this is not an error to retry. |
| `400`  | The body is malformed — a bad key format, a missing field, an unknown field.                                                                              |
| `401`  | The key does not exist, or has been revoked.                                                                                                              |
| `422`  | The body is well formed but names a project that no longer exists.                                                                                        |

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
<script
  defer
  src="https://your-hub.example/v1/eh.js"
  data-api-key="eh_pk_…"
></script>
```

For your own events: `window.eventsHub.track('signed_up')`.

## Consent, and the durable visitor

By default the hub identifies visitors without storing anything on their device:
the key it derives rotates every day, which is enough to count people and not
enough to follow them. Nothing to display, no banner, no cookie.

Relaying your consent platform's decision unlocks the durable mode:

```js
window.eventsHub.setConsent(true); // and false when it is withdrawn
```

We never show a banner of our own — you are the controller, we are the processor.
The SDK only carries the answer you already have.

## Linking a payment to a visit

With consent, the hub keeps a durable id for the visitor. It lives in a cookie on
**our** domain, so your code cannot read it — which is exactly what lets it last
13 months instead of the seven days Safari grants to cookies written in
JavaScript.

That cookie is set once and never refreshed, so it expires 13 months after the
day the visitor accepted, not 13 months after their last visit. Asking again
before it lapses is your consent platform's job, not ours.

So the SDK writes a readable copy on **your** domain, `eh_visitor_id`, and rewrites
it on every page view. Read it like any of your own cookies:

```js
const visitorId = cookies().get('eh_visitor_id')?.value;

await stripe.checkout.sessions.create({
  // …
  metadata: { eh_visitor_id: visitorId },
});
```

**Put it on the Customer too, not just the session.** A subscription renewal is
billed months later, with no browser anywhere near it — without the id on the
Customer, only the first payment is ever attributable and everything after it
lands nowhere.

```js
await stripe.customers.update(customerId, {
  metadata: { eh_visitor_id: visitorId },
});
```

Building your checkout in the browser instead? `window.eventsHub.getVisitorId()`
returns the same value, once the first event has come back. The cookie is the
recommended path: it does not depend on that ordering.

No consent means no durable id. That does not leave you with nothing — read on.

## Attributing revenue without consent

Every response carries a `sessionId`: the visit the event belongs to. Unlike the
durable id, it costs no consent, because nothing is written to the visitor's
device to produce it. It lives in the HTTP response and nowhere else.

```js
const sessionId = window.eventsHub.getSessionId();

await stripe.checkout.sessions.create({
  // …
  metadata: { eh_session_id: sessionId },
});
```

Post it to your own backend when you build the checkout, the same way you would
any value your page holds. There is no cookie to read here — writing one is
exactly what this path avoids.

**Send both when you have both.** If the visitor consented, put `eh_visitor_id`
on the Customer as described above _and_ `eh_session_id` on the session. We
prefer the durable id whenever it is present; you never have to choose.

### What it buys, and what it does not

|                                    | `eh_visitor_id`               | `eh_session_id`                  |
| ---------------------------------- | ----------------------------- | -------------------------------- |
| Consent                            | required                      | none                             |
| First purchase                     | attributed                    | attributed                       |
| Purchase days later                | attributed to the first visit | attributed to _that day's_ visit |
| Subscription renewal               | attributed                    | never                            |
| Lifetime value, cohorts, retention | yes                           | no                               |

The middle row is the one to understand. A visitor who finds you through a search
on Monday and buys on Thursday opens two visits; the payment lands on the second,
whose referrer is usually empty. So direct traffic is over-credited and the real
acquisition channel under-credited — systematically, not randomly.

That bias is the price of not asking. It is a floor, not a ceiling: consent
removes it, and the two mechanisms are designed to run side by side.

### Payment links

A payment link opened from an email is not a visit on your site, so there is
nothing to attribute it to. Put `eh_visitor_id` on the Customer and renewals
still land correctly; the first payment through such a link will not.
