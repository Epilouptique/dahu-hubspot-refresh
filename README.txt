=== Dahu HubSpot Refresh ===
Contributors: Hugo Vial-Jaime
Tags: hubspot, crm, ui-extensions, refresh, workflow
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Automatic record refresh for HubSpot CRM, driven by a buffer property.

== Description ==

HubSpot never refreshes an already-open record when an external source changes
it. When a workflow, an integration or a plain API call updates a ticket's
status or pipeline stage, the user staring at that record keeps seeing the old
value until they manually reload the page.

Dahu HubSpot Refresh solves this with a small, self-contained UI extension
card. A buffer property on the record is touched every time something changes
it; the card polls that single property and calls refreshObjectProperties() as
soon as its value differs from the previous one. Displayed properties update in
place, with no page reload and no user action.

The card is deliberately content-free: it renders one discreet line of text and
never displays business data. Its only job is to keep the record in sync.

Why polling and not the native event: the SDK exposes onCrmPropertiesUpdate,
which looks like the natural fit. It is not. HubSpot only emits that event for
changes made from the HubSpot UI itself; changes written through the API,
including workflow actions, emit nothing at all. This is documented behaviour,
not a defect. Polling a buffer property is therefore the only reliable approach
when changes originate from automation rather than manual input.

== Features ==

* Refreshes an open CRM record in place, without reloading the page
* Detects changes made by workflows, integrations and external API writes
* Event-source agnostic: anything able to write one property can trigger it
* Configurable poll interval through a single constant
* Silent by default, with a DEBUG flag that re-enables full lifecycle logging
* Resilient polling: a failed request is logged and the next tick retries
* Clean unmount: the interval is cleared and in-flight requests are neutralised
* No external dependency beyond the HubSpot UI Extensions SDK

== Installation ==

Requires the HubSpot CLI and access to a HubSpot account with developer
projects enabled.

1. Clone this repository.
2. Authenticate the CLI against the target account: `hs init`
3. From the project directory (the one holding hsproject.json), upload it:
   `cd annad` then `hs project upload`
4. Install the app on the account: `hs project install-app`, then check with
   `hs project app-install-status`

== Configuration ==

1. Create the buffer property. On the target object (tickets by default),
create a property named dahu_refresh_signal of type datetime. Datetime is
recommended because HubSpot workflows can natively write an always-new value
into it without custom code.

2. Write to it on every change. In each workflow that changes the record's
status or pipeline stage, add an action writing the current timestamp into
dahu_refresh_signal. The value itself is irrelevant; only the fact that it
changed is used. This step must be repeated at every branch of every workflow
that mutates the record. A branch that changes a status without touching the
buffer property will not trigger a refresh.

3. Place the card. The card is declared in src/app/cards/card-hsmeta.json with
location crm.record.sidebar, so it stays mounted regardless of which tab the
user is viewing. After uploading, add it to the record sidebar through
Settings > Objects > Tickets > Customize record preview.

4. Tune the card if needed, in src/app/cards/SyncCard.tsx:

* SIGNAL_PROPERTY (default dahu_refresh_signal) - internal name of the buffer
  property
* POLL_INTERVAL_MS (default 5000) - poll period, in milliseconds
* DEBUG (default false) - enables [dahu-sync] lifecycle logging

To target another object type, change objectTypes in card-hsmeta.json and
adjust the scopes in src/app/app-hsmeta.json accordingly.

== Changelog ==

= 1.0.0 =
* Initial release
* Sidebar UI extension card polling a buffer property on the record
* Automatic refreshObjectProperties() call on detected change
* Configurable poll interval and property name
* DEBUG flag for silent-by-default lifecycle logging

== License ==

GPL v2 or later. See the LICENSE file for details.
