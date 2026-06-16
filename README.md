# Voice Order

A Korean voice-ordering prototype for café menus, designed for blind, low-vision, and elderly customers who are blocked by touch-only kiosks.

The system maps spoken Korean orders to a structured café menu, asks follow-up questions when required options are missing, and produces a confirmed order before handoff. No external LLM calls run on the user-facing path.

The most important part of the project was not the voice interface. User testing showed that blind users often already rely on screen readers and existing app flows, so I reframed the product from a standalone voice tool into an embeddable flow for café-chain apps.

## What this demonstrates

- User discovery changed the product direction: voice became one option inside an existing app flow, not the whole product.
- The runtime path is constrained: no generated menu items, no silent assumptions, and no order completion without confirmation.
- Evaluation drove the build: 7,620 simulated orders per run across ~150 scenarios surfaced multi-turn state-management failures.
- The deployment path changed: the product was reframed as an embeddable SDK for café-chain apps rather than a standalone accessibility app.

## The problem

A touchscreen kiosk is unusable without sight. The design problem is not “add a microphone.” It is mapping free-form, disfluent Korean speech onto a structured, confirmed order in a setting where a wrong order and a hallucinated confirmation are both unacceptable. The whole system is built around one question: how do we know the output is correct?

## Designed with the users

Earlier versions were tested informally with a blind user, with elderly users, and through discovery with a visual-impairment organization — and that feedback changed the design more than any algorithm did. I had built it voice-only, assuming that served blind users; in fact they navigate their phones through a screen reader (VoiceOver), so I rebuilt the flow to work alongside it rather than replace it, and added a haptic cue so the user knows when the system is listening. This was informal, small-N feedback, so I treat it as product discovery rather than proof of efficacy.

## Domain model / Ontology

Speech resolves onto an explicit domain model rather than free text. The objects are MenuItem, Option (temperature, size, shots, milk), CartLineItem, Cart, Order, and Tenant (the franchise). They link the obvious way: a Cart holds line items, each line item points to a MenuItem plus its Options, an Order wraps a Cart, and every Tenant owns its own isolated Menu. A resolution layer of Korean café lexicons and a menu schema maps aliases, abbreviations, and misspeaks onto those canonical objects. One invariant matters most: a franchise's confidential menu can never surface in another tenant's context, and that is enforced by a property-based test, not by convention.

This typed layer is what makes every downstream step checkable.

## Data

The domain data is hand-built Korean café lexicons (intent, menu aliases, quantity, size, temperature, options, service type, corrections) plus a structured menu dataset. Input is on-device STT text; no audio leaves the device. The evaluation data is a synthetic order corpus: scenarios crossed with 12+ adversarial speaker personas crossed with mutation operators (dropped particles, omitted temperature, casual speech, simulated STT noise), each case carrying a ground-truth target. Its noise model is grounded in derived statistics only from a licensed 628K-utterance speech corpus, so no raw third-party text is ingested (see Acknowledgement).

## Logic

Normalization cascade, then fuzzy menu matching, then slot extraction, then a state machine that asks instead of assuming when a slot is missing. Same input, same output, every time. Rules stay primary by evidence, not by preference. sklearn slot classifiers and a fine-tuned KoELECTRA model were trained and benchmarked, but deterministic rules won on the metrics that mattered. On quantity extraction the rule baseline beat the ML classifier 100% to 85% on a 793-case subset, so ML was set aside and the real cause re-diagnosed as conversation-state handling.

## Action

State-changing actions are explicit and guarded. Cart mutations and a mandatory pre-payment voice confirmation (`pre_payment_review` / `high_value_confirm`) are read back and human-confirmed, never auto-fired. An `order_complete` event hands off to the franchise's own payment and loyalty systems; payment, receipts, and points stay out of scope on purpose, which protects both the integration and the partner relationship. Payment, cancellation, and a staff call never run without confirmation.

## How I know it works

The part worth showing is the layer that measures the app. An oracle scores about 7,620 simulated orders per run across roughly 150 scenarios, graded per slot (intent, quantity, size, temperature, options) into a root-cause failure taxonomy. Variance is measured across random seeds, so single-seed numbers are never quoted, and a held-out scenario split guards against overfitting the fixes to the test set. A machine-checked release gate blocks regressions, with a pass-rate floor and zero tolerance for silent staff-escalation. Twice, this data overturned my own assumptions about what was broken, which is the reason to build it.

## Honest limitations

Pre-deployment and solo-built. Every number here comes from synthetic stress tests. Real users shaped the design through informal testing, but the system has not run a real-store pilot or a controlled test of the final build with blind users yet, and the persona and scenario frequencies are hypotheses to be re-weighted against real usage.

## Code access and license

Proprietary, All Rights Reserved (see `LICENSE`). No usage rights are granted. Representative non-core code (the automation pipeline and property-based tests) is in [`code-samples/`](code-samples/). The domain lexicons, state-machine transitions, and model weights are withheld. Commercial or organizational use requires separate written permission.

## Data acknowledgement

The simulator uses derived statistical distributions only (filler rate, truncation rate, café-domain match frequency) from KsponSpeech (AI Hub, 628,545 utterances), with zero source utterances included. 모두의말뭉치 (NIKL) was evaluated and not used, because its terms restrict commercial use.

## Contact

Code walkthroughs, demo requests, and interview scheduling: shawnkim1022@gmail.com
