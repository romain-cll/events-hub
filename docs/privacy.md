# Privacy, for the site that installs the hub

_A compliance support document, not legal advice. It states what the code does,
precisely enough for your DPO to work from — the conclusions you draw for your own
installation are yours._

Two things settle almost every question on this page:

- **Nothing is read from or written to the visitor's device in the default mode.**
  No cookie, no local storage, nothing. That is what puts it outside Article 5(3)
  of the ePrivacy Directive and Article 82 of the French Data Protection Act. The
  one exception proves it rather than weakening it: a visitor who _objects_ gets a
  cookie recording that refusal, which Article 5(3) exempts as strictly
  necessary — see [the right to object](#the-right-to-object).
- **The IP address and the browser identification string are never stored.** They
  enter the server, three coarse labels and a visitor key are derived from them,
  and they die with the request.

The rest is detail — but the detail is here, because you are the one who has to
declare it.

## The two modes

The hub has one identification mechanism with two regimes. You choose which one a
visitor is under by relaying your consent platform's answer; the hub never shows a
banner of its own.

|                                  | **Default**                                                                            | **Consented**                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Written on the device            | nothing, unless the visitor objects                                                    | `__Host-eh_vid` on the hub's domain, 13 months, plus a readable copy `eh_visitor_id` on yours |
| Read from the device             | nothing, unless the visitor objected                                                   | that cookie                                                                                   |
| How the visitor is identified    | `HMAC(daily secret, project id + IP + User-Agent)`                                     | `HMAC(master secret, project id + a random UUID we issued)`                                   |
| How long that identity lasts     | until 00:00 UTC                                                                        | 13 months from the day consent was given, never extended                                      |
| Recognised tomorrow              | no                                                                                     | yes                                                                                           |
| Recognised on another site       | no                                                                                     | no                                                                                            |
| Answers                          | visitors, sessions, bounce, pages, sources, devices, countries                         | all of the above, plus returning visitors, revenue attribution, LTV, time to purchase         |
| ePrivacy art. 5(3) / art. 82 LIL | out of scope — no read, no write                                                       | consent required, and **you** collect it                                                      |
| GDPR basis                       | legitimate interest, art. 6(1)(f) — see [the LIA](./legitimate-interest-assessment.md) | consent, art. 6(1)(a)                                                                         |
| Banner                           | none needed                                                                            | yours                                                                                         |

Both modes are **partitioned by project**: the project id is inside the hash, so
the same person on two of your sites is two unrelated keys, and the durable cookie
is `Partitioned`, which means the browser itself double-keys it to the site where
it was set. There is no cross-site profile to build, and no switch that would
build one.

### Switching between them

```js
window.eventsHub.setConsent(true); // durable identity from this event on
window.eventsHub.setConsent(false); // cookie erased, immediately
```

The signal has **three** states, and the third is not a refusal:

| Signal     | What happens                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`     | An identifier is issued on the spot, or the one already presented is honoured untouched.                                                          |
| `false`    | The cookie is erased, the copy on your domain is erased, and the visitor falls back to the derived key **on that same event** — not the next one. |
| never sent | Nothing is written. A cookie already presented is still honoured: its existence _is_ the record of an earlier consent.                            |

Confusing the third with the second would wipe every visitor's identity the first
time a site without a consent platform sent an event.

## What is collected

### Derived from the connection, then dropped

| Input      | What is derived                                                          | What becomes of the input       |
| ---------- | ------------------------------------------------------------------------ | ------------------------------- |
| IP address | the visitor key; country code, region name, city name                    | discarded when the request ends |
| User-Agent | the visitor key; browser name, OS name, device family, declared-bot flag | discarded when the request ends |

Neither is written to the event, to the visit, or to any table. Geolocation is a
local file lookup (DB-IP City Lite, on disk): **no IP leaves the server**, and no
third party is called. Latitude and longitude are available in that file and are
deliberately not read — coordinates to the metre are not audience data.

Version numbers are dropped too: minor versions are noise that multiplies
uniqueness, and OS versions are simply wrong (Windows 11 reports "Windows NT
10.0", macOS has reported "10_15_7" for years).

### Stored on the visit

One row per visit — a run of events from the same visitor with no gap longer than
thirty minutes.

| Column                        | Content                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| visitor key                   | the HMAC above. Rotates daily in the default mode.                                                                                                                                                                                          |
| started at                    | timestamp of the earliest event in the visit                                                                                                                                                                                                |
| country code, region, city    | coarse, all optional, resolved once when the visit opens                                                                                                                                                                                    |
| browser, OS, device type      | coarse labels, all optional                                                                                                                                                                                                                 |
| is bot                        | true only for a client that **declared** itself a robot                                                                                                                                                                                     |
| campaign source, medium, name | from `utm_source`, `utm_medium`, `utm_campaign`, lowercased, frozen when the visit opens                                                                                                                                                    |
| consent                       | accepted, refused, or **empty** — empty meaning the visitor was never asked, which is the default mode. Not proof of anything: no identity, no timestamp of the act. Last answer wins, since a banner is often answered on the second page. |

### Stored on the event

`type` (your own name for it), `occurredAt`, `source` (`browser` or `server`,
derived from the key class, never read from the payload), the visit it belongs to
(null for anything with no visit: a deploy, a payment, a probe), the **durable**
visitor key when there is one, and two opaque JSON bags: `attributes` and
`properties`.

The durable key column never holds the derived key. Without consent, a payment is
correlatable to nothing — that is the design, not a gap in it.

### Sent by the browser SDK, on every event

| Key                             | Value                                                |
| ------------------------------- | ---------------------------------------------------- |
| `sdk.version`                   | which build sent this                                |
| `page.path`                     | pathname                                             |
| `page.url`                      | **the full URL**, query string and fragment included |
| `page.referrer`                 | omitted entirely when empty                          |
| `browser.language`              | `navigator.language`                                 |
| `screen.width`, `screen.height` | screen size in CSS pixels                            |

⚠️ **`page.url` is sent whole.** If your URLs carry personal data — an email in a
query string, a token in a fragment — it is stored verbatim. The hub treats both
bags as opaque and never reads inside them, which also means it cannot filter them
for you. Deciding what belongs in a URL is your job, and it always was.

### Collected automatically by the SDK

| Event            | Properties                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `page_view`      | `navigation.type`, `navigation.from`                                                        |
| `click`          | `element.tag`, `element.id`, `element.name`, `element.type`, `element.role`, `element.href` |
| `submit`         | `form.id`, `form.name`, `form.action`, `form.method`                                        |
| `outbound_click` | the `element.*` above, plus `link.origin`                                                   |
| `page_leave`     | `leave.reason`                                                                              |

A form submission records the form's **identity, never its field values**. There
is no keystroke capture, no mouse tracking, no session replay, no screenshots, no
canvas or font fingerprinting. Any collector can be turned off at startup.

### Revenue events, if you connect Stripe

`stripe.event.id`, `stripe.event.type`, `stripe.object.id`, `stripe.customer.id`,
`stripe.billing_reason`, `stripe.livemode`, `payment.amount` (in cents),
`payment.currency`. No name, no email, no address, no card data — the full Stripe
object is not copied, and Stripe remains its source.

One mapping table pairs a Stripe customer id with the durable visitor id in clear,
because a renewal billed eleven months later has no browser behind it and nothing
else would attach it to the visit that produced it. That table only ever holds
identifiers a visitor consented to.

## What is never collected

- the IP address, and the raw User-Agent
- browser, OS and engine versions; device brand and model
- latitude and longitude
- any cross-site identifier, in either mode
- anything sold, shared with an advertising network, or used to target ads —
  there is no ad tech in this product, and the SDK loads no other script and
  calls no other host than the hub

Two honest qualifications. The default-mode key **is derived from IP and
User-Agent**, which is a form of probabilistic identification — it is salted per
project, rotated daily and one-way, but it is not anonymisation, and this document
never calls it that. And the coarse labels stored on the visit do not make anyone
more recognisable than the key already does; what bounds the risk is where they
live, not how vague they are.

## Roles

**You are the controller. The hub is a processor.** You decide why events are
collected and what you send; the hub routes, stores and counts, and never decides
what an event means.

What that puts on you:

| Obligation                               | What it looks like here                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Art. 28 — a written processing agreement | to be signed with whoever operates the hub for you; if you self-host, the question does not arise                                                                                                                                                                                                                                                                                                                          |
| Art. 30 — record of processing           | one entry for audience measurement, one for revenue attribution if you use it; the tables above are the "categories of data"                                                                                                                                                                                                                                                                                               |
| Art. 13 — informing visitors             | the paragraph below                                                                                                                                                                                                                                                                                                                                                                                                        |
| Art. 7 — collecting and proving consent  | entirely yours. **The hub keeps no proof of consent, on purpose**: duplicating your record here would make us retain data nobody asked us for. What it does keep is one anonymous flag per visit — accepted, refused, or never asked — with no identity and no timestamp of the act, so that a site can count how many visitors decline the attribution cookie. It proves nothing and is purged with its row at 25 months. |
| Art. 15 / 17 — access and erasure        | see below; the default mode is an Article 11 case                                                                                                                                                                                                                                                                                                                                                                          |
| Retention                                | 25 months, purged daily — confirm it is enabled on your instance before you declare it                                                                                                                                                                                                                                                                                                                                     |
| Where the data sits                      | a deployment fact. Fill it in for your own record — nobody else can.                                                                                                                                                                                                                                                                                                                                                       |

Mark as **server only** any event type a page must not be able to forge —
payments, entitlements. A browser key can write `source: browser` and nothing
else, so the flag is enforceable rather than decorative.

## The paragraph to paste

Trim whichever half does not apply to you. Square brackets are yours to fill.

```text
Audience measurement

We measure how this site is used with events-hub, which processes data on our
behalf, as our processor and on our instructions. It records page views, clicks,
form submissions, outbound clicks and page exits, together with the page address,
the referring page, your browser language and screen size, and a coarse location
(country, region, city) and device description (browser, operating system, device
type) derived from your IP address and your browser's identification string.

Neither your IP address nor your browser's identification string is stored. They
are used only to derive the information above and a visitor identifier, then
discarded when the request ends. That identifier is a one-way cryptographic value,
specific to this site, and it is regenerated every day: it cannot be used to
recognise you from one day to the next, nor to recognise you on any other site.
Nothing is read from or written to your device for this measurement, so it
requires no consent. We carry it out on the basis of our legitimate interest in
understanding and improving our service (Article 6(1)(f) GDPR), and you may object
to it at any time using the contact details below.

If you accept measurement cookies, we additionally store a randomly generated
identifier in a cookie valid for 13 months, so that we can recognise a returning
visit and connect a purchase to the visit that led to it. This is based on your
consent (Article 6(1)(a) GDPR, Article 82 of the French Data Protection Act),
which you may withdraw at any time at [link to your consent settings], with effect
for the future. The cookie is partitioned to this site and cannot be read by, or
combined with your activity on, any other site.

We retain this data for 25 months. We do not sell it, do not share it with
advertising networks, and do not use it to build a profile of you outside this
site. You may request access to or deletion of your data at [contact]. In the
default mode above we hold no means of identifying you, so we may be unable to
match a request to any record (Article 11 GDPR).
```

⚠️ **Check the retention sentence against your own instance before publishing
it.** The 25-month purge is implemented and scheduled by default, but it can be
switched off per instance (`RETENTION_ENABLED=false`). A stated retention period
that is not enforced is worse than none, because it is a claim rather than a gap.

## The right to object

Article 21(1) makes objection to legitimate-interest processing unconditional. All
five paths work today.

| Path                              | Effect                                                                                                 | Status      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| Removing the SDK for that visitor | nothing reaches the hub                                                                                | works today |
| `setConsent(false)`               | the durable cookie and its copy are erased on that event; the visitor returns to the daily derived key | works today |
| Clearing browser cookies          | the durable identity is gone; a new one is only issued on a fresh consent                              | works today |
| `Sec-GPC: 1` request header       | the event is discarded at ingestion, nothing written, nothing stored on the device, `204` returned     | works today |
| `window.eventsHub.optOut()`       | the SDK stops its collectors and remembers the choice on the device                                    | works today |

Withdrawing consent is **not** the same as objecting: it returns a visitor to the
default mode, it does not stop measurement.

`Sec-GPC` is honoured on the exact value `1` and nothing else — an absent, empty
or `0` header does not say "I refuse", it says nothing, and treating any presence
as a refusal would discard traffic on a malformed header. It sets **no cookie**:
the browser resends the header on every request, so there is nothing to remember.
A visitor who turns the signal off returns to the default mode immediately, which
is the coherent outcome — they have just withdrawn what carried their refusal.

`optOut()` stops the collectors and sends one last event carrying the decision;
that event is discarded on arrival without being written, and it is what makes the
refusal outlive the tab. `optIn()` reverses it, and deliberately does **not**
restart the collectors — the site decides that, through `start()`.

Note the small irony in `optOut()`: remembering a refusal means writing to the
device. That write is permitted without consent precisely because it serves the
visitor's own expressed choice — CNIL names the refusal cookie among the exempt
trackers — and it is why the marker holds nothing but the refusal itself. The
cookie is `__Host-eh_optout`, its value is `1`, it carries no identifier, and it
lasts 13 months, refreshed on each event. An opt-out that told people apart would
be the very tracker it exists to switch off.

## Retention

**25 months**, the ceiling CNIL recommends for audience measurement data. A purge
runs every day at 03:15 UTC, across the whole platform — no project is partitioned
out of it, precisely so that none can escape it.

| What                                                      | What happens at 25 months                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A visit whose **every** event is past the limit           | deleted, with all of its events                                                                                                              |
| A visit with any recent event                             | kept whole. The cut is driven by the visit, never by the date of a single event, so no orphan row and no half-emptied path is ever produced. |
| An event with **no** visit — a payment, a deploy, a probe | kept, and its durable visitor identity is erased                                                                                             |

The asymmetry is deliberate and it comes from the product. What the law requires
is forgetting **who**, not forgetting that a payment happened: a revenue figure
three years back is still countable, it simply no longer points at anyone. An
event that belonged to a visit gets no such treatment — its value _is_ the path,
and a path with the visitor removed describes nothing.

Two things to check on your own installation: that `RETENTION_ENABLED` is not set
to `false`, and that 25 months is the period you actually want to declare. The
period itself is a constant in the code, not an environment variable — a purge is
irreversible, and a wrong value typed into a `.env` would be discovered only by
what is missing.

Deleting a project remains the other, deliberate path: it removes all of its
events and visits in one transaction. It is the only other thing that destroys
measurement data, so that deleting an organisation cannot do it as a side
effect.

## Access and erasure requests

**Default mode.** The hub cannot identify a visitor. Given a name, an email or an
account id, there is nothing to search on: the only identifier is a hash of an IP
and a User-Agent we no longer hold, under a secret that changed every day since.
This is the Article 11 situation, and saying so plainly in your reply is the
correct answer, not an evasion.

**Consented mode.** The identifier is on your own domain (`eh_visitor_id`) and in
your Stripe metadata, so the rows are findable. Deleting by visitor id is not
exposed in the dashboard yet; today it takes a direct query against the database.

## What is yours, not ours

- **The two bags.** `attributes` and `properties` are never read by the hub. If
  you put personal data in them, it is stored, and it is your record of processing
  that has to say so.
- **Your URLs.** See `page.url` above.
- **Consent and its proof.** No consent log lives here — only an anonymous
  accepted / refused / never-asked flag on each visit, which proves nothing and
  is purged with the visit.
- **`TRUST_PROXY_HOPS`,** if you self-host. It must equal the real number of
  reverse proxies. Set too high, a client can forge its own `X-Forwarded-For` —
  and therefore its own visitor key and country.

## The fine print

Three limits that are real, bounded, and better said here than discovered later.

- **Thirty minutes after midnight UTC, two keys of the same visitor coexist.** The
  rotation would otherwise cut a visit in half at midnight and count one person
  twice, every night, on the same hour. The visit that crosses midnight keeps the
  previous day's key; nothing is rewritten. The rotation boundary is crossable on
  that window, and nowhere else.
- **The daily secret is derived from a master secret**, so it remains recomputable
  for any past day as long as that master secret exists. A per-day random secret
  destroyed after 48 hours would make yesterday's keys permanently irreversible.
  That is the next step, not this one.
- **The IPv4 space is small.** Whoever holds the secret can test four billion
  addresses and recover the mapping. The guarantee does not rest on the hash, it
  rests on the secret not living next to the data: the database contains no
  secret.

One legal caveat belongs here too. EDPB Guidelines 2/2023 on the technical scope
of Article 5(3), final since October 2024, read "gaining access to information
stored in the terminal equipment" broadly enough that an IP address emitted by the
terminal on a script's instruction can arguably qualify. Under that reading, even
the default mode would need consent. CNIL has not applied it that way in practice,
and the position taken here is defensible — but it is not risk-free, and
[the LIA](./legitimate-interest-assessment.md) sets out what would follow if the
broad reading prevailed.
