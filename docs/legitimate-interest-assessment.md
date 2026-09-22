# Legitimate interest assessment — default measurement mode

*A compliance support document, not legal advice. It is written to be read by a
DPO, contested where it deserves to be, and re-run when the facts change.*

**Scope.** The **default mode** only — measurement without anything read from or
written to the visitor's device, under Article 6(1)(f) GDPR. The consented mode
rests on consent (Article 6(1)(a)) and needs no balancing test; it appears below
only as the alternative that was weighed and set aside.

| | |
|---|---|
| Assessed | 11 September 2026 |
| Controller | the publisher operating the site that loads the SDK |
| Processor | events-hub |
| Processing | audience measurement: counting visitors and visits, attributing them to a page, a source and a coarse location |
| Personal data | a pseudonymous visitor key; coarse geography (country, region, city); coarse client (browser, OS, device family); page addresses and referrers; campaign parameters; timestamps |
| Not retained | the IP address, the raw User-Agent — derived from, then discarded with the request |
| Identity lifetime | 24 hours (UTC day), with a bounded thirty-minute overlap |
| Retention | 25 months, purged daily at 03:15 UTC |
| Special categories (art. 9) | none collected — with one caveat, in §3.1 |
| Automated decision-making (art. 22) | none |

The full technical description is in [privacy.md](./privacy.md). This note does
not restate it; it tests it.

---

## 1. Purpose test — is there a legitimate interest?

**The interest.** The publisher needs to know how its own site is used: how many
people come, from where, to which pages, which acquisition sources produce
customers rather than traffic, and whether a release broke something. These are
ordinary operational questions, and a site that cannot answer them is run blind.

**Who benefits.** The publisher, directly and commercially. Visitors, indirectly:
a site that can see which pages fail is a site that fixes them. The hub operator
benefits only from running the service, never from the data — no aggregation
across customers, no resale, no product built on top of it.

