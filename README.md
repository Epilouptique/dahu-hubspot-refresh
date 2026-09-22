# Dahu HubSpot Refresh

Automatic record refresh for HubSpot CRM, driven by a buffer property.

## Description

HubSpot never refreshes an already-open record when an external source changes
it. When a workflow, an integration or a plain API call updates a ticket's
status or pipeline stage, the user staring at that record keeps seeing the old
value until they manually reload the page.

Dahu HubSpot Refresh solves this with a small, self-contained UI extension
card. A buffer property on the record is touched every time something changes
it; the card polls that single property and reacts as soon as its value differs
from the previous one.

Two things then happen. `refreshObjectProperties()` is called, which updates in
place everything that falls within its reach. Because that reach turns out to
be narrower than the record itself, the card also surfaces a **Refresh** button,
shown only while a change is pending. One click reloads the record and
guarantees a correct view.

The card never displays business data: while nothing has changed, it renders a
single discreet line of text. Its only job is to keep the record in sync.

### Why the button is not automatic

Reloading the page on its own would be simpler, and wrong. A user may be
halfway through typing a note in another panel of the same record, and a reload
triggered behind their back would discard it. The card therefore detects
automatically, and reloads only on request.

### A known limitation

`refreshObjectProperties()` does not reach every part of a record. In testing,
a sidebar section kept displaying a stale enumeration property across four
consecutive refresh cycles, while the stored value was correct — a fresh
navigation to the same record showed it immediately. The action is still worth
calling, since it costs nothing and does update what it covers, but it cannot
be relied on alone. This is the entire reason the manual button exists.

### Why polling and not the native event

The SDK exposes `onCrmPropertiesUpdate`, which looks like the natural fit. It
is not: HubSpot only emits that event for changes made from the HubSpot UI
itself. Changes written through the API — including workflow actions — emit
nothing at all. This is documented behaviour, not a defect. Polling a buffer
property is therefore the only reliable approach when changes originate from
automation rather than manual input.

## Features

- Refreshes an open CRM record in place, without reloading the page
- Falls back to a one-click Refresh button, shown only when a change is pending
- Never reloads on its own, so in-progress input elsewhere on the record is safe
- Detects changes made by workflows, integrations and external API writes
- Event-source agnostic: anything able to write one property can trigger it
- Degrades gracefully if the SDK exposes no reload action, alerting instead
- Configurable poll interval through a single constant
- Silent by default, with a `DEBUG` flag that re-enables full lifecycle logging
- Resilient polling: a failed request is logged and the next tick retries
- Clean unmount: the interval is cleared and in-flight requests are neutralised
- No external dependency beyond the HubSpot UI Extensions SDK

## Installation

Requires the HubSpot CLI and access to a HubSpot account with developer
projects enabled.

1. Clone this repository.
2. Authenticate the CLI against the target account:
   ```bash
   hs init
   ```
3. From the project directory (the one holding `hsproject.json`), upload it:
   ```bash
   cd annad
   hs project upload
   ```
4. Install the app on the account:
   ```bash
   hs project install-app
   hs project app-install-status
   ```

## Configuration

**1. Create the buffer property.** On the target object (tickets by default),
create a property named `dahu_refresh_signal` of type *datetime*. Datetime is
recommended because HubSpot workflows can natively write an always-new value
into it without custom code.

**2. Write to it on every change.** In each workflow that changes the record's
status or pipeline stage, add an action writing the current timestamp into
`dahu_refresh_signal`. The value itself is irrelevant — only the fact that it
changed is used.

This step must be repeated at every branch of every workflow that mutates the
record. A branch that changes a status without touching the buffer property
will not trigger a refresh.

**3. Place the card.** The card is declared in `src/app/cards/card-hsmeta.json`
with location `crm.record.sidebar`, so it stays mounted regardless of which tab
the user is viewing. After uploading, add it to the record sidebar through
*Settings → Objects → Tickets → Customize record preview*.

**4. Tune the card if needed.** In `src/app/cards/SyncCard.tsx`:

| Constant | Default | Purpose |
|---|---|---|
| `SIGNAL_PROPERTY` | `dahu_refresh_signal` | Internal name of the buffer property |
| `POLL_INTERVAL_MS` | `2000` | Poll period, in milliseconds |
| `DEBUG` | `false` | Enables `[dahu-sync]` lifecycle logging |

To target another object type, change `objectTypes` in `card-hsmeta.json` and
adjust the scopes in `src/app/app-hsmeta.json` accordingly.

## Changelog

### 1.1.0
- Manual **Refresh** button, shown only while a detected change is pending
- `refreshObjectProperties()` alone proved insufficient: it leaves parts of the
  record stale even when called repeatedly with the tab in the foreground
- Reload is never automatic, to protect in-progress input elsewhere on the record
- Defensive fallback to an alert when the SDK exposes no reload action
- Poll period lowered from 5000 ms to 2000 ms so the button appears promptly
- Removed the timer-throttling workarounds (deferred second call, tick-drift
  instrumentation): the theory behind them was disproved by testing

### 1.0.0
- Initial release
- Sidebar UI extension card polling a buffer property on the record
- Automatic `refreshObjectProperties()` call on detected change
- Configurable poll interval and property name
- `DEBUG` flag for silent-by-default lifecycle logging

## License

GPL v2 or later. See the LICENSE file for details.
