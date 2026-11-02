# Phone calls in the browser

Status: **preview**. The seam, the queue integration, the console call panel,
the caller page's "Call us" button and a **mock** provider are built and
tested. No real telephony provider is connected: no accounts, no phone
numbers, no real calls, no cost.

## What it does

Two kinds of call share one queue, the same queue that chats use:

- **An inbound phone call answered in the browser.** Someone dials the
  lifeline's number, it rings in the console, and a worker answers with a
  headset. No Webex and no desk phone are needed.
- **"Call us" from the web.** A button on the caller page starts a voice
  call from the browser, for people who can't or won't dial: no credit,
  abroad, or on a laptop.

Either way the call becomes a `contact` with `channel = 'voice'`.
- **Same queue rules as chat:** program-scoped queue, backup paging after
  `backup_page_after_secs`, atomic claim. Only one worker can answer.
- **Answering** opens the phone intake beside the call (the "screen-pop").
  The worker has mute, hold, hang up and a call timer.
- **A live call occupies the worker**, so they can't take a chat as well.
- **Supervisors can listen in** silently, as with chat observation. It is audited.

## Switching it on

Voice is **opt-in and never in the default module set**, so an
install like TELL's never gains voice by accident.

1. Add `voice` to `TL_MODULES` (it needs `helpline`), or tick it in the
   setup wizard.
2. The profile needs `features.voice: true` for the console call panel and
   the caller-page button to be on the pages. `generic` has it on;
   `tell` has it off.
3. The helpline's phone and emergency numbers must be set (the helpline
   fail-closed rule). Without them, calls are refused with a spoken message
   and are never queued.

### Settings for the preview

| Variable | Purpose |
|---|---|
| `TL_VOICE_WEBHOOK_SECRET` | The key that provider webhooks are signed with. **Required.** There is no default, and without it every webhook is refused. |
| `TL_VOICE_DEMO=1` | Lets the mock take "calls" from the queue and the caller page, for demos and training with pretend callers only. Without it the mock refuses every caller, so a real person can never reach a test line that carries no audio. Staff "Demo call" and the wizard's test call always work. |
| `TL_VOICE_PROVIDER` | Which provider to use (default `mock`). An unknown name stops the server at boot. |

**On a serverless host** (Vercel), the queue moves forward (paging backups, overflowing unanswered calls) whenever traffic arrives. That traffic includes call webhooks, the web caller's page and open consoles. Still, set up the `/api/cron/sweep` pinger (DEPLOY.md) so a call that arrives with nobody online still overflows on time. With a real provider, also set the provider's own maximum queue wait to send the call to the overflow number or message. That way the overflow never depends on the app alone.

## Architecture

```
caller ──PSTN or browser──▶ provider ──signed webhook──▶ /api/voice/webhook/:provider
                                                          │
                                         src/voice/index.js (the seam)
                                     inbound → contact(channel 'voice') → queue
                                                          │
console voicepanel.js ◀── /api/voice/state (poll 2s) ─────┘
   Answer → /api/voice/answer → queue.claim + provider.answer → phone intake
```

`src/voice/index.js` speaks to one interface. Every provider implements it:

