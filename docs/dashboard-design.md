# Dashboard screens and navigation

## Reference

Browserbase keeps the selected project and its five main destinations in a persistent rail: Overview, Sessions, Agents, Functions and Playground. Overview puts recent sessions above analytics. Each row shows status, a shortened ID and timing. Its bordered metric strip keeps the date range and refresh control near the numbers. [Browserbase overview](https://mobbin.com/screens/5999d971-3c12-4486-9f23-8ff1098139bc)

The Agents page keeps the same rail and header while the recent runs section moves from an empty state to a filterable table. It places the create action at the top right and the account control at the bottom left. [Empty runs](https://mobbin.com/screens/2e1ae846-ad05-4912-a921-162ddf87ae22) and [populated runs](https://mobbin.com/screens/91fff3d4-82a6-4d59-95bd-0da39f7d3d51)

The supplied release link requires a Mobbin login in the shared browser. The connector supplied individual Browserbase screens. Their membership in that specific release and the full release screen count are unverified. [Requested release](https://mobbin.com/apps/browserbase-web-1605b46c-b3e7-46e3-a6bb-eb0a74433f48/d24cfac2-0619-4e87-a964-946cf423d3cb/screens)

## Canaveral screen map

| Entry | Destination | Next steps |
| --- | --- | --- |
| Signed out | Sign in | Enter the machine workspace. An invitation or recovery link opens the password claim form. |
| Workspace | Overview (`#admin`, administrators) | Inspect machines needing attention, review fleet and access counts, or open an operational destination. |
| Workspace | Machines (`#machines`) | Filter the fleet, create a machine, inspect details, start or control an eligible machine. Capture and power-off actions open against the selected machine. |
| Workspace | Screens (`#screens`) | Choose up to four running, account-owned mobile devices and watch them live side by side. Open a device's control from its tile. `#screens/<uuid>+<uuid>` names the devices on the wall. |
| Machine control | Selected machine | Use the available display, input, accessibility, file and terminal tools. A headless machine can expose files and terminals without a display connection. |
| Machine sources | Image library (`#images`) | Search downloaded artifacts, inspect provenance and open a blueprint from a source. Administrators can open the registry, import images and inspect image activity. |
| Machine sources | Machine blueprints (`#blueprints`) | Inspect immutable revisions and create a machine from an eligible offer. Administrators can create blueprints and revisions. |
| Infrastructure, administrators | Hosts (`#hosts`) and Orchestrators (`#orchestrators`) | Connect a runner or open a named resource at `#hosts/<id>` or `#orchestrators/<id>`. Inspect resource reports, limits and inventory, then return to the parent list. |
| Infrastructure, administrators | System (`#system`) | Inspect applications, leases, waiting requests, jobs, operations and access sessions. Leases show their holder's label and the time remaining. |
| Infrastructure, administrators | Queue (`#queue`) | Read the waiting requests in attempt order with position and the reason each waits, and the leases that hold capacity. Cancel a named request, or open the events of a request, lease or application. |
| Infrastructure, administrators | Activity (`#activity`) | Follow the event log live, filter by family, kind, attention, application, host or lease, and load older events. `#activity/<subject>/<uuid>` opens it on one application, lease, request, host or machine. |
| Infrastructure, administrators | Usage (`#usage`) | Choose a range and a grouping, read requests by outcome, waits, leases, held device time and failures, and download the CSV. |
| Administration | Users (`#admin/users`) | Search accounts, invite a user, initiate recovery or confirm a role or status change. |
| Administration | API access (`#admin/tokens`) | Inspect token ownership, permissions and expiry. Confirm revocation for a named token. |
| Administration | Configuration (`#configuration`) | Select a named administrative API action and review its fields and result. |
| Account menu | Account (`#account`), API tokens (`#tokens`), sign out | Change the signed-in user's password or manage their personal tokens. |

The image library also accepts `#templates`, user administration accepts `#users`, and infrastructure details accept the older `/<id>/resources` suffix. See the [dashboard contract](dashboard.md) for access checks and recovery behavior.

## Design principles

- Give the operator a stable location. Keep resource families in the rail, account actions at its foot and the current destination in the sticky header. On small screens the rail becomes a drawer. Changing destinations scrolls to the top and moves keyboard focus to the workspace.
- Use warm paper for the work area and graphite for navigation. Reserve burnt orange for emphasis and use monospace for identifiers and measurements. Keep the launch photograph on the account entry screens.
- Give each machine an action appropriate to its state. Keep its name and status visible while the operator inspects details. On narrow screens, pair each value with its label.
- Keep fleet health compact so search, filters and the first machine are visible together on a narrow phone. Use a full-width search input and a native state picker on phones. Keep host reservations expandable and label fleet counts as applying before filters.
- Lead Overview with up to four actionable exceptions. When machines and connections both need attention, include at least one of each in the preview. Put fleet and host health before account administration, with one refresh action for the whole overview.
- Show where a number came from. Keep reservations distinct from measured consumption, label stale snapshots and surface missing measurements where a value would appear.
- Bind consequential actions to their subject. Name the affected machine, account or token in confirmations. A failed read offers a refresh. An uncertain operation offers status recovery using the original request identity.
- Say what a number is where it is shown. A queue position is an order of attempts, not a promise. Device time is held lease time, not measured utilisation. A percentile names its sample count, and no sample reads as "No samples", not zero. Count time against the controller's clock when it sent one.
- Keep long identifiers on a line of their own below the short figures, so a UUID is not broken across a narrow column. On phones, fold filters that are rarely used so the first row of content stays near the top.