**Lawful, articulated, real.** The interest is lawful (no processing forbidden
elsewhere), clearly articulated (the questions above, not "improving the
experience" in the abstract), and present rather than speculative — the metrics
are read. Recital 47 expressly contemplates a controller's own interest as capable
of grounding Article 6(1)(f), and audience measurement for one's own account is
the least contested case of it.

**What the interest is not.** Not advertising, not profiling for targeting, not
enrichment with third-party data, not resale, not cross-site observation, not
scoring individuals. None of these is possible in this mode — not as a policy, but
because the key changes every day and carries the project id inside it.

**Conclusion, §1.** The purpose test is met. The interest is real, specific and
lawful, and it is narrower than the technical capability of most tools that serve
it.

---

## 2. Necessity test — is the processing necessary?

**Is the measurement necessary to the purpose?** Yes: the purpose *is* to know.
The only question that matters is whether **this** processing, rather than some
lighter one, is what the purpose requires.

**Is the identifier necessary?** Counting page loads needs no identifier. Counting
*people* does, and so does every question that distinguishes one visitor reading
ten pages from ten visitors reading one — bounce, path, conversion, the value of
an acquisition source. Without an identifier, those questions are not answered
less precisely; they are not answered at all.

### 2.1 Less intrusive alternatives, weighed

| Alternative | Why it was set aside |
|---|---|
| Raw server logs | **Strictly more intrusive**: they retain the full IP for as long as the logs live. They also cannot see client-side navigation, and cannot separate a person from a crawler or a prefetch. More data, worse answers. |
| Storing the IP and deriving later | Keeps identifying data at rest. The entire property being claimed here is that the data does not exist at rest. |
| A stable hash of IP + User-Agent, unrotated | Same inputs, same collection, but a **permanent** identity. More intrusive for exactly the same answers within a day. |
| A first-party persistent cookie | Requires consent, lasts months, and recognises a returning person. That is a different and heavier processing — it is offered, separately, as the consented mode. |
| Aggregate-only counters, no identifier | Cannot answer visitor-level questions at all, and does not reduce what reaches the server: the same IP arrives either way. It trades the purpose away without buying privacy. |
| Sampling | Reduces volume, not intrusiveness: sampled individuals are processed identically. |
| Not measuring | Not an alternative to the purpose. It is abandoning it. |

### 2.2 Why the default mode *is* the minimising design

The three properties that matter are not procedural commitments; they are the
mechanism.

- **The IP and the User-Agent never persist.** They enter one function, produce a
  key plus a handful of coarse labels, and go out of scope with the request.
  Nothing downstream receives them — the server-side ingestion path cannot even be
  handed them, as a matter of type.
- **The key rotates at 00:00 UTC.** The identity has a 24-hour ceiling by
  construction. Following someone across days is not disabled, it is unavailable.
- **The salt includes the project id.** The same person on two sites is two
  unrelated keys. Cross-site correlation is not a feature that was declined; there
  is no value to correlate.

Coarse labels were minimised in the same direction and for the same reason:
version numbers dropped (noise that multiplies uniqueness), latitude and longitude
dropped (not audience data), the full Stripe object not copied.

**Conclusion, §2.** The necessity test is met. Every less intrusive alternative
either answers a different question or retains more data than this design does.
The processing is the minimum that serves the purpose — which is also the strongest
argument this document has.

---

## 3. Balancing test — does the interest override the visitor's rights?

### 3.1 Nature of the data

Pseudonymous, never anonymous — the key is personal data under the *Breyer* line
and the EDPB's consistent position, and this document claims nothing else. No
special categories are collected: no health, no politics, no religion, no sexual
orientation, no financial detail beyond an amount and a currency on a payment
event.

**The caveat, and it is a real one.** Page addresses are stored verbatim. On a
site whose URLs themselves reveal a sensitive interest — a medical service, a
political organisation, a dating product — the page list *is* special-category
data by inference, whatever its column says. A publisher in that position should
not rely on this assessment unchanged; either the URLs are made non-revealing, or
the basis is reconsidered.

### 3.2 Relationship and reasonable expectations

The visitor came to the publisher's site deliberately. Audience measurement is a
universal and widely understood practice, and a visitor who considers the question
expects a site to know how many people read it.

Two limits on that argument, stated rather than glossed:

- **Expectation is not consent**, and a broadly expected practice can still fail
  the balance if its impact is heavy. That is why §3.3 exists.
- Visitors do **not** expect to be recognised tomorrow, or on another site. The
  default mode does neither — the expectation and the mechanism agree, which is
  the most favourable configuration this test can have.

### 3.3 Impact on the visitor

Low, and bounded by the design rather than by promise.

| Vector | Assessment |
|---|---|
| Decisions about the individual | none. No scoring, no targeting, no eligibility, no price. |
| Disclosure to third parties | none. No ad network, no data broker; the SDK loads no other script and calls no host but the hub. |
| Cross-site exposure | structurally impossible in this mode. |
| Persistence | one UTC day. |
| Intrusion felt | nil in practice: no banner, no cookie, nothing visible or stored on the device. |
| Worst case | re-identification by someone who already holds the day's secret **and** a candidate IP + User-Agent to test — i.e. someone with server-configuration access. |

### 3.4 Safeguards in place

| Safeguard | What it prevents |
|---|---|
| Daily key rotation | following a visitor across days |
| Project id in the salt | correlating a visitor across sites or customers |
| IP and User-Agent discarded with the request | any at-rest identifying data |
| Secret held outside the database | a database copy being reversible on its own |
| Geolocation from a local file | the IP reaching a third party |
| Coarse labels only, versions and coordinates dropped | fingerprint-grade precision on the stored row |
| `source` derived from the key class, never from the payload | a page forging events it must not be able to send |
| The two JSON bags never read by the platform | the platform acquiring meanings it was not given |
| A single read path for the events table | a rule that holds in one module and is forgotten by the next |
| Daily purge at 25 months | data outliving the purpose it was collected for |
| No sale, no sharing, no advertising use | secondary use altogether |

### 3.5 Risks and weaknesses, acknowledged

An assessment that finds no risk is not an assessment.

1. **Pseudonymity is not anonymity.** GDPR applies in full. Nothing here is
   presented as out of scope of the Regulation.
2. **The master secret makes past days recomputable.** The daily secret is derived
   from it, so anyone holding it can rebuild any day's keys. A per-day random
   secret destroyed after 48 hours would close this; it is on the roadmap and not
   done. *Current mitigation: the secret is not stored alongside the data.*
3. **IPv4 is brute-forceable.** Four billion candidates is not a barrier to
   someone holding the secret. The guarantee rests on custody of the secret, not
   on the strength of the hash — as it must be said, and as it is said.
4. **A thirty-minute overlap after midnight UTC.** Two keys of the same visitor
   coexist so that a visit is not cut in half. The 24-hour ceiling is crossable on
   that window, by up to thirty minutes, and nowhere else. Accepted and bounded;
   without it, every visitor active at midnight would be counted twice, daily.
5. **Page URLs are stored verbatim.** If the publisher puts personal data in a
   query string, it is retained. The platform cannot filter what it is forbidden
   to read. *This is the controller's duty, and this document is where it is put
   in writing.*
6. **The right to object is not mechanised.** Article 21(1) gives an unconditional
   right to object to 6(1)(f) processing. Today, honouring it requires the
   publisher to stop loading the script for that visitor — a manual path that does
   not scale and that most visitors have no way to trigger. `Sec-GPC` handling and
   an SDK `optOut()` are specified and **not implemented**. *This is the most
   substantive weakness of the current state.*
7. **Retention is enforced, but it can be switched off per instance.** A purge
   runs daily at 03:15 UTC and applies the 25-month limit across the whole
   platform: expired visits are deleted with their events, and events that have no
   visit keep their amounts while losing their durable identity. The period is a
   code constant rather than an environment variable, so it cannot be widened by a
   stray `.env` value — but `RETENTION_ENABLED=false` stops the schedule, and
   Article 5(1)(e) is then satisfied by nothing at all. *The controller has to
   verify this on the instance it actually uses; the design alone does not prove
   it ran.*
8. **ePrivacy residual risk.** EDPB Guidelines 2/2023 on the technical scope of
   Article 5(3), final since October 2024, read "gaining access to information
   stored in the terminal equipment" broadly. Under that reading, an IP address
   emitted by the terminal on a script's instruction may itself constitute access
   to the terminal, and the default mode would need consent despite storing
   nothing on the device. CNIL has not applied that reading in practice, and the
   position taken here — no read, no write, therefore out of Article 5(3) — is
   defensible. It is not risk-free, and it is not presented as settled.

   *If the broad reading prevailed*, the fallback is CNIL's audience-measurement
   exemption (deliberation no. 2020-091), which waives consent for measurement
   carried out strictly for the site's own account, not cross-matched with other
   processing, not used to track across sites, producing aggregate statistics,
   with a limited tracker lifetime and a limited data retention. The default mode
   satisfies the substance of every one of those conditions — own account only, no
   cross-matching, no cross-site tracking, aggregate output, an identity that dies
   in 24 hours, and a 25-month purge — which makes the fallback available rather
   than theoretical. Its one practical condition is that the purge is actually
   enabled on the instance in use (risk 7).

### 3.6 Outcome of the balance

The interest is real and the impact on visitors is among the lowest a measurement
design can achieve: nothing on the device, nothing identifying at rest, an
identity that expires daily, no cross-site reach, and no decision taken about
anyone. Weighed against that, the visitor's rights are engaged but lightly, and
they are not overridden.

The balance holds **on four conditions**:

1. Visitors are informed — the paragraph in [privacy.md](./privacy.md) is
   published and accurate;
2. An objection is honoured when raised, by whatever means currently exists;
3. Retention is bounded in fact — the purge is enabled, and seen to run;
4. The site's own URLs do not reveal special-category data (§3.1).

Condition 3 is met by the implementation and has to be verified per instance.
**Condition 2 is not met today**: no mechanism exists that a visitor can
trigger.

---

## 4. Conclusion

**Legitimate interest under Article 6(1)(f) is a sound basis for the default mode
as designed.** The purpose test is met, the necessity test is met with an unusually
strong argument — the design is already the least intrusive one that answers the
question — and the balancing test comes out in favour of the interest, given
safeguards that are structural rather than promised.

That conclusion is conditional, and one condition is open:

| Gap | Consequence while open | Closes when |
|---|---|---|
| No mechanised objection path | Article 21(1) is honoured only manually, by the publisher | `Sec-GPC` is honoured at ingestion and `optOut()` ships |

Until it closes, a publisher relying on this assessment should publish a
contactable objection route and answer objections by removing the SDK for that
visitor. It should also confirm, rather than assume, that the 25-month purge runs
on the instance it uses — a declared retention period that nothing enforces is a
claim, not a safeguard.

The ePrivacy question in §3.5(8) remains open regardless: a defensible position,
not a zero-risk one. It is stated here rather than in a footnote because a DPO who
discovers it elsewhere is entitled to distrust everything above it.

---

## 5. When to re-run this

- `Sec-GPC` or `optOut()` ships — condition 2 closes, rewrite §3.5(6) and §4.
- The retention period or its schedule changes, or an instance disables the
  purge.
- Per-day random secrets replace the derived daily secret — §3.5(2) closes.
- A new event source that is neither browser nor payment starts feeding the hub.
- CNIL or EDPB publishes a position on IP-based measurement, or a national
  authority applies Guidelines 2/2023 to a case like this one.
- Any new column is derived by the server, or any read starts crossing projects.