| Method | Purpose |
|---|---|
| `issueClientToken(identity)` | Token the provider's browser SDK uses to register a worker's (or web caller's) browser |
| `verifyWebhook(headers, rawBody)` | Reject anything not signed by the provider |
| `parseWebhook(body)` | → `{type: 'inbound' \| 'hangup', callId, from}` |
| `answer(callId, {workerId, recording})` | Bridge the call to the worker's browser |
| `hangup`, `hold`, `transfer(callId, number)` | Call control |
| `playMessage(callId, text)` | Speak a message, then hang up |
| `monitor(callId, {supervisorId})` | Silent listen-in |
| `selfTest(message)` | The setup wizard's test call |

`src/voice/mock.js` is the reference implementation. Calls live in memory
and every action is logged to the call, with no network. Use it for tests,
local demos ("Demo call" for supervisors) and the wizard's test call.

## Fail-safe routing (never silence)

- **Nobody answers within the safety-valve window**
  (`safety_valve_after_secs`): the sweep ends the contact as `timed_out` and
  hands the call to the provider:
  - to the **overflow number**, if one is set (Admin, via
    `PUT /api/voice/settings`, or the wizard);
  - otherwise the caller **hears the safety-valve message** (with the
    emergency numbers) before the call ends.
- **The app itself is down:** this has to be configured at the provider,
  because the app can't answer. Every provider below supports a fallback for
  when the webhook fails or times out. Point it at a static message with the
  emergency numbers, or at the overflow number. Set this up before taking a
  single real call.
- **No numbers configured:** calls are refused with a spoken message and are
  never queued.

## Privacy defaults

- **No recording.** It is off by default. Turning it on is a coordinator
  setting and is audited (`voice_settings`). Some lifelines are required to
  record and others are forbidden to: it is an organisation decision.
- **The caller's number is never stored.** `caller.token` keeps an HMAC of it,
  keyed from `TL_ENCRYPTION_KEY`, so a repeat caller is recognised (for
  directives and history). Workers see only the last two digits.
- **Logs carry contact ids and outcomes only.** No audio and no numbers.
- A web call's browser follows its own call with a secret per-call token.

## Going live (for Joel)

1. Choose a provider (below) and who pays per-minute costs: the platform or
   each lifeline.
2. Buy or port a number. **Japan's rules for buying numbers are strict:
   proof of address and business registration.** Check this before promising
   TELL anything.
3. Write `src/voice/<provider>.js` implementing the interface:
   - webhook signature checking per the provider's scheme;
   - the browser SDK token;
   - call control through their REST API.

   Register it in `PROVIDERS`.
4. Put the provider's credentials in the environment only, never in the
   database.
5. Configure the provider's **fallback** (see above).
6. Load the provider's browser SDK on the console and caller pages (pin a
   version). Media flows browser ↔ provider; the app only controls the call.
7. Test with a real call end to end, including the timeout path and the
   fallback with the app stopped.

## Provider shortlist (not chosen)

| | Strengths | Watch out for |
|---|---|---|
| **Twilio Voice** (Voice JS SDK) | Mature; phone numbers in many countries; the option docs 02/04 already name; good fallback-URL support | Per-minute plus per-number costs; Japan numbers need paperwork |
| **LiveKit + a SIP trunk** | Open-source media server, self-hostable, potentially cheaper at scale | Real phone numbers need a separate SIP trunk; more to operate |
| **Vonage / Telnyx** | Alternatives worth costing; Telnyx owns its network | Same number-regulation questions |

## Cost model per 1,000 call-minutes, **to verify against current pricing**

Indicative structure only. Every figure must be checked on the provider's
pricing page before any decision; prices vary by country and change.

```
cost ≈ minutes × (inbound PSTN rate for the country
                  + browser-client leg rate)
       + numbers × monthly number rental
       + (recording minutes × recording rate, if recording is on)
       + (overflow transfers × outbound rate to the overflow number)
```

- **Worked example (illustrative):** 1,000 minutes × (a few tenths of a cent
  up to a couple of cents per minute per leg, depending on country) plus one
  number at a few dollars a month. The result is roughly **tens of dollars per
  1,000 minutes**.
- **Japanese numbers sit at the higher end.** Verify before quoting.

## Known gaps (preview)

- There is no real audio. Mute is shown in the panel only; with a real
  provider it maps to the SDK's mute.
- After a reload, the panel doesn't remember that a call was on hold.
- Repeat callers are recognised by digits only. A number given in national
  form (090…) and in international form (+81 90…) counts as two callers.
- The rate limits use the client address the host passes on. Behind a proxy
  that doesn't overwrite `X-Forwarded-For` (Vercel does), they can be dodged.
  This is the same as for chat.
- The call panel polls every 2 seconds; a real provider's SDK would push the
  ring to the browser instantly.
- Transfer to another worker isn't in the console yet. The method exists on
  the interface.
